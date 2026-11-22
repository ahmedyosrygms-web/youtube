'use strict';
/**
 * api/cron.js — GET /api/cron: حذف المهام المنتهية الصلاحية (Cron يومي في vercel.json).
 */
const { json, methodNotAllowed, apiError } = require('../lib/util');
const { cleanupExpiredJobs } = require('../lib/cleanup');

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET', 'OPTIONS']);

    const deleted = await cleanupExpiredJobs();
    return json(res, 200, {
      ok: true,
      deleted,
      message: deleted > 0
        ? `تم حذف ${deleted} مهمة منتهية الصلاحية`
        : 'لا توجد مهام منتهية الصلاحية',
    });
  } catch (err) {
    return apiError(res, err);
  }
};

module.exports.handler = module.exports;
