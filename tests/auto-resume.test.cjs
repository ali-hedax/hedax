/* The browser half of the hands-off flow: a fetch that hits a missing session
   must wait for the user's sign-in and then carry on by itself, in order, and
   without re-running what already succeeded.
   The companion is faked; no browser, no network, no credentials. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness');

const app = loadApp();
const ctx = app.__context;

function res(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
/* handlers: { login, state, report, sync } — value or function(callCount) */
function fakeCompanion(handlers) {
  const calls = [];
  ctx.fetch = async (url, opts) => {
    const route = String(url).split('/').pop();
    calls.push(route);
    if (route === 'session') return res({ token: 'run-token', version: 1, build: 'test', browser: 'chrome' });
    const h = handlers[route];
    const out = typeof h === 'function' ? await h(calls.filter((c) => c === route).length) : h;
    if (out instanceof Error) return res({ message: out.message, code: out.code }, out.status || 502);
    return res(out === undefined ? {} : out);
  };
  return calls;
}
const loginRequired = () => Object.assign(new Error('باید وارد شوید'), { code: 'LOGIN_REQUIRED', status: 401 });

test.beforeEach(() => { app.B2BGate.configure({ pollMs: 5, maxWaitMs: 4000 }); });

test('a job that works is run once and never waits', async () => {
  const calls = fakeCompanion({});
  let runs = 0;
  const out = await app.B2BGate.guard(async () => { runs++; return 'done'; });
  assert.equal(out, 'done');
  assert.equal(runs, 1);
  assert.deepEqual(calls, [], 'no companion call should be needed');
  assert.equal(app.B2BGate.waiting(), false);
});

test('a missing session brings the window forward, waits, then retries the same job', async () => {
  const calls = fakeCompanion({ login: { message: 'sign in please' }, state: (n) => (n >= 3 ? { ready: true } : { ready: false, reason: 'LOGIN_FORM' }) });
  let runs = 0;
  const waits = [];
  const out = await app.B2BGate.guard(async () => {
    runs++;
    if (runs === 1) throw loginRequired();
    return 'fetched';
  }, (text) => waits.push(text));

  assert.equal(out, 'fetched');
  assert.equal(runs, 2, 'the same job must be retried exactly once');
  assert.equal(calls.filter((c) => c === 'login').length, 1, 'the window is brought forward once');
  assert.ok(calls.filter((c) => c === 'state').length >= 3, 'it polls until the sign-in shows');
  assert.equal(waits.length, 1);
  assert.match(waits[0], /وارد B2B شوید/);
  assert.equal(app.B2BGate.waiting(), false);
});

test('the wait text never asks the user to press anything afterwards', async () => {
  assert.match(app.B2BGate.WAIT_TEXT, /پس از ورود خودکار ادامه پیدا می‌کند/);
  assert.equal(/وارد شدم|دریافت مجدد/.test(app.B2BGate.WAIT_TEXT), false);
});

test('an error that is not about the session is passed straight through', async () => {
  const calls = fakeCompanion({});
  let runs = 0;
  await assert.rejects(
    app.B2BGate.guard(async () => { runs++; throw Object.assign(new Error('فیلتر تأیید نشد'), { code: 'FILTER_MISMATCH' }); }),
    /فیلتر تأیید نشد/
  );
  assert.equal(runs, 1, 'a real failure must not be retried');
  assert.deepEqual(calls, []);
});

test('if the browser cannot start, that is reported instead of waiting forever', async () => {
  fakeCompanion({ login: Object.assign(new Error('مرورگر اجرا نشد'), { code: 'BROWSER_START_FAILED' }) });
  await assert.rejects(
    app.B2BGate.guard(async () => { throw loginRequired(); }),
    /مرورگر اجرا نشد/
  );
  assert.equal(app.B2BGate.waiting(), false);
});

test('two stalled jobs share one wait and one window', async () => {
  const calls = fakeCompanion({ login: { message: 'x' }, state: (n) => ({ ready: n >= 2 }) });
  const runs = { a: 0, b: 0 };
  const job = (k) => app.B2BGate.guard(async () => { runs[k]++; if (runs[k] === 1) throw loginRequired(); return k; });
  const [a, b] = await Promise.all([job('a'), job('b')]);
  assert.equal(a, 'a');
  assert.equal(b, 'b');
  assert.equal(calls.filter((c) => c === 'login').length, 1, 'only one window is brought forward');
});

test('a session that expires midway stops the run and resumes without redoing the finished work', async () => {
  const calls = fakeCompanion({ login: { message: 'x' }, state: (n) => ({ ready: n >= 2 }) });
  const runs = [];
  // three jobs in a queue: the second loses the session
  let secondAttempts = 0;
  const jobs = [
    () => { runs.push('alef'); return 'alef'; },
    () => { runs.push('b'); if (++secondAttempts === 1) throw loginRequired(); return 'b'; },
    () => { runs.push('p'); return 'p'; },
  ];
  const done = [];
  for (const j of jobs) done.push(await app.B2BGate.guard(async () => j()));

  assert.deepEqual(done, ['alef', 'b', 'p']);
  assert.deepEqual(runs, ['alef', 'b', 'b', 'p'], 'only the interrupted job re-runs, and order is kept');
  assert.equal(runs.filter((r) => r === 'alef').length, 1, 'a finished report is never fetched again');
  assert.equal(calls.filter((c) => c === 'login').length, 1);
});

