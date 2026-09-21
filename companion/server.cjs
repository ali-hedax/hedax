'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {B2BClient, validateScope} = require('./b2b.cjs');
const ROOT = path.resolve(__dirname, '..');
function createServer({client, port=5173, root=ROOT} = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const hosts = new Set(['localhost:' + port, '127.0.0.1:' + port]);
  const origins = new Set([...hosts].map(h=>'http://' + h));
  const json = (res, status, body) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(body)); };
  return http.createServer(async (req, res) => {
    try {
      if (!hosts.has(req.headers.host)) return json(res,403,{message:'Host rejected'});
      if (req.headers.origin && !origins.has(req.headers.origin)) return json(res,403,{message:'Origin rejected'});
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res,403,{message:'Cross-site rejected'});
      const url = new URL(req.url,'http://localhost:' + port);
      if (req.method === 'GET' && url.pathname === '/api/b2b/session') return json(res,200,{token,version:1});
      if (req.method === 'POST' && ['/api/b2b/sync','/api/b2b/login','/api/b2b/report'].includes(url.pathname)) {
        if (req.headers['x-hedax-token'] !== token || !origins.has(req.headers.origin)) return json(res,403,{message:'Request rejected'});
        if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res,415,{message:'JSON required'});
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4096) return json(res,413,{message:'Request too large'}); }
        let input; try { input = JSON.parse(body || '{}'); } catch { return json(res,400,{message:'Invalid JSON'}); }
        if (url.pathname.endsWith('/sync')) {
          const scope = validateScope(input);
          return json(res,200,await client.sync(scope));
        }
        if(url.pathname.endsWith('/report')) return json(res,200,await client.report(require('./operations.cjs').validateOperation(input)));
        return json(res,200,await client.login());
      }
      if (req.method === 'GET' && ['/', '/index.html', '/index%20(4).html'].includes(url.pathname)) {
        const html = await fs.readFile(path.join(root,'index (4).html'));
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}); return res.end(html);
      }
      return json(res,404,{message:'Not found'});
    } catch (err) {
      return json(res,err.code === 'BUSY' ? 409 : err.code === 'INVALID_SCOPE' ? 400 : err.code === 'LOGIN_REQUIRED' ? 401 : 502,
        {code:err.code || 'COMPANION_ERROR', message:err.code ? err.message : 'همراه محلی آماده نیست. اجرای برنامه و مرورگر Edge را بررسی کنید.'});
    }
  });
}
if (require.main === module) {
  const port = Number(process.env.HEDAX_PORT || 5173);
  const profileDir = process.env.HEDAX_PROFILE_DIR || path.join(ROOT,'.local','b2b-profile');
  const client = new B2BClient({profileDir, channel:process.env.HEDAX_BROWSER_CHANNEL || 'msedge'});
  const server = createServer({client,port});
  server.requestTimeout = 180000;
  server.on('error', err => { console.error(err.code === 'EADDRINUSE' ? 'Port is already in use. Close the old HEDAX preview first.' : 'HEDAX server could not start.'); process.exitCode=1; });
  server.listen(port,'127.0.0.1',()=>console.log('HEDAX: http://localhost:' + port + '/'));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async()=>{ server.close(); await client.close(); process.exit(0); });
}
module.exports = {createServer};
