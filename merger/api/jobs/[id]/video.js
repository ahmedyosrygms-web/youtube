'use strict';
/**
 * api/jobs/[id]/video.js — GET /api/jobs/<id>/video
 * بث الناتج من صفوف الـ Blobs مع دعم Range (استجابة 206 + Content-Range)،
 * و ?download=1 للتحميل المباشر.
 */
const db = require('../../../lib/db');
const { toBuffer } = require('../../../lib/storage');
const { json, setCors, methodNotAllowed, apiError, parseRange, ApiError } = require('../../../lib/util');
const { CONFIG } = require('../../../lib/env');

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET', 'OPTIONS']);

    const id = req.query && (req.query.id || req.query.job);
    if (!id) return json(res, 400, { error: 'معرف المهمة مطلوب في المسار' });

    const job = await db.getJob(String(id));
    if (!job) return json(res, 404, { error: 'المهمة غير موجودة — ربما حُذفت أو انتهت صلاحيتها' });
    if (job.status !== 'done' || !Number(job.output_size)) {
      return json(res, 409, { error: 'الفيديو غير جاهز بعد — أكمل الدمج أولًا ثم أعد المحاولة' });
    }

    const totalSize = Number(job.output_size);
    const range = parseRange(req.headers && req.headers.range, totalSize);
    const download = req.query.download === '1' || req.query.download === 'true';

    setCors(res);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=0');
    if (download) {
      res.setHeader('Content-Disposition', `attachment; filename="merged-${String(id)}.mp4"`);
    }

    if (range && range.invalid) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      res.setHeader('Content-Length', '0');
      return res.end();
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : totalSize - 1;
    res.statusCode = range ? 206 : 200;
    if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    res.setHeader('Content-Length', String(end - start + 1));

    // تدفق صفوف الـ Blobs مع تقليم أول/آخر جزء حسب المدى المطلوب
    const CHUNK = CONFIG.BLOB_CHUNK_BYTES;
    const firstChunk = Math.floor(start / CHUNK);
    const lastChunk = Math.floor(end / CHUNK);
    let aborted = false;
    res.on && res.on('close', () => { aborted = true; });

    let nextChunk = firstChunk;
    while (nextChunk <= lastChunk && !aborted) {
      const rows = await db.getOutputChunkPage(String(id), nextChunk, lastChunk, CONFIG.READ_PAGE_ROWS);
      if (!rows.length) throw new ApiError(500, 'أجزاء الفيديو الناتج غير مكتملة في التخزين');
      for (const row of rows) {
        if (aborted) return;
        const idx = Number(row.chunk);
        if (idx !== nextChunk) throw new ApiError(500, `صف مفقود في التخزين عند الجزء ${nextChunk}`);
        const orig = toBuffer(row.data);
        const chunkStart = idx * CHUNK;
        const chunkEnd = chunkStart + orig.length - 1;
        let buf = orig;
        if (chunkStart < start) buf = buf.subarray(start - chunkStart);
        if (chunkEnd > end) buf = buf.subarray(0, buf.length - (chunkEnd - end));
        if (buf.length && !res.write(buf)) await once(res, 'drain');
        nextChunk = idx + 1;
      }
      if (rows.length < CONFIG.READ_PAGE_ROWS) break;
    }
    if (nextChunk <= lastChunk && !aborted) {
      throw new ApiError(500, 'أجزاء الفيديو الناتج غير مكتملة في التخزين');
    }
    if (!aborted) res.end();
  } catch (err) {
    return apiError(res, err);
  }
};

module.exports.handler = module.exports;
