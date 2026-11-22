'use strict';
/**
 * lib/merge.js — محرك الدمج (الأهم):
 *  ffprobe لكل مصدر → توحيد الدقة عبر scale+pad (حد 1920×1080 وأبعاد زوجية) →
 *  fps=30 → concat → libx264 CRF 18 + AAC 192k/44100 + faststart →
 *  قراءة -progress pipe:1 لتقدم الترميز → تخزين الناتج في Turso.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const db = require('./db');
const storage = require('./storage');
const { downloadUrlToFile } = require('./download');
const { ApiError } = require('./util');
const { CONFIG } = require('./env');

const MB = 1024 * 1024;

/* ---------------------------- حل ثنائيات ffmpeg ---------------------------- */

/** ضمان صلاحية التنفيذ: انسخ الثنائي إلى /tmp بصلاحية 755 عند الحاجة. */
function ensureExecutable(binPath) {
  if (!binPath) return binPath;
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return binPath;
  } catch (_) {
    const tmp = path.join(os.tmpdir(), `vm-${path.basename(binPath)}`);
    if (!fs.existsSync(tmp)) {
      fs.copyFileSync(binPath, tmp);
      fs.chmodSync(tmp, 0o755);
    }
    return tmp;
  }
}

function resolveBinary(pkgName, exportField, systemPaths) {
  // 1) من الحزم المثبتة (ffmpeg-static / ffprobe-static)
  try {
    const mod = require(pkgName);
    const p = exportField ? mod[exportField] : mod;
    if (p && fs.existsSync(p)) return ensureExecutable(p);
  } catch (_) { /* الحزمة غير موجودة — نتحول للنظام */ }
  // 2) من النظام
  for (const p of systemPaths) {
    if (fs.existsSync(p)) return p;
  }
  throw new ApiError(500, `تعذر العثور على ${pkgName} — ثبّت الحزمة أو ffmpeg على النظام`);
}

function getFfmpeg() {
  return resolveBinary('ffmpeg-static', null, ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/bin/ffmpeg']);
}

function getFfprobe() {
  return resolveBinary('ffprobe-static', 'path', ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe', '/bin/ffprobe']);
}

/* --------------------------------- تشغيل --------------------------------- */

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      if (opts.onStdout) opts.onStdout(s);
      else stdout += s;
    });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`${path.basename(bin)} خرج بالكود ${code}: ${stderr.slice(-800).trim() || 'خطأ غير معروف'}`));
    });
  });
}

/* --------------------------------- الفحص --------------------------------- */

