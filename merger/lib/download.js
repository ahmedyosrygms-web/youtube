'use strict';
/**
 * lib/download.js — تنزيل مصادر الروابط المباشرة إلى /tmp مع مراقبة الحجم.
 */
const fs = require('fs');
const { ApiError } = require('./util');

/**
 * تنزيل رابط مباشر إلى ملف مع حد أقصى للحجم (يُفحص أثناء التنزيل بالبايتات).
 * onProgress(receivedBytes, totalBytes?)
 */
async function downloadUrlToFile(url, destPath, maxBytes, onProgress) {
  let received = 0;
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'VideoMerger/1.0 (+https://vercel.com)' },
      signal: AbortSignal.timeout(240000),
    });
  } catch (e) {
    throw new ApiError(400, `تعذر الوصول إلى المصدر: ${shortUrl(url)} — تحقق من أن الرابط مباشر وصالح`);
  }
  try {
    if (!res.ok) {
      throw new ApiError(400, `رفض المصدر الطلب (${res.status}) — تعذر تنزيل ${shortUrl(url)}`);
    }
    const contentType = String(res.headers.get('content-type') || '');
    if (contentType && /text\/html|application\/xhtml/i.test(contentType)) {
      throw new ApiError(400, `الرابط لا يشير إلى ملف فيديو مباشر: ${shortUrl(url)}`);
    }
    const declared = parseInt(res.headers.get('content-length') || '', 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ApiError(413, `حجم المصدر يتجاوز الحد الأقصى (${Math.round(maxBytes / (1024 * 1024))}MB): ${shortUrl(url)}`);
    }

    const out = fs.createWriteStream(destPath);
    const body = res.body;
    if (!body) throw new ApiError(400, `تعذر قراءة بيانات المصدر: ${shortUrl(url)}`);

    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > maxBytes) {
        try { out.destroy(); } catch (_) { /* لا شيء */ }
        try { await body.cancel(); } catch (_) { /* لا شيء */ }
        throw new ApiError(413, `تجاوز المصدر الحد الأقصى للحجم أثناء التنزيل (${Math.round(maxBytes / (1024 * 1024))}MB): ${shortUrl(url)}`);
      }
      if (onProgress) onProgress(received, Number.isFinite(declared) ? declared : undefined);
      if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
    }
    out.end();
    await new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
    if (received === 0) throw new ApiError(400, `المصدر فارغ: ${shortUrl(url)}`);
    return received;
  } finally {
    try { res.body && res.body.cancel && await res.body.cancel(); } catch (_) { /* لا شيء */ }
  }
}

function shortUrl(url) {
  const s = String(url);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

module.exports = { downloadUrlToFile };
