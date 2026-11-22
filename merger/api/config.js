'use strict';
/**
 * api/config.js — GET /api/config: الحدود العامة + version.
 */
const { json, setCors, methodNotAllowed, apiError } = require('../lib/util');
const { CONFIG } = require('../lib/env');

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET', 'OPTIONS']);
    setCors(res);
    return json(res, 200, {
      version: CONFIG.VERSION,
      maxSources: CONFIG.MAX_SOURCES,
      sourceMaxMB: CONFIG.SOURCE_MAX_MB,
      outputMaxMB: CONFIG.OUTPUT_MAX_MB,
      maxTotalDurationSec: CONFIG.MAX_TOTAL_DURATION_SEC,
      ffmpegPreset: CONFIG.FFMPEG_PRESET,
      uploadChunkBytes: CONFIG.UPLOAD_CHUNK_BYTES,
      blobChunkBytes: CONFIG.BLOB_CHUNK_BYTES,
      retentionHours: CONFIG.RETENTION_HOURS,
      videoFps: CONFIG.VIDEO_FPS,
      maxWidth: CONFIG.MAX_WIDTH,
      maxHeight: CONFIG.MAX_HEIGHT,
      allowedExtensions: CONFIG.ALLOWED_EXTENSIONS,
    });
  } catch (err) {
    return apiError(res, err);
  }
};

module.exports.handler = module.exports;
