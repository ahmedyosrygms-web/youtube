'use strict';
/**
 * lib/db.js — عميل Turso (libSQL) + المخطط + عمليات المهام.
 * كل شيء يُخزَّن في Turso: المهام، بيانات المصادر، أجزاء المصادر المرفوعة، والفيديو الناتج.
 */
const { createClient } = require('@libsql/client');
const { ApiError } = require('./util');
const { CONFIG } = require('./env');

let _client = null;
let _schemaPromise = null;

function getClient() {
  if (_client) return _client;
  const url = CONFIG.TURSO_DATABASE_URL;
  if (!url) {
    throw new ApiError(500, 'متغير البيئة TURSO_DATABASE_URL غير مضبوط — راجع خطوات النشر في README');
  }
  const opts = { url };
  if (CONFIG.TURSO_AUTH_TOKEN && !url.startsWith('file:')) opts.authToken = CONFIG.TURSO_AUTH_TOKEN;
  _client = createClient(opts);
  return _client;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  output_size INTEGER,
  output_duration REAL,
  output_resolution TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  url TEXT,
  name TEXT,
  mime TEXT,
  size INTEGER,
  total_chunks INTEGER,
  uploaded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, seq)
);
CREATE TABLE IF NOT EXISTS source_chunks (
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  chunk INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (job_id, seq, chunk)
);
CREATE TABLE IF NOT EXISTS output_chunks (
  job_id TEXT NOT NULL,
  chunk INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (job_id, chunk)
);
`;

function ensureSchema() {
  if (_schemaPromise) return _schemaPromise;
  _schemaPromise = getClient().executeMultiple(SCHEMA_SQL).catch((e) => {
    _schemaPromise = null;
    throw e;
  });
  return _schemaPromise;
}

async function ready() {
  await ensureSchema();
}

/* ---------------------------------- المهام ---------------------------------- */

const VALID_STATUS = ['queued', 'uploading', 'processing', 'done', 'failed'];

/**
 * إنشاء مهمة جديدة مع مصادرها في دفعة واحدة.
 * sources: [{kind:'url'|'file', url?, name?, mime?, size?, totalChunks?}]
 */
async function createJob(jobId, sources) {
  await ready();
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + CONFIG.RETENTION_HOURS * 3600 * 1000).toISOString();
  const status = sources.some((s) => s.kind === 'file') ? 'uploading' : 'queued';

  const stmts = [
    {
      sql: 'INSERT INTO jobs (id, status, progress, created_at, expires_at) VALUES (?, ?, 0, ?, ?)',
      args: [jobId, status, createdAt, expiresAt],
    },
  ];
  sources.forEach((s, seq) => {
    stmts.push({
      sql: `INSERT INTO sources (job_id, seq, kind, url, name, mime, size, total_chunks, uploaded)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      args: [jobId, seq, s.kind, s.url || null, s.name || null, s.mime || null, s.size ?? null, s.totalChunks ?? null],
    });
  });
  await getClient().batch(stmts, 'write');
  return { id: jobId, status, createdAt, expiresAt };
}

async function getJob(jobId) {
  await ready();
  const rs = await getClient().execute({
    sql: 'SELECT * FROM jobs WHERE id = ?',
    args: [jobId],
  });
  return rs.rows.length ? rs.rows[0] : null;
}

async function getSources(jobId) {
  await ready();
  const rs = await getClient().execute({
    sql: 'SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC',
    args: [jobId],
  });
  return rs.rows;
}

/** تحديث حقول المهمة بشكل ديناميكي. */
async function updateJob(jobId, fields) {
  await ready();
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const setSql = keys.map((k) => `${k} = ?`).join(', ');
  await getClient().execute({
    sql: `UPDATE jobs SET ${setSql} WHERE id = ?`,
    args: [...keys.map((k) => fields[k]), jobId],
  });
}

async function setJobStatus(jobId, status, extra = {}) {
  return updateJob(jobId, { status, ...extra });
}

/* ------------------------- أجزاء المصادر المرفوعة ------------------------- */

async function upsertSourceChunk(jobId, seq, chunkIndex, data) {
  await ready();
  await getClient().execute({
    sql: `INSERT INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)
          ON CONFLICT (job_id, seq, chunk) DO UPDATE SET data = excluded.data`,
    args: [jobId, seq, chunkIndex, data],
  });
}

async function countSourceChunks(jobId, seq) {
  const rs = await getClient().execute({
    sql: 'SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM source_chunks WHERE job_id = ? AND seq = ?',
    args: [jobId, seq],
  });
  return { count: Number(rs.rows[0].c), bytes: Number(rs.rows[0].bytes) };
}

