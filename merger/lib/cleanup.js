'use strict';
/**
 * lib/cleanup.js — الحذف التلقائي للمهام المنتهية الصلاحية (24 ساعة):
 *  تنظيف كسول عند كل طلب إنشاء/دمج + نقطة /api/cron مجدولة يوميًا.
 */
const db = require('./db');

/** حذف كل المهام المنتهية (jobs + sources + source_chunks + output_chunks لكل مهمة). */
async function cleanupExpiredJobs() {
  const ids = await db.findExpiredJobs();
  if (!ids.length) return 0;
  let deleted = 0;
  for (const id of ids) {
    try {
      await db.deleteJobData(id);
      deleted += 1;
    } catch (e) {
      console.error('[cleanup] فشل حذف مهمة', id, e.message);
    }
  }
  return deleted;
}

/** تنظيف كسول لا يُسقط الطلب أبدًا — يُستدعى عند الإنشاء والدمج. */
async function cleanupLazy() {
  try {
    return await cleanupExpiredJobs();
  } catch (e) {
    console.error('[cleanup-lazy]', e.message);
    return 0;
  }
}

module.exports = { cleanupExpiredJobs, cleanupLazy };