test('waiting for a sign-in that never happens ends with a clear message', async () => {
  app.B2BGate.configure({ pollMs: 5, maxWaitMs: 60 });
  fakeCompanion({ login: { message: 'x' }, state: { ready: false, reason: 'LOGIN_FORM' } });
  await assert.rejects(app.B2BGate.guard(async () => { throw loginRequired(); }), /طولانی شد/);
  app.B2BGate.configure({ pollMs: 5, maxWaitMs: 4000 });
});

test('a companion hiccup during polling is treated as "not yet", not as a failure', async () => {
  let n = 0;
  fakeCompanion({
    login: { message: 'x' },
    state: () => { n++; if (n < 3) throw new TypeError('connection lost'); return { ready: true }; },
  });
  let runs = 0;
  const out = await app.B2BGate.guard(async () => { runs++; if (runs === 1) throw loginRequired(); return 'ok'; });
  assert.equal(out, 'ok');
  assert.ok(n >= 3);
});

/* ---------- the daily cadence for نوبت‌دهی ---------- */

function nobatReport(scope, fetchedAt) {
  return {
    id: 'r1', scopeKey: app.nobatScopeKey(scope), revision: 1, dateKey: scope.dateKey,
    statusFilter: scope.statusFilter, hall: scope.hall, source: 'b2b', fetchedAt,
    receivedAt: fetchedAt, records: [], rowCount: 0, contentHash: 'h', fileName: 'f.xlsx',
  };
}

test('today\'s نوبت‌دهی report is not downloaded twice on the same day', () => {
  const now = new Date('2026-09-26T09:00:00Z');
  const today = app.operationsToday(now).dateKey;
  const scope = { dateKey: today, statusFilter: 'همه', hall: 'سالن تعمیرات' };
  app.STATE.nobat.reports = [];
  assert.equal(app.nobatDue(scope, now).due, true, 'nothing stored yet');

  app.STATE.nobat.reports = [nobatReport(scope, now.valueOf() - 3600000)];
  const again = app.nobatDue(scope, now);
  assert.equal(again.due, false);
  assert.match(again.reason, /امروز دریافت شده/);

  // the next day the same scope key is a different date, so it is due again
  const tomorrow = new Date(now.valueOf() + 86400000);
  const tomorrowScope = { ...scope, dateKey: app.operationsToday(tomorrow).dateKey };
  assert.equal(app.nobatDue(tomorrowScope, tomorrow).due, true);
  app.STATE.nobat.reports = [];
});

test('a report the user typed in by hand does not satisfy the automatic cadence', () => {
  const now = new Date('2026-09-26T09:00:00Z');
  const scope = { dateKey: app.operationsToday(now).dateKey, statusFilter: 'همه', hall: 'سالن تعمیرات' };
  const manual = nobatReport(scope, now.valueOf());
  delete manual.source;
  app.STATE.nobat.reports = [manual];
  assert.equal(app.nobatDue(scope, now).due, true);
  app.STATE.nobat.reports = [];
});

test('a different filter or hall is its own report and is due on its own', () => {
  const now = new Date('2026-09-26T09:00:00Z');
  const today = app.operationsToday(now).dateKey;
  const scope = { dateKey: today, statusFilter: 'همه', hall: 'سالن تعمیرات' };
  app.STATE.nobat.reports = [nobatReport(scope, now.valueOf())];
  assert.equal(app.nobatDue({ ...scope, hall: 'سرویس سریع' }, now).due, true);
  assert.equal(app.nobatDue({ ...scope, statusFilter: 'در حال تعمیر' }, now).due, true);
  app.STATE.nobat.reports = [];
});

/* ---------- the cadences the brief asks to keep ---------- */

test('the agreed cadences are unchanged', () => {
  const now = new Date('2026-09-26T09:00:00Z');
  const fresh = (ms) => ({ meta: { origin: 'b2b', receivedAt: now.valueOf() - ms } });
  // reception: weekly
  assert.equal(app.operationDue('t', fresh(6 * 86400000), now).due, false);
  assert.equal(app.operationDue('t', fresh(8 * 86400000), now).due, true);
  // امداد and DPLAN: once the month turns
  assert.equal(app.operationDue('p', fresh(3 * 86400000), now).due, false);
  assert.equal(app.operationDue('b', fresh(3 * 86400000), now).due, false);
  assert.equal(app.operationDue('b', fresh(60 * 86400000), now).due, true);
  // inventory: whenever its section opens
  assert.equal(app.operationDue('alef', fresh(3 * 86400000), now).due, true);
  // a manual press overrides the cadence
  assert.equal(app.operationDue('t', fresh(1 * 86400000), now, true).due, true);
});

test('امداد waits for 10am Tehran and becomes due afterwards on its own', () => {
  const before = new Date('2026-09-26T05:00:00Z'); // 08:30 Tehran
  const after = new Date('2026-09-26T07:30:00Z');  // 11:00 Tehran
  assert.equal(app.operationsToday(before).hour < 10, true);
  const waiting = app.operationDue('p', null, before);
  assert.equal(waiting.due, false);
  assert.match(waiting.reason, /ساعت ۱۰ صبح/);
  assert.equal(app.operationDue('p', null, after).due, true);
});
