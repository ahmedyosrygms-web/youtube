'use strict';
/**
 * scripts/test-unit.js — اختبار وحدات محرك الدمج والتخزين (يدوي، CommonJS):
 *  1) توليد فيديوهين مختلفي الدقة بـ ffmpeg (أحدهما بلا صوت لاختبار anullsrc).
 *  2) فحص المصادر بـ ffprobe.
 *  3) مسار رفع الأجزاء (صفوف source_chunks) + تجميع بتطابق sha256.
 *  4) محرك الدمج: الدقة = أكبر دقة مدخل، المدة ≈ المجموع، وجود صوت.
 *  5) تخزين Turso واسترجاع بتطابق sha256 (صفوف 2MB).
 *  6) حدود الحجم: عدد المصادر، حجم المصدر، حجم جزء الرفع.
 *  7) الحذف الشامل + التنظيف التلقائي للمهام المنتهية.
 *
 * التشغيل: node scripts/test-unit.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Readable } = require('stream');

process.chdir(path.join(__dirname, '..'));

const db = require('../lib/db');
const storage = require('../lib/storage');
const merge = require('../lib/merge');
const { parseSourcesInput, buildCreateResponse } = require('../lib/jobs');
const { cleanupExpiredJobs } = require('../lib/cleanup');
const { CONFIG } = require('../lib/env');
const uploadHandler = require('../api/upload');

const MB = 1024 * 1024;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-test-'));
const createdJobs = [];

let passed = 0; let failed = 0; const failures = [];

async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    failed += 1;
    failures.push({ name, err: e });
    console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'قيمة غير متوقعة'} — المتوقع: ${expected}، الفعلي: ${actual}`);
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function genId() { return 'unit' + crypto.randomBytes(10).toString('hex'); }

/** توليد فيديو تجريبي بـ ffmpeg */
async function genVideo(outPath, size, seconds, withAudio, freq) {
  const ffmpeg = merge.getFfmpeg();
  const args = ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25`];
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`);
  args.push('-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '1500k', '-pix_fmt', 'yuv420p');
  if (withAudio) args.push('-c:a', 'aac', '-b:a', '96k');
  args.push(outPath);
  await new Promise((resolve, reject) => {
    const c = require('child_process').spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg: ' + err.slice(-400))));
  });
  const sizeBytes = fs.statSync(outPath).size;
  assert(sizeBytes > 10 * 1024, `الفيديو المولد صغير جدًا: ${outPath} (${sizeBytes} بايت)`);
  return sizeBytes;
}

/** مرادف بسيط لطلب/استجابة HTTP لتشغيل دوال Vercel مباشرة */
function mockReq({ method = 'POST', url = '/', headers = {}, body = null }) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = url;
  req.headers = headers;
  const u = new URL(url, 'http://localhost');
  req.query = Object.fromEntries(u.searchParams);
  if (body) req.push(body);
  req.push(null);
  return req;
}
function mockRes() {
  const res = { statusCode: 200, headers: {}, chunks: [], ended: false };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.writeHead = (code, h) => { res.statusCode = code; Object.assign(res.headers, h || {}); };
  res.write = (d) => { res.chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))); return true; };
  res.end = (d) => { if (d) res.write(d); res.ended = true; };
  res.on = () => {};
  res.once = () => {};
  res.emit = () => {};
  res.json = () => JSON.parse(Buffer.concat(res.chunks).toString('utf8'));
  return res;
}

/** تخزين ملف كأجزاء رفع (بمقاس أصغر لاختبار الأجزاء المتعددة) */
async function storeAsChunks(jobId, seq, filePath, chunkSize) {
  const buf = fs.readFileSync(filePath);
  const chunks = Math.ceil(buf.length / chunkSize);
  for (let k = 0; k < chunks; k++) {
    await db.upsertSourceChunk(jobId, seq, k, buf.subarray(k * chunkSize, Math.min((k + 1) * chunkSize, buf.length)));
  }
  await db.updateSourceProgress(jobId, seq, buf.length);
  return { size: buf.length, chunks };
}

function makeBuffer(bytes, seed) {
  const buf = Buffer.alloc(bytes);
  let x = (seed || 1) >>> 0;
  for (let i = 0; i < bytes; i += 1024) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    buf.writeUInt32LE(x, Math.min(i, bytes - 4));
  }
  return buf;
}

