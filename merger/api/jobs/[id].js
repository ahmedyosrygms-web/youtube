'use strict';
/**
 * api/jobs/[id].js — GET /api/jobs/<id> (الحالة + التقدم + الرابط عند الاكتمال)
 *                  و DELETE /api/jobs/<id> (حذف فوري شامل في batch واحد).
 */
const db = require('../../lib/db');
const { buildStatusResponse } = require('../../lib/jobs');
const { json, methodNotAllowed, apiError } = require('../../lib/util');

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    const id = req.query && (req.query.id || req.query.job);

    if (req.method === 'GET') {
      if (!id) return json(res, 400, { error: 'معرف المهمة مطلوب في المسار' });
      const job = await db.getJob(String(id));
      if (!job) return json(res, 404, { error: 'المهمة غير موجودة — ربما حُذفت أو انتهت صلاحيتها' });
      const sources = await db.getSources(String(id));
      return json(res, 200, buildStatusResponse(req, job, sources.length));
    }

    if (req.method === 'DELETE') {
      if (!id) return json(res, 400, { error: 'معرف المهمة مطلوب في المسار' });
      const job = await db.getJob(String(id));
      if (!job) return json(res, 404, { error: 'المهمة غير موجودة — ربما حُذفت أو انتهت صلاحيتها' });
      // حذف شامل في batch واحد: jobs + sources + source_chunks + output_chunks
      await db.deleteJobData(String(id));
      return json(res, 200, { ok: true, jobId: String(id), message: 'تم حذف المهمة وجميع بياناتها نهائيًا' });
    }

    return methodNotAllowed(res, ['GET', 'DELETE', 'OPTIONS']);
  } catch (err) {
    return apiError(res, err);
  }
};

module.exports.handler = module.exports;
