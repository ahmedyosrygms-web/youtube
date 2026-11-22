'use strict';
/**
 * scripts/test-http.js — اختبار HTTP كامل ضد خادم التطوير على المنفذ 3001:
 *  إنشاء مهمة من روابط → دمج → بث مع Range (206) → مهمة مختلطة (رابط + ملف مرفوع) →
 *  حذف شامل → 404 → JSON تالف → قائمة فارغة → 405 → 409/202 → cron → config.
 *
 * التشغيل (الخادم يجب أن يعمل): node scripts/test-http.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

process.chdir(path.join(__dirname, '..'));

const BASE = process.env.TEST_BASE || 'http://localhost:3001';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-http-'));

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

/* مساعدات HTTP */
async function http(method, urlPath, { headers = {}, body = null, raw = false } = {}) {
  const res = await fetch(BASE + urlPath, { method, headers, body });
  if (raw) return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch (_) { data = null; }
  return { status: res.status, headers: res.headers, data, text };
}
const postJson = (p, obj) => http('POST', p, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

/** اختيار روابط عامة تعمل فعليًا من هذه البيئة (أي روابط، لا حصر لروابط محددة) */
const CANDIDATES = [
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
  'https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4',
  'https://download.samplelib.com/mp4/sample-5s.mp4',
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_2MB.mp4',
  'https://vjs.zencdn.net/v/oceans.mp4',
  'https://media.w3.org/2010/05/sintel/trailer.mp4',
];

async function pickWorkingUrls(n) {
  const ok = [];
  for (const u of CANDIDATES) {
    if (ok.length >= n) break;
    try {
      const r = await fetch(u, { headers: { Range: 'bytes=0-2047' }, signal: AbortSignal.timeout(20000) });
      if ((r.status === 200 || r.status === 206) && Number(r.headers.get('content-length')) > 0) ok.push(u);
    } catch (_) { /* لا يعمل من هنا — نتجاهله */ }
  }
  if (ok.length < n) throw new Error(`تعذر إيجاد ${n} روابط عامة تعمل — قائمة المرشحين كلها فشلت`);
  return ok;
}

/** تنزيل رابط إلى ملف (لحساب المدة/الدقة المتوقعة بـ ffprobe) */
async function downloadTo(url, dest) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`تنزيل المرجع فشل: ${r.status}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  return dest;
}

function ffprobeOf(file) {
  return new Promise((resolve, reject) => {
    const { path: probeBin } = require('ffprobe-static');
    const c = spawn(probeBin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', () => {
      try {
        const info = JSON.parse(out);
        const v = info.streams.find((s) => s.codec_type === 'video');
        resolve({
          width: v.width, height: v.height,
          duration: parseFloat(info.format.duration),
          hasAudio: info.streams.some((s) => s.codec_type === 'audio'),
        });
      } catch (e) { reject(e); }
    });
  });
}

/** توليد فيديو صغير محلي للمهمة المختلطة */
function genLocalVideo(dest) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = require('ffmpeg-static');
    const c = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=660:duration=4',
      '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '700k',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', dest]);
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => (code === 0 ? resolve(fs.statSync(dest).size) : reject(new Error('ffmpeg: ' + err.slice(-300)))));
  });
}

(async () => {
  console.log('\n═══════════ اختبار HTTP كامل ضد', BASE, '═══════════\n');

  /* 0) الخادم يعمل؟ */
  await test('0) الخادم يعمل على 3001 والواجهة تُخدم', async () => {
    const r = await http('GET', '/');
    assertEq(r.status, 200, 'كود الجذر');
    assert(r.text.includes('دمج الفيديوهات'), 'الواجهة العربية غير موجودة');
  });

  await test('1) GET /api/config — الحدود + version', async () => {
    const r = await http('GET', '/api/config');
    assertEq(r.status, 200, 'الكود');
    assertEq(r.data.version, '1.0.0', 'version');
    assertEq(r.data.maxSources, 10, 'maxSources');
    assertEq(r.data.sourceMaxMB, 200, 'sourceMaxMB');
    assertEq(r.data.outputMaxMB, 150, 'outputMaxMB');
    assertEq(r.data.maxTotalDurationSec, 600, 'maxTotalDurationSec');
    assertEq(r.data.uploadChunkBytes, 4194304, 'uploadChunkBytes');
    assertEq(r.data.ffmpegPreset, 'medium', 'ffmpegPreset');
  });

  /* روابط عامة تعمل */
  const urls = await pickWorkingUrls(2);
  console.log(`\n  ↳ روابط الاختبار العاملة: ${urls.length === 2 ? urls.join(' , ') : urls.join(' , ')}\n`);
  const refA = await downloadTo(urls[0], path.join(TMP, 'ref-a.mp4'));
  const refB = await downloadTo(urls[1], path.join(TMP, 'ref-b.mp4'));
  const metaA = await ffprobeOf(refA);
  const metaB = await ffprobeOf(refB);
  const expDuration = metaA.duration + metaB.duration;
  const expW = Math.min(Math.max(metaA.width, metaB.width), 1920);
  const expH = Math.min(Math.max(metaA.height, metaB.height), 1080);

  /* 2) مهمة روابط */
  let jobId = null;
  await test('2) POST /api/jobs من روابط → 201 + jobId/status/statusUrl/processUrl/expiresAt', async () => {
    const r = await postJson('/api/jobs', { videos: urls });
    assertEq(r.status, 201, 'الكود');
    assert(r.data.jobId && /^[a-zA-Z0-9]{6,}$/.test(r.data.jobId), 'jobId غير صالح');
    assertEq(r.data.status, 'queued', 'حالة مهمة الروابط');
    assert(r.data.statusUrl.endsWith(`/api/jobs/${r.data.jobId}`), 'statusUrl');
    assert(r.data.processUrl.endsWith(`/api/jobs/${r.data.jobId}/process`), 'processUrl');
    assert(new Date(r.data.expiresAt) > new Date(Date.now() + 23 * 3600 * 1000), 'expiresAt ≈ 24 ساعة');
    assert(!r.data.uploads, 'مهمة روابط لا تحتاج uploads[]');
    jobId = r.data.jobId;
  });

  let merged = null;
  await test('3) POST /process → دمج متزامن 200 + done payload كامل', async () => {
    const t0 = Date.now();
    const r = await http('POST', `/api/jobs/${jobId}/process`);
    console.log(`     → زمن الدمج: ${Math.round((Date.now() - t0) / 1000)}s`);
    assertEq(r.status, 200, 'الكود');
    assertEq(r.data.status, 'done', 'الحالة');
    assert(r.data.videoUrl === `${BASE}/api/jobs/${jobId}/video`, 'videoUrl');
    assert(r.data.downloadUrl === `${BASE}/api/jobs/${jobId}/video?download=1`, 'downloadUrl');
    assert(Number(r.data.size) > 0, 'حجم الناتج');
    assert(Math.abs(r.data.duration - expDuration) < 1.5, `المدة ${r.data.duration} بعيدة عن ${expDuration.toFixed(2)}`);
    assertEq(r.data.resolution, `${expW}x${expH}`, `دقة الناتج (أكبر مدخل)`);
    assert(new Date(r.data.expiresAt) > new Date(), 'expiresAt');
    merged = r.data;
  });

  await test('4) GET /api/jobs/<id> → done + progress 100 + الرابط', async () => {
    const r = await http('GET', `/api/jobs/${jobId}`);
    assertEq(r.status, 200, 'الكود');
    assertEq(r.data.status, 'done', 'الحالة');
    assertEq(r.data.progress, 100, 'التقدم');
    assertEq(r.data.videoUrl, merged.videoUrl, 'videoUrl');
    assertEq(r.data.size, merged.size, 'الحجم');
    assertEq(r.data.resolution, merged.resolution, 'الدقة');
  });

  await test('5) POST /process مرة أخرى على مهمة done → 409', async () => {
    const r = await http('POST', `/api/jobs/${jobId}/process`);
    assertEq(r.status, 409, 'الكود');
    assert(r.data.error && /مسبقًا/.test(r.data.error), 'رسالة عربية واضحة');
  });

  await test('6) بث الفيديو كامل 200 + طول مطابق', async () => {
    const r = await http('GET', `/api/jobs/${jobId}/video`, { raw: true });
    assertEq(r.status, 200, 'الكود');
    assertEq(r.headers.get('accept-ranges'), 'bytes', 'Accept-Ranges');
    assertEq(Number(r.headers.get('content-length')), merged.size, 'Content-Length');
    assertEq(r.buf.length, merged.size, 'طول الجسم الفعلي');
    assert((r.headers.get('content-type') || '').includes('video/mp4'), 'Content-Type');
    fs.writeFileSync(path.join(TMP, 'full.mp4'), r.buf);
    const p = await ffprobeOf(path.join(TMP, 'full.mp4'));
    assert(p.hasAudio, 'الناتج النهائي يجب أن يحتوي صوتًا');
  });

  await test('7) Range: bytes=0-1023 → 206 + Content-Range + تطابق البداية', async () => {
    const full = fs.readFileSync(path.join(TMP, 'full.mp4'));
    const r = await http('GET', `/api/jobs/${jobId}/video`, { headers: { Range: 'bytes=0-1023' }, raw: true });
    assertEq(r.status, 206, 'الكود');
    assertEq(r.headers.get('content-range'), `bytes 0-1023/${merged.size}`, 'Content-Range');
    assertEq(r.buf.length, 1024, 'طول المدى');
    assert(r.buf.equals(full.subarray(0, 1024)), 'البايتات غير مطابقة');
  });

  await test('8) Range: منتصف الملف bytes=5000-5999 → 206 وتطابق', async () => {
    const full = fs.readFileSync(path.join(TMP, 'full.mp4'));
    const r = await http('GET', `/api/jobs/${jobId}/video`, { headers: { Range: 'bytes=5000-5999' }, raw: true });
    assertEq(r.status, 206, 'الكود');
    assertEq(r.buf.length, 1000, 'طول المدى');
    assert(r.buf.equals(full.subarray(5000, 6000)), 'البايتات غير مطابقة');
  });

  await test('9) Range: لاحقة bytes=-500 → 206 آخر 500 بايت', async () => {
    const full = fs.readFileSync(path.join(TMP, 'full.mp4'));
    const r = await http('GET', `/api/jobs/${jobId}/video`, { headers: { Range: 'bytes=-500' }, raw: true });
    assertEq(r.status, 206, 'الكود');
    assertEq(r.buf.length, 500, 'طول المدى');
    assert(r.buf.equals(full.subarray(full.length - 500)), 'البايتات غير مطابقة');
  });

  await test('10) Range خارج الحدود → 416 مع bytes */size', async () => {
    const r = await http('GET', `/api/jobs/${jobId}/video`, { headers: { Range: `bytes=${merged.size + 10}-` }, raw: true });
    assertEq(r.status, 416, 'الكود');
    assertEq(r.headers.get('content-range'), `bytes */${merged.size}`, 'Content-Range للـ 416');
  });

  await test('11) ?download=1 → 200 + Content-Disposition attachment', async () => {
    const r = await http('GET', `/api/jobs/${jobId}/video?download=1`, { headers: { Range: 'bytes=0-99' }, raw: true });
    assertEq(r.status, 206, 'الكود');
    assert((r.headers.get('content-disposition') || '').includes('attachment'), 'Content-Disposition');
  });

  /* 12) مهمة مختلطة: رابط + ملف مرفوع */
  let mixedId = null;
  let localSize = 0;
  await test('12) مهمة مختلطة: إنشاء 201 + uploading + uploads[] + uploadChunkBytes', async () => {
    localSize = await genLocalVideo(path.join(TMP, 'local.mp4'));
    const r = await postJson('/api/jobs', {
      sources: [
        { kind: 'url', url: urls[0] },
        { kind: 'file', name: 'local.mp4', size: localSize, mime: 'video/mp4' },
      ],
    });
    assertEq(r.status, 201, 'الكود');
    assertEq(r.data.status, 'uploading', 'حالة المهمة الملفية');
    assert(Array.isArray(r.data.uploads) && r.data.uploads.length === 1, 'uploads[] مصدر واحد');
    const up = r.data.uploads[0];
    assertEq(up.seq, 1, 'seq الملف');
    assertEq(up.size, localSize, 'الحجم المعلن');
    assert(up.uploadUrl.includes(`/api/upload?job=${r.data.jobId}&seq=1`), 'رابط الرفع');
    assertEq(r.data.uploadChunkBytes, 4194304, 'uploadChunkBytes');
    mixedId = r.data.jobId;
  });

  await test('13) رفع أجزاء الملف عبر POST /api/upload → 200 وأجزاء مكتملة', async () => {
    const file = fs.readFileSync(path.join(TMP, 'local.mp4'));
    const CHUNK = 4194304;
    const chunks = Math.ceil(file.length / CHUNK);
    assert(chunks >= 1, 'ملف بدون أجزاء؟');
    for (let k = 0; k < chunks; k++) {
      const part = file.subarray(k * CHUNK, Math.min((k + 1) * CHUNK, file.length));
      const r = await http('POST', `/api/upload?job=${mixedId}&seq=1&chunk=${k}`, {
        headers: { 'Content-Type': 'application/octet-stream' },
        body: part,
      });
      assertEq(r.status, 200, `الكود للجزء ${k}`);
      assertEq(r.data.ok, true, 'ok');
      assertEq(r.data.received, part.length, 'الاستجابة تأكد حجم الجزء');
      assertEq(r.data.chunks.stored, k + 1, 'عدد الأجزاء المخزنة');
    }
    const status = await http('GET', `/api/jobs/${mixedId}`);
    assertEq(status.data.status, 'queued', 'اكتمل الرفع → queued');
  });

  await test('14) دمج المهمة المختلطة → 200 done + المدة = رابط + ملف', async () => {
    const t0 = Date.now();
    const r = await http('POST', `/api/jobs/${mixedId}/process`);
    console.log(`     → زمن الدمج: ${Math.round((Date.now() - t0) / 1000)}s`);
    assertEq(r.status, 200, 'الكود');
    assertEq(r.data.status, 'done', 'الحالة');
    const expDur = metaA.duration + 4; // الرابط الأول + الملف المحلي 4s
    assert(Math.abs(r.data.duration - expDur) < 1.5, `المدة ${r.data.duration} بعيدة عن ${expDur.toFixed(2)}`);
    assert(r.data.size > 0 && r.data.resolution, 'حجم ودقة الناتج');
  });

  await test('15) 202: مهمة processing تُرجع 202 من /process', async () => {
    // نضع الحالة processing مباشرة في القاعدة لمحاكاة دمج جارٍ
    const db = require('../lib/db');
    const probeId = crypto.randomBytes(12).toString('hex');
    await db.createJob(probeId, [{ kind: 'url', url: 'https://example.com/x.mp4' }]);
    await db.setJobStatus(probeId, 'processing', { progress: 55 });
    const r = await http('POST', `/api/jobs/${probeId}/process`);
    assertEq(r.status, 202, 'الكود');
    assertEq(r.data.status, 'processing', 'الحالة');
    assertEq(r.data.progress, 55, 'التقدم');
    await db.deleteJobData(probeId);
  });

  await test('16) حذف فوري شامل → 200 ثم كل النقاط 404', async () => {
    const before = await http('DELETE', `/api/jobs/${mixedId}`);
    assertEq(before.status, 200, 'كود الحذف');
    assertEq(before.data.ok, true, 'ok');

    const gone = await http('GET', `/api/jobs/${mixedId}`);
    assertEq(gone.status, 404, 'GET بعد الحذف');
    assert(gone.data.error && /غير موجودة/.test(gone.data.error), 'رسالة 404 عربية');

    const videoGone = await http('GET', `/api/jobs/${mixedId}/video`);
    assertEq(videoGone.status, 404, 'video بعد الحذف');

    const procGone = await http('POST', `/api/jobs/${mixedId}/process`);
    assertEq(procGone.status, 404, 'process بعد الحذف');

    const delGone = await http('DELETE', `/api/jobs/${mixedId}`);
    assertEq(delGone.status, 404, 'حذف مرة ثانية');
  });

  await test('17) JSON تالف في POST /api/jobs → 400', async () => {
    const r = await http('POST', '/api/jobs', { headers: { 'Content-Type': 'application/json' }, body: '{"videos": [باقي غير صالح' });
    assertEq(r.status, 400, 'الكود');
    assert(r.data.error && /JSON تالف|صالح/.test(r.data.error), 'رسالة JSON تالف');
  });

  await test('18) قائمة فارغة {"videos":[]} → 400 برسالة عربية', async () => {
    const r = await postJson('/api/jobs', { videos: [] });
    assertEq(r.status, 400, 'الكود');
    assert(r.data.error && /فارغة/.test(r.data.error), 'رسالة قائمة فارغة');
  });

  await test('19) مهمة غير موجودة GET /api/jobs/<random> → 404', async () => {
    const r = await http('GET', `/api/jobs/${crypto.randomBytes(12).toString('hex')}`);
    assertEq(r.status, 404, 'الكود');
  });

  await test('20) طريقة خاطئة → 405 (PUT /api/jobs، GET process، DELETE config، POST cron)', async () => {
    const a = await http('PUT', '/api/jobs', { body: '{}' });
    assertEq(a.status, 405, 'PUT /api/jobs');
    const b = await http('GET', `/api/jobs/${jobId}/process`);
    assertEq(b.status, 405, 'GET /process');
    const c = await http('DELETE', '/api/config');
    assertEq(c.status, 405, 'DELETE /config');
    const d = await http('POST', '/api/cron', { body: '' });
    assertEq(d.status, 405, 'POST /cron');
    for (const rr of [a, b, c, d]) assert(rr.data.error, 'رسالة خطأ موجودة');
  });

  await test('21) مصادر غير صالحة → 400 (رابط غير مباشر، امتداد غير مدعوم، تجاوز عدد)', async () => {
    const a = await postJson('/api/jobs', { videos: ['ftp://x/y.mp4'] });
    assertEq(a.status, 400, 'بروتوكول غير مدعوم');
    const b = await postJson('/api/jobs', { sources: [{ kind: 'file', name: 'song.mp3', size: 1000 }] });
    assertEq(b.status, 400, 'امتداد غير مدعوم');
    const c = await postJson('/api/jobs', {
      videos: Array.from({ length: 11 }, (_, i) => `https://example.com/v${i}.mp4`),
    });
    assertEq(c.status, 400, 'تجاوز عدد المصادر');
  });

  await test('22) رفع جزء بمقاسات خاطئة → 400 (chunk خارج النطاق)', async () => {
    const j = await postJson('/api/jobs', { sources: [{ kind: 'file', name: 'tiny.mp4', size: 1024 }] });
    assertEq(j.status, 201, 'إنشاء المهمة');
    const r = await http('POST', `/api/upload?job=${j.data.jobId}&seq=0&chunk=999`, {
      headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(16),
    });
    assertEq(r.status, 400, 'chunk خارج النطاق');
    const s = await http('POST', `/api/upload?job=${j.data.jobId}&seq=7&chunk=0`, {
      headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(16),
    });
    assertEq(s.status, 404, 'seq غير موجود');
    await http('DELETE', `/api/jobs/${j.data.jobId}`);
  });

  await test('23) GET /api/cron → 200 ok', async () => {
    const r = await http('GET', '/api/cron');
    assertEq(r.status, 200, 'الكود');
    assertEq(r.data.ok, true, 'ok');
    assert(Number.isFinite(r.data.deleted), 'عدد المحذوفات');
    assert(r.data.message, 'رسالة عربية');
  });

  await test('24) CORS مفتوح على الاستجابات', async () => {
    const r = await http('GET', '/api/config');
    assertEq(r.headers.get('access-control-allow-origin'), '*', 'Allow-Origin');
    const pre = await fetch(BASE + '/api/jobs', { method: 'OPTIONS' });
    assertEq(pre.status, 204, 'preflight');
  });

  /* تنظيف مهمة الروابط */
  await http('DELETE', `/api/jobs/${jobId}`);

  console.log('\n──────────────────────────────────────');
  console.log(`النتيجة: ${passed} ناجح / ${failed} فاشل`);
  if (failures.length) {
    console.log('\nالتفاصيل:');
    for (const f of failures) console.log(` - ${f.name}: ${f.err.message}`);
  }
  console.log('');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('فشل تشغيل اختبار HTTP نفسه:', e);
  process.exit(1);
});
