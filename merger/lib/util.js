'use strict';
/**
 * lib/util.js — أدوات مشتركة: استجابات JSON، CORS، قراءة الجسم، تحليل Range، مساعدات.
 */
const { CONFIG } = require('./env');

/** خطأ واضح بكود HTTP ورسالة عربية — يُلتقط في كل نقطة نهاية. */
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function json(res, status, obj) {
  setCors(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function apiError(res, err) {
  const status = err instanceof ApiError ? err.status : 500;
  const message = err instanceof ApiError
    ? err.message
    : 'حدث خطأ داخلي غير متوقع، حاول لاحقًا';
  if (!(err instanceof ApiError)) console.error('[internal-error]', err);
  json(res, status, { error: message });
}

function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  json(res, 405, { error: `الطريقة غير مسموحة — المسموح لهذه النقطة: ${allowed.join('، ')}` });
}

/** قراءة الجسم الخام (Buffer) مع حد أقصى — يعمل على Vercel وعلى خادم التطوير. */
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    // على Vercel قد يكون الجسم قد حُلّل مسبقًا
    if (Buffer.isBuffer(req.body)) return resolve(req.body);
    if (typeof req.body === 'string') return resolve(Buffer.from(req.body, 'utf8'));
    if (req.body && typeof req.body === 'object') return resolve(Buffer.from(JSON.stringify(req.body)));

    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; fn(arg); } };
    req.on('data', (c) => {
      size += c.length;
      if (maxBytes && size > maxBytes) {
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        finish(reject, new ApiError(413, `حجم الطلب يتجاوز الحد المسموح (${Math.round(maxBytes / (1024 * 1024))}MB)`));
        try { req.destroy(); } catch (_) { /* لا شيء */ }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks)));
    req.on('error', (e) => finish(reject, e));
    req.on('aborted', () => finish(reject, new ApiError(400, 'انقطع الطلب قبل اكتماله')));
  });
}

/** قراءة جسم JSON مع حد حجم افتراضي 1MB. */
async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const contentType = String(req.headers['content-type'] || '');
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = await readRawBody(req, maxBytes);
  if (!raw || raw.length === 0) throw new ApiError(400, 'جسم الطلب فارغ — أرسل JSON صالحًا');
  const text = raw.toString('utf8').trim();
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new ApiError(400, 'JSON تالف — تعذر تحليل جسم الطلب');
  }
}

/** قراءة جسم ثنائي صارم (لأجزاء الرفع) — يرفض JSON. */
async function readBinaryBody(req, maxBytes) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('application/json') || contentType.includes('multipart/form-data')) {
    throw new ApiError(400, 'يجب رفع الأجزاء كثنائي خام بـ Content-Type: application/octet-stream');
  }
  return readRawBody(req, maxBytes);
}

/** الرقم الأساسي للروابط المطلقة من رؤوس الطلب (يعمل على Vercel ومحليًا). */
function baseUrl(req) {
  const h = req.headers || {};
  const host = String(h['x-forwarded-host'] || h.host || 'localhost:3001').split(',')[0].trim();
  let proto = 'http';
  const xf = h['x-forwarded-proto'];
  if (xf) proto = String(xf).split(',')[0].trim();
  return `${proto}://${host}`;
}

function absUrl(req, pathName) {
  return `${baseUrl(req)}${pathName}`;
}

/** توليد معرف مهمة قصير غير متوقع. */
function genId() {
  const c = require('crypto');
  return c.randomBytes(12).toString('hex'); // 24 خانة
}

function parseHttpDate(iso) {
  try { return new Date(iso); } catch (_) { return null; }
}

/**
 * تحليل ترويسة Range: bytes=start-end | bytes=start- | bytes=-suffix
 * تُرجع {start, end} ضمنية (شاملة) أو null إن لم يوجد Range أو byte-range-specs=*
 */
function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader || typeof rangeHeader !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (totalSize <= 0) return { invalid: true };
  let start, end;
  if (a === '') { // لاحقة: آخر N بايت
    const n = parseInt(b, 10);
    if (!Number.isFinite(n) || n <= 0) return { invalid: true };
    start = Math.max(0, totalSize - n);
    end = totalSize - 1;
  } else {
    start = parseInt(a, 10);
    end = b === '' ? totalSize - 1 : parseInt(b, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true };
    if (start >= totalSize) return { invalid: true }; // أول بايت خارج الحجم → 416
    if (end < start) return { invalid: true };
    end = Math.min(end, totalSize - 1);
  }
  return { start, end };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function formatBytes(n) {
  if (!Number.isFinite(n)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

module.exports = {
  ApiError,
  setCors,
  json,
  apiError,
  methodNotAllowed,
  readRawBody,
  readJsonBody,
  readBinaryBody,
  baseUrl,
  absUrl,
  genId,
  parseRange,
  sleep,
  formatBytes,
  CONFIG,
};