async function tableCount(table, jobId) {
  const c = db.getClient();
  // جدول jobs مفتاحه id بينما بقية الجداول job_id
  const col = table === 'jobs' ? 'id' : 'job_id';
  const rs = await c.execute({ sql: `SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`, args: [jobId] });
  return Number(rs.rows[0].c);
}

/* ============================== الاختبارات ============================== */

(async () => {
  console.log('\n═══════════ اختبار وحدات «دمج الفيديوهات» ═══════════\n');

  let fileA = null; let fileB = null;
  let sizeA = 0; let sizeB = 0;

  await test('1) توليد فيديوهين مختلفي الدقة بـ ffmpeg (320x240 بلا صوت، 640x360 بصوت)', async () => {
    fileA = path.join(TMP, 'unit-a.mp4');
    fileB = path.join(TMP, 'unit-b.mp4');
    sizeA = await genVideo(fileA, '320x240', 6, false, 440);
    sizeB = await genVideo(fileB, '640x360', 5, true, 550);
    assert(sizeA > 0 && sizeB > 0, 'أحد الملفين فارغ');
    console.log(`     → A: 320x240/6s/${fmt(sizeA)} بلا صوت | B: 640x360/5s/${fmt(sizeB)} بصوت`);
  });

  await test('2) ffprobe: الدقة والمدة ووجود/غياب الصوت', async () => {
    const pA = await merge.probeMedia(fileA);
    const pB = await merge.probeMedia(fileB);
    assertEq(pA.width, 320, 'عرض A'); assertEq(pA.height, 240, 'ارتفاع A');
    assertEq(pB.width, 640, 'عرض B'); assertEq(pB.height, 360, 'ارتفاع B');
    assert(!pA.hasAudio, 'يجب أن يكون A بلا صوت');
    assert(pB.hasAudio, 'يجب أن يكون B بصوت');
    assert(Math.abs(pA.duration - 6) < 1.2, `مدة A غير متوقعة: ${pA.duration}`);
    assert(Math.abs(pB.duration - 5) < 1.2, `مدة B غير متوقعة: ${pB.duration}`);
  });

  let engineJobId = null;
  const totalDur = 11; // 6 + 5

  await test('3) مسار رفع الأجزاء: تخزين أجزاء متعددة (1MB) + تجميع بتطابق sha256', async () => {
    engineJobId = genId();
    createdJobs.push(engineJobId);
    await db.createJob(engineJobId, [
      { kind: 'file', name: 'unit-a.mp4', mime: 'video/mp4', size: sizeA, totalChunks: Math.ceil(sizeA / MB) },
      { kind: 'file', name: 'unit-b.mp4', mime: 'video/mp4', size: sizeB, totalChunks: Math.ceil(sizeB / MB) },
    ]);
    const sA = await storeAsChunks(engineJobId, 0, fileA, MB);
    const sB = await storeAsChunks(engineJobId, 1, fileB, MB);
    assert(sA.chunks >= 2 && sB.chunks >= 2, 'توقع أجزاء متعددة لكل ملف');
    const { count: cA } = await db.countSourceChunks(engineJobId, 0);
    const { count: cB } = await db.countSourceChunks(engineJobId, 1);
    assertEq(cA, sA.chunks, 'عدد أجزاء A'); assertEq(cB, sB.chunks, 'عدد أجزاء B');

    // تجميع ومطابقة sha256
    const asmA = path.join(TMP, 'asm-a.mp4');
    await storage.assembleSourceChunksToFile(engineJobId, 0, asmA, sizeA);
    assertEq(sha256(fs.readFileSync(asmA)), sha256(fs.readFileSync(fileA)), 'sha256 للمصدر A المجمّع');

    // اكتمال الرفع
    assert(await db.allSourcesUploaded(engineJobId), 'allSourcesUploaded يجب أن يكون صحيحًا');
    await db.setJobStatus(engineJobId, 'queued');
  });

  await test('4) محرك الدمج: الدقة = أكبر دقة مدخل (640x360) والمدة ≈ المجموع (11s)', async () => {
    const result = await merge.runMergeJob(engineJobId);
    assertEq(result.resolution, '640x360', 'دقة الناتج');
    assert(Math.abs(result.duration - totalDur) < 1.5, `المدة النهائية ${result.duration} بعيدة عن ${totalDur}`);
    assert(result.size > 0, 'حجم الناتج صفر');

    const job = await db.getJob(engineJobId);
    assertEq(String(job.status), 'done', 'حالة المهمة');
    assertEq(Number(job.progress), 100, 'التقدم النهائي');
    assertEq(String(job.output_resolution), '640x360', 'دقة الناتج في القاعدة');
    assert(Number(job.output_size) === result.size, 'حجم الناتج في القاعدة');
  });

  await test('5) الناتج من Turso: وجود صوت + تطابق sha256 عند الاسترجاع (صفوف 2MB)', async () => {
    // استرجاع الناتج صفحةً صفحة (8 صفوف) والتحقق
    const { count: outRows, bytes: outBytes } = await db.countOutputChunks(engineJobId);
    assert(outRows >= 1, 'لا صفوف للناتج');
    const outBuf = await readOutput(engineJobId, outRows);
    assertEq(outBuf.length, outBytes, 'طول الناتج المجمّع');

    const assembledPath = path.join(TMP, 'assembled-out.mp4');
    fs.writeFileSync(assembledPath, outBuf);
    const p = await merge.probeMedia(assembledPath);
    assert(p.hasAudio, 'الناتج المدمج يجب أن يحتوي مسار صوت');
    assertEq(p.width, 640, 'عرض الناتج'); assertEq(p.height, 360, 'ارتفاع الناتج');

    // تخزين/استرجاع مباشر بمخزن 5MB (3 صفوف × 2MB) وتطابق sha256
    const buf5 = makeBuffer(5 * MB, 42);
    const storageJob = genId();
    createdJobs.push(storageJob);
    await db.createJob(storageJob, []);
    await db.setJobStatus(storageJob, 'processing', { progress: 90 });
    await db.putOutputBlob(storageJob, buf5);
    const readBack = await readOutput(storageJob, Math.ceil((5 * MB) / CONFIG.BLOB_CHUNK_BYTES));
    assertEq(readBack.length, 5 * MB, 'طول المخزن المسترجع');
    assertEq(sha256(readBack), sha256(buf5), 'sha256 لصفوف 2MB');
    const { count: r5 } = await db.countOutputChunks(storageJob);
    assertEq(r5, 3, 'عدد صفوف 2MB لمخزن 5MB');
    await db.deleteJobData(storageJob);
  });

  await test('6) الحدود: عدد المصادر > MAX_SOURCES → 400', async () => {
    const videos = Array.from({ length: CONFIG.MAX_SOURCES + 1 }, (_, i) => `https://example.com/v${i}.mp4`);
    let threw = null;
    try { parseSourcesInput({ videos }); } catch (e) { threw = e; }
    assert(threw, 'لم يرفع خطأ عند تجاوز عدد المصادر');
    assertEq(threw.status, 400, 'كود الخطأ');
    assert(/عدد المصادر/.test(threw.message), 'الرسالة يجب أن تذكر عدد المصادر');
  });

  await test('7) الحدود: مصدر ملف يتجاوز SOURCE_MAX_MB → 413', async () => {
    let threw = null;
    try {
      parseSourcesInput({ sources: [{ kind: 'file', name: 'big.mp4', size: (CONFIG.SOURCE_MAX_MB + 1) * MB }] });
    } catch (e) { threw = e; }
    assert(threw, 'لم يرفع خطأ عند تجاوز حجم المصدر');
    assertEq(threw.status, 413, 'كود الخطأ');
  });

  await test('8) الحدود: جزء رفع أكبر من 4MB عبر نقطة /api/upload → 413', async () => {
    const jobId = genId();
    createdJobs.push(jobId);
    await db.createJob(jobId, [{ kind: 'file', name: 'chunky.mp4', mime: 'video/mp4', size: 6 * MB, totalChunks: 2 }]);
    const big = Buffer.alloc(5 * MB, 7); // أكبر من حد الرفع 4MB
    const req = mockReq({
      method: 'POST',
      url: `/api/upload?job=${jobId}&seq=0&chunk=0`,
      headers: { 'content-type': 'application/octet-stream' },
      body: big,
    });
    const res = mockRes();
    await uploadHandler(req, res);
    assertEq(res.statusCode, 413, 'كود الرد لتجاوز حجم الجزء');
    assert(/4MB|حجم الجزء/.test(res.json().error), 'رسالة عربية واضحة');
    const { count } = await db.countSourceChunks(jobId, 0);
    assertEq(count, 0, 'يجب ألا يُخزَّن جزء متجاوز للحد');
  });

  await test('9) الحذف الشامل: كل جداول المهمة تفارغ بعد DELETE', async () => {
    assertEq(await tableCount('jobs', engineJobId), 1, 'صف المهمة قبل الحذف');
    // ملاحظة: source_chunks حُذفت بعد نجاح الدمج (سلوك موصوف) — نضيف جزءًا للتحقق من حذفه أيضًا
    await db.upsertSourceChunk(engineJobId, 0, 99, Buffer.from('leftover'));
    await db.deleteJobData(engineJobId);
    assertEq(await tableCount('jobs', engineJobId), 0, 'jobs');
    assertEq(await tableCount('sources', engineJobId), 0, 'sources');
    assertEq(await tableCount('source_chunks', engineJobId), 0, 'source_chunks');
    assertEq(await tableCount('output_chunks', engineJobId), 0, 'output_chunks');
    const idx = createdJobs.indexOf(engineJobId);
    if (idx !== -1) createdJobs.splice(idx, 1);
  });

  await test('10) التنظيف التلقائي: مهمة انتهت صلاحيتها تُحذف (expires_at منتهي)', async () => {
    const jobId = genId();
    createdJobs.push(jobId);
    await db.createJob(jobId, [{ kind: 'url', url: 'https://example.com/x.mp4' }]);
    await db.putOutputBlob(jobId, Buffer.from('expired-output'));
    await db.updateJob(jobId, { expires_at: new Date(Date.now() - 3600 * 1000).toISOString() });
    const deleted = await cleanupExpiredJobs();
    assert(deleted >= 1, 'cleanupExpiredJobs يجب أن يحذف مهمة واحدة على الأقل');
    const job = await db.getJob(jobId);
    assert(!job, 'المهمة المنتهية يجب أن تكون محذوفة');
    assertEq(await tableCount('output_chunks', jobId), 0, 'أجزاء الناتج للمهمة المنتهية');
  });

  await test('11) شكل استجابة الإنشاء: uploads[] و uploadChunkBytes للمصادر الملفية', async () => {
    const jobId = genId();
    const fakeReq = { headers: { host: 'unit.test' }, method: 'POST' };
    const sources = [
      { kind: 'url', url: 'https://example.com/a.mp4' },
      { kind: 'file', name: 'f.mp4', size: 9 * MB, totalChunks: 3 },
    ];
    const resp = buildCreateResponse(fakeReq, {
      id: jobId, status: 'uploading', expires_at: '2025-01-01T00:00:00.000Z',
    }, sources);
    assertEq(resp.status, 'uploading', 'الحالة');
    assert(resp.jobId && resp.statusUrl && resp.processUrl && resp.expiresAt, 'حقول الاستجابة الأساسية');
    assert(Array.isArray(resp.uploads) && resp.uploads.length === 1, 'uploads[] لمصدر الملف');
    assertEq(resp.uploads[0].seq, 1, 'seq المصدر الملفي');
    assertEq(resp.uploads[0].chunks, 3, 'عدد الأجزاء');
    assertEq(resp.uploadChunkBytes, CONFIG.UPLOAD_CHUNK_BYTES, 'uploadChunkBytes = 4MB');
    assert(/\/api\/upload\?job=/.test(resp.uploads[0].uploadUrl), 'رابط الرفع');
  });

  /* تنظيف كل المهام المتبقية من الاختبار */
  for (const id of createdJobs) {
    await db.deleteJobData(id).catch(() => {});
  }

  console.log('\n──────────────────────────────────────');
  console.log(`النتيجة: ${passed} ناجح / ${failed} فاشل`);
  if (failures.length) {
    console.log('\nالتفاصيل:');
    for (const f of failures) console.log(` - ${f.name}: ${f.err.message}`);
  }
  console.log('');
  process.exit(failed ? 1 : 0);

  /* مساعدات */
  async function readOutput(jobId, expectedRows) {
    const pages = [];
    let offset = 0;
    while (offset < expectedRows) {
      const rows = await db.getOutputChunkPage(jobId, offset, Number.MAX_SAFE_INTEGER, CONFIG.READ_PAGE_ROWS);
      if (!rows.length) break;
      for (const r of rows) pages.push(storage.toBuffer(r.data));
      offset += rows.length;
    }
    return Buffer.concat(pages);
  }

  function fmt(n) {
    const u = ['B', 'KB', 'MB']; let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(i ? 1 : 0)}${u[i]}`;
  }
})().catch((e) => {
  console.error('فشل تشغيل الاختبارات نفسها:', e);
  process.exit(1);
});