async function getSourceChunkPage(jobId, seq, fromChunk, toChunk, limit) {
  const rs = await getClient().execute({
    sql: `SELECT chunk, data FROM source_chunks
          WHERE job_id = ? AND seq = ? AND chunk >= ? AND chunk <= ?
          ORDER BY chunk ASC LIMIT ?`,
    args: [jobId, seq, fromChunk, toChunk, limit],
  });
  return rs.rows;
}

/** تحديث عداد البايتات المرفوعة للمصدر (للعرض في الواجهة). */
async function updateSourceProgress(jobId, seq, uploadedBytes) {
  await getClient().execute({
    sql: 'UPDATE sources SET uploaded = ? WHERE job_id = ? AND seq = ?',
    args: [Number(uploadedBytes) || 0, jobId, seq],
  });
}

/** هل اكتمل رفع كل ملفات المهمة؟ */
async function allSourcesUploaded(jobId) {
  const sources = await getSources(jobId);
  const fileSources = sources.filter((s) => s.kind === 'file');
  for (const s of fileSources) {
    const { count } = await countSourceChunks(jobId, Number(s.seq));
    if (count < Number(s.total_chunks || 0)) return false;
  }
  return true;
}

/* ------------------------------ تخزين الناتج ------------------------------ */

/**
 * تخزين الفيديو الناتج: تقسيمه إلى صفوف BLOB_CHUNK_BYTES (2MB) في output_chunks.
 * يُكتب صفًا صفًا لتجنب تجاوز حدود HTTP في Turso.
 */
async function putOutputBlob(jobId, buffer, onProgress) {
  await ready();
  const total = buffer.length;
  const rows = Math.ceil(total / CONFIG.BLOB_CHUNK_BYTES) || 1;
  for (let i = 0; i < rows; i += 1) {
    const data = buffer.subarray(i * CONFIG.BLOB_CHUNK_BYTES, Math.min((i + 1) * CONFIG.BLOB_CHUNK_BYTES, total));
    await getClient().execute({
      sql: 'INSERT INTO output_chunks (job_id, chunk, data) VALUES (?, ?, ?)',
      args: [jobId, i, data],
    });
    if (onProgress) onProgress(i + 1, rows);
  }
  return rows;
}

/** قراءة صفحات من output_chunks (صفحات من READ_PAGE_ROWS صفوف) للتدفق. */
async function getOutputChunkPage(jobId, fromChunk, toChunk, limit) {
  await ready();
  const rs = await getClient().execute({
    sql: `SELECT chunk, data FROM output_chunks
          WHERE job_id = ? AND chunk >= ? AND chunk <= ?
          ORDER BY chunk ASC LIMIT ?`,
    args: [jobId, fromChunk, toChunk, limit],
  });
  return rs.rows;
}

async function countOutputChunks(jobId) {
  await ready();
  const rs = await getClient().execute({
    sql: 'SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM output_chunks WHERE job_id = ?',
    args: [jobId],
  });
  return { count: Number(rs.rows[0].c), bytes: Number(rs.rows[0].bytes) };
}

/* -------------------------------- الحذف -------------------------------- */

/** حذف كل صفوف المهمة (jobs + sources + source_chunks + output_chunks) في batch واحد. */
async function deleteJobData(jobId) {
  await ready();
  await getClient().batch([
    { sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [jobId] },
    { sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [jobId] },
    { sql: 'DELETE FROM sources WHERE job_id = ?', args: [jobId] },
    { sql: 'DELETE FROM jobs WHERE id = ?', args: [jobId] },
  ], 'write');
}

/** كل المهام المنتهية الصلاحية (expires_at <= الآن). */
async function findExpiredJobs() {
  await ready();
  const rs = await getClient().execute({
    sql: 'SELECT id FROM jobs WHERE expires_at <= ?',
    args: [new Date().toISOString()],
  });
  return rs.rows.map((r) => r.id);
}

/** حذف أجزاء المصادر بعد نجاح الدمج — الناتج فقط هو المطلوب. */
async function deleteSourceChunks(jobId) {
  await getClient().execute({ sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [jobId] });
}

module.exports = {
  getClient,
  ready,
  createJob,
  getJob,
  getSources,
  updateJob,
  setJobStatus,
  upsertSourceChunk,
  countSourceChunks,
  getSourceChunkPage,
  updateSourceProgress,
  allSourcesUploaded,
  putOutputBlob,
  getOutputChunkPage,
  countOutputChunks,
  deleteJobData,
  findExpiredJobs,
  deleteSourceChunks,
  VALID_STATUS,
};