/** ffprobe لملف: الدقة، معدل الإطارات، المدة، وجود الصوت. */
async function probeMedia(file) {
  const bin = getFfprobe();
  const { stdout } = await run(bin, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  let info;
  try { info = JSON.parse(stdout); } catch (_) {
    throw new ApiError(400, 'تعذر تحليل بيانات أحد المصادر (مخرجات ffprobe غير صالحة)');
  }
  const streams = info.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new ApiError(400, 'أحد المصادر لا يحتوي على مسار فيديو صالح');

  let duration = parseFloat(info.format && info.format.duration);
  if (!Number.isFinite(duration)) duration = parseFloat(v.duration);
  if (!Number.isFinite(duration) && a) duration = parseFloat(a.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new ApiError(400, 'تعذر تحديد مدة أحد المصادر — الملف تالف أو غير مكتمل');
  }

  const fpsParts = String(v.avg_frame_rate || v.r_frame_rate || '30/1').split('/');
  let fps = Number(fpsParts[0]) / (Number(fpsParts[1]) || 1);
  if (!Number.isFinite(fps) || fps <= 0) fps = 30;

  return {
    width: parseInt(v.width, 10),
    height: parseInt(v.height, 10),
    fps: Math.round(fps * 1000) / 1000,
    duration,
    hasAudio: Boolean(a),
    audioRate: a ? parseInt(a.sample_rate, 10) || CONFIG.AUDIO_RATE : CONFIG.AUDIO_RATE,
    pixFmt: v.pix_fmt || 'yuv420p',
  };
}

/* ------------------------------- التقدم ------------------------------- */

class ProgressTracker {
  constructor(jobId) {
    this.jobId = jobId;
    this.last = -1;
    this.lastAt = 0;
  }

  async set(pct) {
    const p = Math.max(0, Math.min(99, Math.round(pct)));
    const now = Date.now();
    if (p === this.last) return;
    if (this.last >= 0 && now - this.lastAt < 700 && p - this.last < 3) return;
    this.last = p;
    this.lastAt = now;
    await db.updateJob(this.jobId, { progress: p }).catch(() => {});
  }
}

/* ------------------------------ محرك الدمج ------------------------------ */

/** أبعاد زوجية مع حد أقصى 1920×1080 */
function evenClamp(n, max) {
  const v = Math.min(n, max);
  return v - (v % 2);
}

/**
 * تنفيذ مهمة الدمج كاملة (متزامن):
 *  1) سحب المصادر إلى /tmp (تقدم 0–40)
 *  2) ffprobe + فحص الحدود
 *  3) بناء filter_complex (scale+pad+fps+setsar+format ثم concat)
 *  4) ترميز نهائي libx264 CRF 18 + AAC (تقدم 40–90)
 *  5) فحص حجم الناتج → تخزين في Turso → حذف أجزاء المصادر → done (تقدم 100)
 */
async function runMergeJob(jobId) {
  const job = await db.getJob(jobId);
  if (!job) throw new ApiError(404, 'المهمة غير موجودة');

  const sources = await db.getSources(jobId);
  if (!sources.length) throw new ApiError(400, 'لا توجد مصادر لهذه المهمة');

  const progress = new ProgressTracker(jobId);
  await db.setJobStatus(jobId, 'processing', { progress: 0, error: null });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-'));
  const tmpFiles = [];
  try {
    /* ---- 1) سحب المصادر (0–40) ---- */
    const maxSourceBytes = CONFIG.SOURCE_MAX_MB * MB;

    for (let i = 0; i < sources.length; i += 1) {
      const s = sources[i];
      const seq = Number(s.seq);
      const dest = path.join(tmpDir, `src-${seq}.${extensionOf(s)}`);
      tmpFiles.push(dest);
      const base = 5 + (35 * i) / sources.length;
      const span = 35 / sources.length;

      if (s.kind === 'url') {
        await downloadUrlToFile(s.url, dest, maxSourceBytes, (bytes, total) => {
          const denom = total || Math.max(bytes, maxSourceBytes * 0.5);
          progress.set(base + span * Math.min(1, bytes / denom));
        });
      } else {
        const written = await storage.assembleSourceChunksToFile(jobId, seq, dest, s.size);
        progress.set(base + span);
        if (written > maxSourceBytes) {
          throw new ApiError(413, `حجم المصدر المرفوع يتجاوز الحد الأقصى (${CONFIG.SOURCE_MAX_MB}MB)`);
        }
      }
    }
    await progress.set(40);

    /* ---- 2) ffprobe + الحدود ---- */
    const probes = [];
    let totalDuration = 0;
    for (const f of tmpFiles) {
      const p = await probeMedia(f);
      probes.push(p);
      totalDuration += p.duration;
    }
    if (totalDuration > CONFIG.MAX_TOTAL_DURATION_SEC) {
      throw new ApiError(413, `المدة الإجمالية للمصادر (${Math.round(totalDuration)} ثانية) تتجاوز الحد الأقصى (${CONFIG.MAX_TOTAL_DURATION_SEC} ثانية)`);
    }

    /* ---- 3) الأبعاد المستهدفة: أكبر دقة بين المدخلات ضمن 1920×1080 وأبعاد زوجية ---- */
    const maxW = Math.max(...probes.map((p) => p.width));
    const maxH = Math.max(...probes.map((p) => p.height));
    const W = evenClamp(maxW, CONFIG.MAX_WIDTH);
    const H = evenClamp(maxH, CONFIG.MAX_HEIGHT);

    /* ---- 4) بناء معاملات ffmpeg والفلتر ---- */
    const ffmpeg = getFfmpeg();
    const inputArgs = [];
    const chains = [];
    let inputIdx = 0;

    probes.forEach((p, i) => {
      // ملف المصدر = مدخل واحد يحمل الفيديو والصوت معًا ([X:v] و [X:a])
      inputArgs.push('-i', tmpFiles[i]);
      const fileIdx = inputIdx;
      inputIdx += 1;
      chains.push(
        `[${fileIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${CONFIG.VIDEO_FPS},setsar=1,format=yuv420p[v${i}]`,
      );
      if (p.hasAudio) {
        chains.push(`[${fileIdx}:a]aresample=${CONFIG.AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      } else {
        // مصدر بلا صوت → مدخل lavfi صامت anullsrc بنفس مدته بدل أن يفشل الدمج
        inputArgs.push('-f', 'lavfi', '-t', p.duration.toFixed(3), '-i', `anullsrc=r=${CONFIG.AUDIO_RATE}:cl=stereo`);
        chains.push(`[${inputIdx}:a]aresample=${CONFIG.AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
        inputIdx += 1;
      }
    });

    const pairs = probes.map((_, i) => `[v${i}][a${i}]`).join('');
    chains.push(`${pairs}concat=n=${probes.length}:v=1:a=1[vout][aout]`);

    const outPath = path.join(tmpDir, 'merged.mp4');
    const encodeArgs = [
      '-hide_banner', '-loglevel', 'error', '-y',
      ...inputArgs,
      '-filter_complex', chains.join(';'),
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', CONFIG.FFMPEG_PRESET, '-crf', String(CONFIG.CRF),
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', CONFIG.AUDIO_BITRATE, '-ar', String(CONFIG.AUDIO_RATE),
      '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats',
      outPath,
    ];

    /* ---- 5) الترميز مع قراءة التقدم (40–90) ---- */
    await run(ffmpeg, encodeArgs, {
      onStdout: (chunk) => {
        for (const line of chunk.split(/\r?\n/)) {
          const m = /^out_time_us=(\d+)/.exec(line.trim()) || /^out_time_ms=(\d+)/.exec(line.trim());
          if (m) {
            const us = parseInt(m[1], 10);
            const frac = Math.min(1, us / 1e6 / totalDuration);
            progress.set(40 + 50 * frac); // 40 → 90
          }
        }
      },
    });

    /* ---- 6) فحص حجم الناتج → تخزين ---- */
    const outSize = fs.statSync(outPath).size;
    if (outSize > CONFIG.OUTPUT_MAX_MB * MB) {
      throw new ApiError(413, `حجم الفيديو الناتج (${(outSize / MB).toFixed(1)}MB) يتجاوز الحد الأقصى (${CONFIG.OUTPUT_MAX_MB}MB)`);
    }

    // تخزين الناتج (صفوف 2MB)
    await storage.storeOutputFile(jobId, outPath);

    // حذف أجزاء المصادر بعد نجاح الدمج — الناتج فقط هو المطلوب
    await db.deleteSourceChunks(jobId);

    const duration = totalDuration;
    const resolution = `${W}x${H}`;
    await db.setJobStatus(jobId, 'done', {
      progress: 100,
      output_size: outSize,
      output_duration: Math.round(duration * 100) / 100,
      output_resolution: resolution,
      error: null,
    });

    return { size: outSize, duration, resolution };
  } catch (err) {
    const message = err instanceof ApiError ? err.message : `فشل الدمج: ${String(err.message || err).slice(0, 300)}`;
    await db.setJobStatus(jobId, 'failed', { error: message }).catch(() => {});
    throw err;
  } finally {
    // نظّف /tmp دائمًا
    for (const f of [...tmpFiles, path.join(tmpDir, 'merged.mp4')]) {
      try { fs.unlinkSync(f); } catch (_) { /* غير موجود */ }
    }
    try { fs.rmdirSync(tmpDir); } catch (_) { /* ليس فارغًا؟ تجاهل */ }
  }
}

function extensionOf(sourceRow) {
  const fromName = sourceRow.name && String(sourceRow.name).includes('.')
    ? String(sourceRow.name).split('.').pop().toLowerCase()
    : null;
  const fromUrl = sourceRow.url && /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(String(sourceRow.url));
  return (fromName || (fromUrl && fromUrl[1].toLowerCase()) || 'mp4');
}

module.exports = { runMergeJob, probeMedia, ensureExecutable, getFfmpeg, getFfprobe };
