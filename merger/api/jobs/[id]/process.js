'use strict';
/**
 * api/jobs/[id]/process.js — POST /api/jobs/<id>/process
 * متزامن: يسحب المصادر ← يرمّز ← يحفظ، ويرجع مباشرة شكل done الكامل.
 * لو المهمة قيد المعالجة فعله يرجع 202.
 */
const db = require('../../../lib/db');
const { buildDoneResponse } = require('../../../lib/jobs');
const { json, methodNotAllowed, apiError, baseUrl } = require('../../../lib/util');
const { runMergeJob } = require('../../../lib/merge');
const { cleanupLazy } = require('../../../lib/cleanup');

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST', 'OPTIONS']);
    const id = req.query && (req.query.id || req.query.job);
    if (!id) return json(res, 400, { error: 'معرف المهمة مطلوب في المسار' });

    const job = await db.getJob(String(id));
    if (!job) return json(res, 404, { error: 'المهمة غير موجودة — ربما حُذفت أو انتهت صلاحيتها' });

    // قيد المعالجة فعله → 202 (يُتابع عبر GET /api/jobs/<id>)
    if (job.status === 'processing') {
      return json(res, 202, {
        status: 'processing',
        progress: Number(job.progress) || 0,
        statusUrl: `${baseUrl(req)}/api/jobs/${job.id}`,
        message: 'المهمة قيد المعالجة حاليًا — تابع التقدم عبر رابط الحالة',
      });
    }

    if (job.status === 'done') {
      return json(res, 409, {
        error: 'تمت معالجة هذه المهمة مسبقًا — استخدم رابط الحالة أو رابط الفيديو',
        statusUrl: `${baseUrl(req)}/api/jobs/${job.id}`,
      });
    }

    if (job.status === 'uploading') {
      const complete = await db.allSourcesUploaded(String(id));
      if (!complete) {
        return json(res, 409, { error: 'لم تكتمل رفع أجزاء الملفات بعد — أكمل الرفع أولًا' });
      }
    }

    // تنظيف كسول عند كل طلب دمج
    cleanupLazy().catch(() => {});

    await runMergeJob(String(id));
    const done = await db.getJob(String(id));
    return json(res, 200, buildDoneResponse(req, done));
  } catch (err) {
    return apiError(res, err);
  }
};

module.exports.handler = module.exports;
