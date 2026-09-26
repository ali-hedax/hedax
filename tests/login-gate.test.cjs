/* The hands-off sign-in flow on the companion side: the passive probe, the
   wait message, and the promise that a probe never disturbs the page while the
   user is typing a password or a captcha.
   No browser, no network, no credentials — the Playwright surface is faked. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { B2BClient, LOGIN_WAIT_MESSAGE } = require('../companion/b2b.cjs');

/* Records every call so a test can assert what the probe did NOT do. */
function fakePage(url, { passwordVisible = false, closed = false, throwOnVisible = false } = {}) {
  const calls = [];
  return {
    calls,
    url: () => url,
    isClosed: () => closed,
    goto: (u) => { calls.push(['goto', u]); return Promise.resolve(); },
    reload: () => { calls.push(['reload']); return Promise.resolve(); },
    bringToFront: () => { calls.push(['bringToFront']); return Promise.resolve(); },
    setDefaultTimeout() {},
    locator: (sel) => ({
      first: () => ({
        isVisible: async () => {
          calls.push(['isVisible', sel]);
          if (throwOnVisible) throw new Error('page is navigating');
          return passwordVisible;
        },
      }),
    }),
  };
}
function clientWith(page) {
  const c = new B2BClient({ profileDir: 'unused', channel: 'chrome' });
  c.context = page ? { on() {}, pages: () => [page] } : null;
  c.page = page;
  return c;
}

test('with no window open the probe reports closed and launches nothing', async () => {
  const c = clientWith(null);
  const s = await c.state();
  assert.equal(s.ready, false);
  assert.equal(s.browser, 'closed');
  assert.equal(s.reason, 'NO_WINDOW');
  assert.equal(c.context, null, 'the probe must not open a browser');
});

test('a visible password field means not signed in', async () => {
  const page = fakePage('https://b2b.isaco.ir/Login', { passwordVisible: true });
  const s = await clientWith(page).state();
  assert.equal(s.ready, false);
  assert.equal(s.reason, 'LOGIN_FORM');
});

test('a B2B page with no password field is treated as ready to retry', async () => {
  const page = fakePage('https://b2b.isaco.ir/home');
  const s = await clientWith(page).state();
  assert.equal(s.ready, true);
  assert.equal(s.path, '/home');
});

test('a window parked on another site is not signed in', async () => {
  const s = await clientWith(fakePage('https://example.com/')).state();
  assert.equal(s.ready, false);
  assert.equal(s.reason, 'OFF_SITE');
});

test('a closed tab is not mistaken for a session', async () => {
  const s = await clientWith(fakePage('https://b2b.isaco.ir/home', { closed: true })).state();
  assert.equal(s.ready, false);
  assert.equal(s.reason, 'NO_WINDOW');
});

test('the probe never navigates, reloads or steals focus', async () => {
  for (const opts of [{}, { passwordVisible: true }, { throwOnVisible: true }]) {
    const page = fakePage('https://b2b.isaco.ir/Login', opts);
    await clientWith(page).state();
    const disturbing = page.calls.filter(([name]) => ['goto', 'reload', 'bringToFront'].includes(name));
    assert.deepEqual(disturbing, [], 'probe touched the page: ' + JSON.stringify(page.calls));
  }
});

test('a page that is mid-navigation is reported as not-yet, not as an error', async () => {
  const s = await clientWith(fakePage('https://b2b.isaco.ir/home', { throwOnVisible: true })).state();
  assert.equal(s.ready, true); // no evidence of a login form; the fetch will confirm
});

test('while a fetch is running the probe answers without touching the page', async () => {
  const page = fakePage('https://b2b.isaco.ir/PlanningReport');
  const c = clientWith(page);
  c.busy = true;
  const s = await c.state();
  assert.equal(s.busy, true);
  assert.equal(s.ready, true);
  assert.deepEqual(page.calls, [], 'a busy probe must not query the page');
});

test('login brings the existing window forward without re-navigating a B2B page', async () => {
  const page = fakePage('https://b2b.isaco.ir/Login', { passwordVisible: true });
  const c = clientWith(page);
  const r = await c.login();
  assert.equal(r.message, LOGIN_WAIT_MESSAGE);
  assert.ok(page.calls.some(([name]) => name === 'bringToFront'));
  assert.equal(page.calls.some(([name]) => name === 'goto'), false, 'must not reload a half-typed login form');
});

test('login does navigate when the window is parked somewhere else', async () => {
  const page = fakePage('https://example.com/');
  await clientWith(page).login();
  assert.ok(page.calls.some(([name, u]) => name === 'goto' && String(u).includes('b2b.isaco.ir')));
});

test('the wait message promises an automatic resume and asks for no button', () => {
  assert.match(LOGIN_WAIT_MESSAGE, /وارد B2B شوید/);
  assert.match(LOGIN_WAIT_MESSAGE, /خودکار ادامه/);
  assert.equal(/دکمه|دوباره دریافت را بزنید/.test(LOGIN_WAIT_MESSAGE), false);
});

test('every LOGIN_REQUIRED path tells the user the same thing', async () => {
  const src = require('node:fs').readFileSync(require.resolve('../companion/b2b.cjs'), 'utf8')
    + require('node:fs').readFileSync(require.resolve('../companion/operations.cjs'), 'utf8');
  const literals = src.match(/LOGIN_REQUIRED'\s*,\s*'[^']*'/g) || [];
  assert.deepEqual(literals, [], 'LOGIN_REQUIRED should reuse LOGIN_WAIT_MESSAGE, found: ' + literals.join(' | '));
});

test('the probe route is reachable while signed out and never answers 401', async () => {
  const { createServer } = require('../companion/server.cjs');
  const client = clientWith(null);
  const server = createServer({ client, port: 5191 });
  await new Promise((r) => server.listen(5191, '127.0.0.1', r));
  try {
    const session = await (await fetch('http://localhost:5191/api/b2b/session')).json();
    const res = await fetch('http://localhost:5191/api/b2b/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hedax-Token': session.token, Origin: 'http://localhost:5191' },
      body: '{}',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ready, false);
    assert.equal(body.browser, 'closed');
  } finally { server.close(); }
});

test('the probe route still refuses a request without the run token', async () => {
  const { createServer } = require('../companion/server.cjs');
  const server = createServer({ client: clientWith(null), port: 5192 });
  await new Promise((r) => server.listen(5192, '127.0.0.1', r));
  try {
    const res = await fetch('http://localhost:5192/api/b2b/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5192' },
      body: '{}',
    });
    assert.equal(res.status, 403);
  } finally { server.close(); }
});
