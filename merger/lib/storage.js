'use strict';
/**
 * lib/storage.js — تخزين واسترجاع الـ Blobs من Turso:
 *  - تجميع أجزاء المصدر المرفوع في ملف مؤقت.
 *  - تقسيم الفيديو الناتج إلى صفوف 2MB وتخزينه.
 */
const fs = require('fs');
const db = require('./db');
const { ApiError } = require('./util');
const { CONFIG } = require('./env');

/** صفحة قراءة = READ_PAGE_ROWS صفوف (8) */
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data);
}

/**
 * تجميع أجزاء المصدر المرفوع (source_chunks) في ملف مؤقت بالترتيب.
 * يتحقق أن الحجم النهائي يطابق الحجم المعلن.
 */
async function assembleSourceChunksToFile(jobId, seq, destPath, expectedSize) {
  const { count } = await db.countSourceChunks(jobId, seq);
  if (count <= 0) throw new ApiError(400, 'لم يُرفع هذا المصدر بعد — الأجزاء غير موجودة');

  const out = fs.createWriteStream(destPath);
  let written = 0;
  let nextChunk = 0;
  const PAGE = CONFIG.READ_PAGE_ROWS;

  while (true) {
    const rows = await db.getSourceChunkPage(jobId, seq, nextChunk, Number.MAX_SAFE_INTEGER, PAGE);
    if (!rows.length) break;
    for (const row of rows) {
      const idx = Number(row.chunk);
      if (idx !== nextChunk) {
        out.destroy();
        throw new ApiError(400, `أجزاء المصدر غير متسلسلة — الجزء ${nextChunk} مفقود`);
      }
      const buf = toBuffer(row.data);
      written += buf.length;
      nextChunk += 1;
      if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
    }
    if (rows.length < PAGE) break;
  }
  out.end();
  await new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });

  if (expectedSize != null && written !== Number(expectedSize)) {
    throw new ApiError(400, `حجم الملف المرفوع (${written} بايت) لا يطابق الحجم المعلن (${expectedSize} بايت)`);
  }
  return written;
}

/** تخزين الفيديو الناتج من ملف مؤقت إلى output_chunks (صفوف 2MB). */
async function storeOutputFile(jobId, srcPath, onProgress) {
  const size = fs.statSync(srcPath).size;
  const buf = fs.readFileSync(srcPath);
  const rows = await db.putOutputBlob(jobId, buf, onProgress);
  return { size, rows };
}

module.exports = { assembleSourceChunksToFile, storeOutputFile, toBuffer };
