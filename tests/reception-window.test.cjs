/* The reception report covers the last seven days, not the year.

   It used to start at 1 Farvardin and walk the whole year in weekly parts just
   to reach the current week. Now the default window is today in Tehran plus the
   six days before it, and earlier windows are kept rather than overwritten.
   Synthetic only — no browser, no network, no dealership data. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness');
const ops = require('../companion/operations.cjs');

const app = loadApp();
const key = (jdn) => { const j = app.JAL.d2j(jdn); return app.jalaliKey(j.jy, j.jm, j.jd); };
const jdnOf = (k) => app.receptionDate(k).jdn;
// Values built inside the page's vm realm are not reference-equal to plain ones.
const plain = (v) => JSON.parse(JSON.stringify(v));

/* ---------- the window itself ---------- */

test('the default reception scope is today and the six days before it', () => {
  const now = new Date('2026-09-26T09:00:00Z');
  const today = app.operationsToday(now).dateKey;
  const scope = app.operationsScope('t', now);
  assert.equal(scope.sourceId, 't');
  assert.equal(scope.toDate, today);
  assert.equal(jdnOf(scope.toDate) - jdnOf(scope.fromDate), 6, 'seven days, both ends included');
  assert.equal(scope.fromDate, key(jdnOf(today) - 6));
  // never the start of the year
  assert.equal(/\/01\/01$/.test(scope.fromDate), false);
});

test('a chosen end date takes the six days before that date', () => {
  for (const end of ['1405/07/04', '1405/01/03', '1405/07/01', '1404/12/29']) {
    const scope = app.receptionWeekScope(end);
    assert.equal(scope.toDate, end);
    assert.equal(jdnOf(end) - jdnOf(scope.fromDate), 6, 'window for ' + end);
  }
});

test('a window crossing a month boundary is computed correctly', () => {
  const scope = app.receptionWeekScope('1405/07/04');
  assert.equal(scope.fromDate, '1405/06/29', 'Shahrivar has 31 days');
  assert.equal(app.receptionPartitions(scope.fromDate, scope.toDate).length, 1);
});

test('a window crossing Nowruz is computed correctly', () => {
  const scope = app.receptionWeekScope('1405/01/03');
  // 1404 was a leap year, so Esfand had 30 days
  assert.equal(jdnOf('1405/01/03') - jdnOf(scope.fromDate), 6);
  assert.equal(scope.fromDate.startsWith('1404/12/'), true, scope.fromDate);
});

test('an invalid end date is refused instead of guessed', () => {
  assert.throws(() => app.receptionWeekScope('1405/13/01'));
  assert.throws(() => app.receptionWeekScope(''));
});

test('the other sources keep their own ranges', () => {
  const now = new Date('2026-09-26T09:00:00Z');
  const t = app.operationsToday(now);
  assert.deepEqual(plain(app.operationsScope('alef', now)), { sourceId: 'alef', dateKey: t.dateKey, warehouse: 'انبار قطعات ولوازم یدکی' });
  assert.deepEqual(plain(app.operationsScope('b', now)), { sourceId: 'b', dateKey: t.dateKey, year: t.year });
  // امداد still runs from the start of the year
  assert.deepEqual(plain(app.operationsScope('p', now)), { sourceId: 'p', fromDate: t.year + '/01/01', toDate: t.dateKey });
});

test('the weekly cadence and the manual override are unchanged', () => {
  const now = new Date('2026-09-26T09:00:00Z');
  const fresh = (ms) => ({ meta: { origin: 'b2b', receivedAt: now.valueOf() - ms } });
  assert.equal(app.operationDue('t', fresh(6 * 86400000), now).due, false);
  assert.equal(app.operationDue('t', fresh(8 * 86400000), now).due, true);
  assert.equal(app.operationDue('t', fresh(1 * 86400000), now, true).due, true, 'the manual button fetches now');
});

/* ---------- the companion agrees ---------- */

test('the companion accepts the window the dashboard asks for', () => {
  const now = new Date();
  const scope = app.operationsScope('t', now);
  const asked = { ...scope, part: true };
  assert.deepEqual(ops.validateOperation(asked, now), asked);
});

test('the companion no longer demands a range starting at the new year', () => {
  const now = new Date();
  const days = ops.recentDays(now, 30);
  // a week that ended a fortnight ago is still a valid window
  const older = { sourceId: 't', fromDate: days[20], toDate: days[14], part: true };
  assert.deepEqual(ops.validateOperation(older, now), older);
});

test('the companion refuses more than seven days, the future, and a reversed range', () => {
  const now = new Date();
  const days = ops.recentDays(now, 30);
  const bad = [
    { sourceId: 't', fromDate: days[7], toDate: days[0], part: true },      // eight days
    { sourceId: 't', fromDate: days[0], toDate: days[6], part: true },      // reversed
    { sourceId: 't', fromDate: days[6], toDate: days[0] },                  // no part flag
    { sourceId: 't', fromDate: '1399/01/01', toDate: '1399/01/07', part: true }, // far outside the window
  ];
  for (const input of bad) assert.throws(() => ops.validateOperation(input, now), { code: 'INVALID_SCOPE' }, JSON.stringify(input));
});

test('امداد, موجودی and DPLAN validation is untouched', () => {
  const now = new Date();
  const t = ops.today(now);
  assert.doesNotThrow(() => ops.validateOperation({ sourceId: 'alef', dateKey: t.date, warehouse: ops.WAREHOUSE }, now));
  assert.doesNotThrow(() => ops.validateOperation({ sourceId: 'b', dateKey: t.date, year: t.year }, now));
  const emdad = { sourceId: 'p', fromDate: t.year + '/01/01', toDate: t.date };
  if (t.hour >= 10) assert.doesNotThrow(() => ops.validateOperation(emdad, now));
  else assert.throws(() => ops.validateOperation(emdad, now), { code: 'REPORT_NOT_READY' });
});

