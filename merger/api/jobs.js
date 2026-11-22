'use strict';
/**
 * api/jobs.js — POST /api/jobs: إنشاء مهمة دمج.
 * يقبل {"videos":["رابط1","رابط2"]} أو {"sources":[{"kind":"url"|"file", ...}]}.
 */
const db = require('../lib/db');
const { parseSourcesInput, buildCreateResponse } = require('../lib/jobs');
const { json, readJsonBody, methodNotAllowed, apiError, genId } = require('../lib/util');
const { cleanupLazy } = require('../lib/cleanup');

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST', 'OPTIONS']);

    const body = await readJsonBody(req);
    const sources = parseSourcesInput(body);

    // تنظيف كسول للمهام المنتهية عند كل طلب إنشاء
    cleanupLazy().catch(() => {});

    const jobId = genId();
    const job = await db.createJob(jobId, sources);
    const stored = await db.getJob(jobId);
    const srcRows = await db.getSources(jobId);
    return json(res, 201, buildCreateResponse(req, stored || job, srcRows));
  } catch (err) {
    return apiError(res, err);
  }
};

module.exports.handler = module.exports;
