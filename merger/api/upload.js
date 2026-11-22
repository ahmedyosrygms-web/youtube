'use strict';
/**
 * api/upload.js — POST /api/upload?job=<id>&seq=<n>&chunk=<k>
 * رفع أجزاء الملفات (ثنائي ≤4MB) — Content-Type: application/octet-stream.
 */
const db = require('../lib/db');
const { json, methodNotAllowed, apiError, readBinaryBody, ApiError } = require('../lib/util');
const { CONFIG } = require('../lib/env');

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST', 'OPTIONS']);

    const q = req.query || {};
    const jobId = q.job;
    const seq = parseInt(q.seq, 10);
    const chunk = parseInt(q.chunk, 10);
    if (!jobId || !Number.isFinite(seq) || !Number.isFinite(chunk)) {
      return json(res, 400, { error: 'معاملات الرفع مطلوبة: job=<id>&seq=<n>&chunk=<k>' });
    }

    const job = await db.getJob(String(jobId));
    if (!job) return json(res, 404, { error: 'المهمة غير موجودة — ربما حُذفت أو انتهت صلاحيتها' });
    if (job.status !== 'uploading' && job.status !== 'queued') {
      return json(res, 409, { error: `لا يمكن الرفع في حالة المهمة الحالية (${job.status}) — الرفع متاح فقط قبل بدء الدمج` });
    }

    const sources = await db.getSources(String(jobId));
    const source = sources.find((s) => Number(s.seq) === seq);
    if (!source) return json(res, 404, { error: `لا يوجد مصدر برقم تسلسل ${seq} في هذه المهمة` });
    if (source.kind !== 'file') {
      return json(res, 400, { error: 'المصدر المطلوب رابط وليس ملفًا — الروابط تُسحب تلقائيًا أثناء الدمج' });
    }

    const totalChunks = Number(source.total_chunks) || Math.ceil(Number(source.size) / CONFIG.UPLOAD_CHUNK_BYTES);
    if (chunk < 0 || chunk >= totalChunks) {
      return json(res, 400, { error: `رقم الجزء خارج النطاق — الملف يقبل ${totalChunks} أجزاء (0 إلى ${totalChunks - 1})` });
    }

    const maxChunk = CONFIG.UPLOAD_CHUNK_BYTES + 64 * 1024; // هامش صغير للحماية
    const body = await readBinaryBody(req, maxChunk);
    if (!body || body.length === 0) return json(res, 400, { error: 'الجزء المرفوع فارغ' });
    if (body.length > CONFIG.UPLOAD_CHUNK_BYTES) {
      throw new ApiError(413, `حجم الجزء (${body.length} بايت) يتجاوز حد الرفع (${CONFIG.UPLOAD_CHUNK_BYTES} بايت = 4MB)`);
    }

    await db.upsertSourceChunk(String(jobId), seq, chunk, body);
    const { count, bytes } = await db.countSourceChunks(String(jobId), seq);
    await db.updateSourceProgress(String(jobId), seq, bytes);

    const complete = count >= totalChunks;
    let jobStatus = job.status;
    if (complete) {
      // اكتملت كل الأجزاء؟ اقلب حالة المهمة إلى queued جاهزة للدمج
      const allDone = await db.allSourcesUploaded(String(jobId));
      if (allDone && job.status === 'uploading') {
        await db.setJobStatus(String(jobId), 'queued');
        jobStatus = 'queued';
      }
    }

    return json(res, 200, {
      ok: true,
      jobId: String(jobId),
      seq,
      chunk,
      received: body.length,
      uploaded: bytes,
      chunks: { stored: count, total: totalChunks },
      sourceComplete: complete,
      status: jobStatus,
    });
  } catch (err) {
    return apiError(res, err);
  }
};

module.exports.handler = module.exports;
