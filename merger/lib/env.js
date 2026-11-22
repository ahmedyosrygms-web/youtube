'use strict';
/**
 * lib/env.js — تحميل متغيرات البيئة يدويًا + الحدود العامة للمشروع.
 * لا أسرار هنا: القيم الحقيقية تُقرأ من .env محليًا أو من متغيرات Vercel.
 */
const fs = require('fs');
const path = require('path');

/** تحميل ملف .env يدويًا (بدون أي اعتماديات خارجية) — للتطوير المحلي فقط. */
function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (_) { /* تجاهل — لا نُسقط الخدمة بسبب .env */ }
}

loadDotEnv();

function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

function strEnv(name, def) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : def;
}

const MB = 1024 * 1024;

const CONFIG = {
  VERSION: '1.0.0',

  // قاعدة البيانات (إلزاميان على Vercel)
  TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL || '',
  TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN || '',

  // الحدود القابلة للضبط
  MAX_SOURCES: intEnv('MAX_SOURCES', 10),
  SOURCE_MAX_MB: intEnv('SOURCE_MAX_MB', 200),
  OUTPUT_MAX_MB: intEnv('OUTPUT_MAX_MB', 150),
  MAX_TOTAL_DURATION_SEC: intEnv('MAX_TOTAL_DURATION_SEC', 600),
  FFMPEG_PRESET: strEnv('FFMPEG_PRESET', 'medium'),

  // ثوابت التخزين والرفع
  UPLOAD_CHUNK_BYTES: 4 * MB,      // حجم جزء الرفع من الواجهة (أقل من حد 4.5MB في Vercel)
  BLOB_CHUNK_BYTES: 2 * MB,        // تقسيم كل Blob إلى صفوف 2MB (حد HTTP في Turso)
  READ_PAGE_ROWS: 8,               // قراءة الـ Blobs بصفحات من 8 صفوف
  RETENTION_HOURS: 24,             // حذف تلقائي بعد 24 ساعة

  // ترميز الفيديو
  VIDEO_FPS: 30,
  MAX_WIDTH: 1920,
  MAX_HEIGHT: 1080,
  CRF: 18,
  AUDIO_BITRATE: '192k',
  AUDIO_RATE: 44100,

  // الامتدادات المسموحة للملفات المرفوعة
  ALLOWED_EXTENSIONS: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpg', 'mpeg', '3gp'],
};

module.exports = { CONFIG, loadDotEnv };
