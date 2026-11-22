'use strict';
/**
 * lib/jobs.js — منطق المهام المشترك: التحقق من المدخلات وأشكال الاستجابات الموحدة.
 */
const { ApiError, baseUrl } = require('./util');
const { CONFIG } = require('./env');

const MB = 1024 * 1024;

/** تحويل وتحقق من جسم POST /api/jobs إلى قائمة مصادر مرتبة. */
function parseSourcesInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'جسم الطلب يجب أن يكون JSON كائنًا: {"videos":[...]} أو {"sources":[...]}');
  }

  const sources = [];

  if (body.videos !== undefined) {
    if (!Array.isArray(body.videos)) throw new ApiError(400, 'الحقل videos يجب أن يكون مصفوفة روابط');
    for (const v of body.videos) {
      if (typeof v !== 'string' || !/^https?:\/\/.+/i.test(v.trim())) {
        throw new ApiError(400, 'كل عنصر في videos يجب أن يكون رابط فيديو مباشرًا صالحًا (http/https)');
      }
      sources.push({ kind: 'url', url: v.trim() });
    }
  }

  if (body.sources !== undefined) {
    if (!Array.isArray(body.sources)) throw new ApiError(400, 'الحقل sources يجب أن يكون مصفوفة كائنات');
    for (const s of body.sources) {
      if (!s || typeof s !== 'object') throw new ApiError(400, 'كل مصدر يجب أن يكون كائنًا {kind, url | name, size, mime}');
      if (s.kind === 'url') {
        if (typeof s.url !== 'string' || !/^https?:\/\/.+/i.test(s.url.trim())) {
          throw new ApiError(400, 'رابط المصدر مطلوب ويجب أن يكون http/https صالحًا');
        }
        sources.push({ kind: 'url', url: s.url.trim() });
      } else if (s.kind === 'file') {
        if (!s.name || typeof s.name !== 'string') throw new ApiError(400, 'اسم ملف المصدر مطلوب');
        const size = Number(s.size);
        if (!Number.isFinite(size) || size <= 0) throw new ApiError(400, `حجم الملف ${s.name} غير صالح`);
        const ext = s.name.includes('.') ? s.name.split('.').pop().toLowerCase() : '';
        if (!CONFIG.ALLOWED_EXTENSIONS.includes(ext)) {
          throw new ApiError(400, `امتداد الملف ${s.name} غير مدعوم — المسموح: ${CONFIG.ALLOWED_EXTENSIONS.join('، ')}`);
        }
        if (size > CONFIG.SOURCE_MAX_MB * MB) {
          throw new ApiError(413, `حجم الملف ${s.name} يتجاوز الحد الأقصى للمصدر (${CONFIG.SOURCE_MAX_MB}MB)`);
        }
        sources.push({
          kind: 'file',
          name: s.name,
          mime: s.mime || 'video/mp4',
          size: Math.round(size),
          totalChunks: Math.ceil(size / CONFIG.UPLOAD_CHUNK_BYTES),
        });
      } else {
        throw new ApiError(400, 'kind يجب أن يكون url أو file');
      }
    }
  }

  if (!sources.length) {
    throw new ApiError(400, 'قائمة المصادر فارغة — أرسل {"videos":[...]} أو {"sources":[...]} بمصدر واحد على الأقل');
  }
  if (sources.length > CONFIG.MAX_SOURCES) {
    throw new ApiError(400, `عدد المصادر يتجاوز الحد الأقصى (${CONFIG.MAX_SOURCES} مصادر)`);
  }
  return sources;
}

/** شكل استجابة إنشاء المهمة (201). */
function buildCreateResponse(req, job, sources) {
  const base = baseUrl(req);
  const res = {
    jobId: job.id,
    status: job.status,
    statusUrl: `${base}/api/jobs/${job.id}`,
    processUrl: `${base}/api/jobs/${job.id}/process`,
    expiresAt: job.expires_at || job.expiresAt,
  };
  const fileSources = sources.filter((s) => s.kind === 'file');
  if (fileSources.length) {
    res.uploads = fileSources.map((s, i) => ({
      seq: sources.indexOf(s) !== -1 ? sources.indexOf(s) : i,
      uploadUrl: `${base}/api/upload?job=${job.id}&seq=${sources.indexOf(s)}`,
      chunks: s.totalChunks,
      name: s.name,
      size: s.size,
    }));
    res.uploadChunkBytes = CONFIG.UPLOAD_CHUNK_BYTES;
  }
  return res;
}

/** شكل استجابة الحالة GET /api/jobs/<id>. */
function buildStatusResponse(req, job, sourcesCount) {
  const base = baseUrl(req);
  const res = {
    jobId: job.id,
    status: job.status,
    progress: Number(job.progress) || 0,
    createdAt: job.created_at,
    expiresAt: job.expires_at,
    sources: Number(sourcesCount) || 0,
  };
  if (job.status === 'done') {
    res.videoUrl = `${base}/api/jobs/${job.id}/video`;
    res.downloadUrl = `${base}/api/jobs/${job.id}/video?download=1`;
    res.size = Number(job.output_size) || 0;
    res.duration = job.output_duration != null ? Number(job.output_duration) : null;
    res.resolution = job.output_resolution || null;
  }
  if (job.status === 'failed' && job.error) res.error = job.error;
  return res;
}

/** شكل استجابة الدمج الناجح POST /api/jobs/<id>/process. */
function buildDoneResponse(req, job) {
  const base = baseUrl(req);
  return {
    status: 'done',
    videoUrl: `${base}/api/jobs/${job.id}/video`,
    downloadUrl: `${base}/api/jobs/${job.id}/video?download=1`,
    size: Number(job.output_size) || 0,
    duration: job.output_duration != null ? Number(job.output_duration) : null,
    resolution: job.output_resolution || null,
    expiresAt: job.expires_at,
  };
}

module.exports = { parseSourcesInput, buildCreateResponse, buildStatusResponse, buildDoneResponse };
