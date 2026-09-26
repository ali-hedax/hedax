/* Retrieving an export when the browser window dies mid-transfer.

   Observed live against B2B: clicking «خروجی Excel» points a short-lived popup
   at the report host; the popup closes, the main page closes and the whole
   Chrome window goes down before the transfer finishes. Playwright then reports
   "Target page, context or browser has been closed" and no bytes arrive.

   Because the export is a plain GET, the address and the session cookies are
   captured before the click and the file is fetched directly when that happens.
   Everything here is synthetic — no browser, no network, no real cookie. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { captureExport, cookieHeaderFor, CLOSED_TARGET } = require('../companion/export.cjs');
const FX = require('./fixtures');

const fail = (code, message) => Object.assign(new Error(message), { code });
const CLOSED = 'Target page, context or browser has been closed';

/* A context/page/download just real enough to drive captureExport. */
function harness({ failureReason = null, url = 'https://b2brep.isaco.ir/Report/Show?id=1', cookies = [{ name: 'S', value: 'v', domain: '.isaco.ir' }], bytes = FX.sampleWorkbook(), tempPath = '/tmp/uuid-name' } = {}) {
  const log = [];
  const download = {
    url: () => url,
    suggestedFilename: () => 'res.xlsx',
    failure: async () => { log.push('failure'); return failureReason; },
    path: async () => { log.push('path'); return tempPath; },
    delete: async () => { log.push('delete'); },
  };
  const context = {
    cookies: async () => { log.push('cookies'); return cookies; },
    waitForEvent: async () => { log.push('waitForEvent'); return download; },
  };
  const page = { evaluate: async () => 'UA/1.0' };
  return {
    log, download,
    run: (over = {}) => captureExport({
      context, page, fail, timeout: 1000,
      click: async () => { log.push('click'); },
      readFile: async (p) => { log.push('readFile:' + p); return bytes; },
      ...over,
    }),
  };
}

test('a normal export is read from the download, with no session request', async () => {
  const h = harness();
  const out = await h.run();
  assert.equal(out.via, 'download');
  assert.equal(out.bytes.length, FX.sampleWorkbook().length);
  assert.equal(out.suggested, 'res.xlsx');
  assert.ok(h.log.includes('readFile:/tmp/uuid-name'));
  // cookies are captured up front, before the click, while the window is alive
  assert.ok(h.log.indexOf('cookies') < h.log.indexOf('click'));
});

test('the closed-window signature is recognised', () => {
  assert.equal(CLOSED_TARGET.test(CLOSED), true);
  assert.equal(CLOSED_TARGET.test('Target closed'), true);
  assert.equal(CLOSED_TARGET.test('net::ERR_FAILED'), false);
});

test('a download that failed for any other reason is a real failure', async () => {
  const h = harness({ failureReason: 'net::ERR_INTERNET_DISCONNECTED' });
  await assert.rejects(h.run(), (e) => e.code === 'DOWNLOAD_FAILED' && /ERR_INTERNET_DISCONNECTED/.test(e.message));
});

test('when the window dies the file is fetched from the captured address', async () => {
  const body = FX.sampleWorkbook();
  const seen = { cookie: null, ua: null, path: null };
  const server = http.createServer((req, res) => {
    seen.cookie = req.headers.cookie; seen.ua = req.headers['user-agent']; seen.path = req.url;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(body);
  });
  await new Promise((r) => server.listen(5194, '127.0.0.1', r));
  try {
    const h = harness({ failureReason: CLOSED, url: 'http://127.0.0.1:5194/Report/Show?id=7', cookies: [{ name: 'S', value: 'secret', domain: '127.0.0.1' }] });
    const out = await h.run();
    assert.equal(out.via, 'session');
    assert.equal(out.bytes.length, body.length);
    assert.equal(seen.cookie, 'S=secret');
    assert.equal(seen.ua, 'UA/1.0');
    assert.equal(seen.path, '/Report/Show?id=7');
  } finally { server.close(); }
});

test('a session fetch that is refused is reported, not silently retried', async () => {
  const server = http.createServer((req, res) => { res.writeHead(403); res.end('no'); });
  await new Promise((r) => server.listen(5195, '127.0.0.1', r));
  try {
    const h = harness({ failureReason: CLOSED, url: 'http://127.0.0.1:5195/x', cookies: [{ name: 'S', value: 'v', domain: '127.0.0.1' }] });
    await assert.rejects(h.run(), (e) => e.code === 'DOWNLOAD_FAILED' && /HTTP 403/.test(e.message));
  } finally { server.close(); }
});

test('without a usable session the failure says so instead of guessing', async () => {
  const h = harness({ failureReason: CLOSED, cookies: [{ name: 'S', value: 'v', domain: 'unrelated.example' }] });
  await assert.rejects(h.run(), (e) => e.code === 'DOWNLOAD_FAILED' && /نشست معتبری/.test(e.message));
});

test('without an address the failure says so too', async () => {
  const h = harness({ failureReason: CLOSED, url: '' });
  h.download.url = () => '';
  await assert.rejects(h.run(), (e) => e.code === 'DOWNLOAD_FAILED' && /نشانی خروجی/.test(e.message));
});

test('cookies are matched to the export host, including a parent domain', () => {
  const jar = [
    { name: 'A', value: '1', domain: '.isaco.ir' },
    { name: 'B', value: '2', domain: 'b2brep.isaco.ir' },
    { name: 'C', value: '3', domain: 'other.example' },
  ];
  const header = cookieHeaderFor('https://b2brep.isaco.ir/Report/Show', jar);
  assert.equal(header, 'A=1; B=2');
  assert.equal(cookieHeaderFor('https://elsewhere.example/x', jar), '');
  assert.equal(cookieHeaderFor('https://isaco.ir/x', jar), 'A=1');
});

test('a cookie for a lookalike domain is not sent', () => {
  const jar = [{ name: 'A', value: '1', domain: 'isaco.ir' }];
  assert.equal(cookieHeaderFor('https://evil-isaco.ir/x', jar), '');
  assert.equal(cookieHeaderFor('https://sub.isaco.ir/x', jar), 'A=1');
});

test('the temporary file is removed on every failure path', async () => {
  // a download that failed outright
  const plain = harness({ failureReason: 'net::ERR_FAILED' });
  await assert.rejects(plain.run());
  assert.ok(plain.log.includes('delete'), 'a failed download must not leave its temporary behind');

  // the window closed and there is no usable session either
  const noSession = harness({ failureReason: CLOSED, cookies: [{ name: 'S', value: 'v', domain: 'unrelated.example' }] });
  await assert.rejects(noSession.run());
  assert.ok(noSession.log.includes('delete'));

  // the window closed and the session fetch was refused
  const server = http.createServer((req, res) => { res.writeHead(500); res.end('x'); });
  await new Promise((r) => server.listen(5196, '127.0.0.1', r));
  try {
    const refused = harness({ failureReason: CLOSED, url: 'http://127.0.0.1:5196/x', cookies: [{ name: 'S', value: 'v', domain: '127.0.0.1' }] });
    await assert.rejects(refused.run());
    assert.ok(refused.log.includes('delete'));
  } finally { server.close(); }
});

test('a broken cookie jar does not stop a normal export', async () => {
  const h = harness();
  const out = await h.run({ context: { cookies: async () => { throw new Error('no cookies'); }, waitForEvent: async () => h.download } });
  assert.equal(out.via, 'download');
});