/* ---------- history is kept across windows ---------- */

const row = (card, dateKey, extra = {}) => ({ cardNo: card, admissionDate: dateKey, createdAt: dateKey + ' 08:00', status: 'در حال تعمیر', receptionist: 'پذیرشگر آزمایشی', ...extra });

test('a new window merges into the stored cards instead of replacing them', () => {
  const older = [row('C1', '1405/06/20'), row('C2', '1405/06/21')];
  const fresh = [row('C3', '1405/07/01'), row('C4', '1405/07/02')];
  const merged = app.mergeReceptionRecords(older, fresh);
  assert.equal(merged.length, 4, 'earlier weeks survive');
  assert.deepEqual(plain(merged.map((r) => r.cardNo)).sort(), ['C1', 'C2', 'C3', 'C4']);
});

test('the same card seen again is updated, not counted twice', () => {
  const older = [row('C1', '1405/07/01', { status: 'در حال تعمیر' })];
  const fresh = [row('C1', '1405/07/01', { status: 'ترخیص شده', clearedDate: '1405/07/03' })];
  const merged = app.mergeReceptionRecords(older, fresh);
  assert.equal(merged.length, 1, 'one card, one entry');
  assert.equal(merged[0].status, 'ترخیص شده', 'the newest observation wins');
  assert.equal(merged[0].clearedDate, '1405/07/03');
});

test('the same card number in a different admission year stays separate', () => {
  const merged = app.mergeReceptionRecords([row('C1', '1404/07/01')], [row('C1', '1405/07/01')]);
  assert.equal(merged.length, 2);
});

/* ---------- coverage ---------- */

test('touching windows merge into one range and gaps stay gaps', () => {
  let cov = app.mergeReceptionCoverage([], { fromDate: '1405/06/29', toDate: '1405/07/04', receivedAt: 1 });
  assert.deepEqual(plain(cov), [{ fromDate: '1405/06/29', toDate: '1405/07/04', receivedAt: 1 }]);

  // the next week runs on from the previous one
  cov = app.mergeReceptionCoverage(cov, { fromDate: '1405/07/05', toDate: '1405/07/11', receivedAt: 2 });
  assert.equal(cov.length, 1, 'adjacent weeks become one span');
  assert.deepEqual(cov[0].fromDate + '..' + cov[0].toDate, '1405/06/29..1405/07/11');

  // a window with a gap before it stays separate
  cov = app.mergeReceptionCoverage(cov, { fromDate: '1405/08/01', toDate: '1405/08/07', receivedAt: 3 });
  assert.equal(cov.length, 2, 'a missed week is not filled in');
});

test('an overlapping window does not duplicate the range', () => {
  const cov = app.mergeReceptionCoverage([{ fromDate: '1405/06/29', toDate: '1405/07/04' }], { fromDate: '1405/07/02', toDate: '1405/07/08', receivedAt: 5 });
  assert.equal(cov.length, 1);
  assert.equal(cov[0].fromDate + '..' + cov[0].toDate, '1405/06/29..1405/07/08');
});

test('a day is covered only when a window actually reached it', () => {
  const source = { meta: { origin: 'b2b', coverage: [{ fromDate: '1405/06/29', toDate: '1405/07/04' }, { fromDate: '1405/08/01', toDate: '1405/08/07' }] } };
  assert.equal(app.receptionCovers(source, '1405/07/02'), true);
  assert.equal(app.receptionCovers(source, '1405/08/03'), true);
  assert.equal(app.receptionCovers(source, '1405/07/20'), false, 'a gap between windows is unknown, not zero');
  assert.equal(app.receptionCovers(source, '1405/06/01'), false);
  // a snapshot from before coverage existed still works off its own range
  assert.equal(app.receptionCovers({ meta: { origin: 'b2b', fromDate: '1405/06/29', toDate: '1405/07/04' } }, '1405/07/01'), true);
});

test('the coverage label lists the real ranges', () => {
  const label = app.receptionCoverageLabel({ coverage: [{ fromDate: '1405/06/29', toDate: '1405/07/04' }, { fromDate: '1405/08/01', toDate: '1405/08/07' }] });
  assert.match(label, /1405\/06\/29 تا 1405\/07\/04/);
  assert.match(label, /1405\/08\/01 تا 1405\/08\/07/);
});

/* ---------- the monthly chart only shows months that were fetched ---------- */

test('months without a fetched window are left out rather than shown as zero', () => {
  const records = [row('C1', '1405/07/01'), row('C2', '1405/07/02')];
  const stats = app.computeReceptionStats(records, '1405/07/04');
  const meta = { origin: 'b2b', coverage: [{ fromDate: '1405/06/29', toDate: '1405/07/04' }] };
  const flow = app.receptionFlow(stats, '1405/07/04', meta);
  assert.deepEqual(plain(flow.months.map((m) => m.label)), ['شهریور', 'مهر'], 'only the two months the window touches');
  assert.equal(flow.coveredMonths, 2);
  assert.equal(flow.admissions, 2);
});

test('with no coverage recorded the chart falls back to every month', () => {
  const stats = app.computeReceptionStats([row('C1', '1405/07/01')], '1405/07/04');
  assert.equal(app.receptionFlow(stats, '1405/07/04', null).months.length, 7);
});
