'use strict';
/**
 * server.js — خادم تطوير محلي يحاكي بيئة Vercel:
 *  - يخدم public/index.html في الجذر.
 *  - يحلّل المسارات الديناميكية (/api/jobs/<id>/...) ويضعها في req.query مثل Vercel.
 *  - يعمل على المنفذ 3001 فقط.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

require('./lib/env'); // تحميل .env يدويًا

const PORT = 3001;
const PUBLIC_DIR = path.join(__dirname, 'public');

/* تحميل دوال Vercel مرة واحدة */
const handlers = {
  jobs: require('./api/jobs'),
  jobId: require('./api/jobs/[id]'),
  process: require('./api/jobs/[id]/process'),
  video: require('./api/jobs/[id]/video'),
  upload: require('./api/upload'),
  config: require('./api/config'),
  cron: require('./api/cron'),
};

/* التوجيه — الترتيب مهم: الأعمق أولًا */
const ROUTES = [
  { rx: /^\/api\/jobs\/([^/]+)\/video\/?$/, handler: handlers.video, param: 'id' },
  { rx: /^\/api\/jobs\/([^/]+)\/process\/?$/, handler: handlers.process, param: 'id' },
  { rx: /^\/api\/jobs\/([^/]+)\/?$/, handler: handlers.jobId, param: 'id' },
  { rx: /^\/api\/jobs\/?$/, handler: handlers.jobs },
  { rx: /^\/api\/upload\/?$/, handler: handlers.upload },
  { rx: /^\/api\/config\/?$/, handler: handlers.config },
  { rx: /^\/api\/cron\/?$/, handler: handlers.cron },
];

function serveIndex(res) {
  const file = path.join(PUBLIC_DIR, 'index.html');
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ملف الواجهة public/index.html غير موجود');
  }
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let pathname = '/';
  try {
    const parsed = new URL(req.url, `http://localhost:${PORT}`);
    pathname = parsed.pathname;

    // req.query مثل Vercel: معاملات الاستعلام + معاملات المسار الديناميكي
    const q = {};
    parsed.searchParams.forEach((v, k) => { q[k] = v; });

    let matched = null;
    let m = null;
    for (const r of ROUTES) {
      m = r.rx.exec(pathname);
      if (m) { matched = r; break; }
    }

    if (matched) {
      if (matched.param && m[1]) q[matched.param] = decodeURIComponent(m[1]);
      req.query = q;
      console.log(`[api] ${req.method} ${pathname} `);
      try {
        await matched.handler(req, res);
      } catch (e) {
        console.error('[handler-crash]', pathname, e);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        }
        if (!res.writableEnded) res.end(JSON.stringify({ error: 'حدث خطأ داخلي غير متوقع' }));
      }
      console.log(`[api] ${req.method} ${pathname} → ${res.statusCode} (${Date.now() - started}ms)`);
      return;
    }

    if (pathname === '/' || pathname === '/index.html') return serveIndex(res);
    if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'المسار غير موجود' }));
    console.log(`[404] ${req.method} ${pathname}`);
  } catch (e) {
    console.error('[server-error]', pathname, e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    if (!res.writableEnded) res.end(JSON.stringify({ error: 'حدث خطأ داخلي في الخادم' }));
  }
});

server.listen(PORT, () => {
  console.log(`✅ خادم تطوير «دمج الفيديوهات» يعمل على http://localhost:${PORT}`);
  console.log(`   الواجهة: http://localhost:${PORT}/  |  API: http://localhost:${PORT}/api/config`);
});
