/* Excel 2003 XML (SpreadsheetML) reader.

   The B2B «تعمیرات خودرو» export arrives named .xls but is this format, so the
   dashboard used to reject it before column mapping ever ran. These checks
   drive the real shipped reader out of `index (4).html` — no separate parser.
   All data here is synthetic. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness');
const SSML = require('./fixtures-ssml');
const FX = require('./fixtures');

const app = loadApp();
const file = (buf, name) => new app.__context.File([buf], name);
const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

test('the format is recognised from content, not from the file name', () => {
  assert.equal(app.sniffFormat(ab(SSML.reception())).kind, 'spreadsheetml');
  assert.equal(app.sniffFormat(ab(SSML.receptionDeclared())).kind, 'spreadsheetml');
  // a name that claims xlsx must not change the verdict
  assert.equal(app.sniffFormat(ab(SSML.merged())).kind, 'spreadsheetml');
  assert.equal(app.sniffFormat(ab(FX.sampleWorkbook())).kind, 'zip');
});

test('a reception-shaped export reaches buildRecords through the normal pipeline', async () => {
  const res = await app.ingestFile('t', file(SSML.reception(), 'b2b-t.xls'));
  assert.equal(res.ok, true, res.diag && res.diag.errorMessage);
  assert.equal(res.needsManualMap, undefined);
  const E = SSML.T_EXPECTED;
  assert.equal(res.diag.rawRowCount, E.rawRows);
  assert.equal(res.records.length, E.valid);
  assert.equal(res.diag.rejectedRowCount, E.rejected);
  assert.equal(res.diag.pickedSheet, 'لیست پذیرش ها');
  assert.equal(res.diag.grid[res.diag.headerRowIndex].length, E.columns);
  assert.equal(new Set(res.records.map((r) => app.normKey(r.cardNo))).size, E.uniqueCards);
  assert.equal(res.records.filter((r) => app.parseFlexDate(r.clearedDate).valid).length, E.cleared);
  assert.equal(new Set(res.records.map((r) => app.normKey(r.receptionist))).size, E.receptionists);
});

test('the reception model keeps receptionist, halls and statuses', async () => {
  const res = await app.ingestFile('t', file(SSML.reception(), 'b2b-t.xls'));
  const first = res.records[0];
  assert.ok(Object.prototype.hasOwnProperty.call(first, 'receptionist'));
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'advisor'), false);
  // receptionist is a grouping key, so it passes through the app's Persian
  // normalisation (آ→ا, Persian digits→Latin); compare on that same basis
  assert.equal(app.normKey(first.receptionist), app.normKey('پذیرشگر آزمایشی ۱'));
  assert.equal(first.hall, 'سالن تعمیرات');
  assert.equal(first.status, 'در حال تعمیر');
  assert.equal(app.parseFlexDate(first.admissionDate).valid, true);
});

test('the blank line before the XML declaration and bare ampersands are repaired', async () => {
  const res = await app.ingestFile('t', file(SSML.reception(), 'b2b-t.xls'));
  assert.ok(res.diag.repairs.some((n) => n.includes('اعلان XML')), JSON.stringify(res.diag.repairs));
  assert.ok(res.diag.repairs.some((n) => n.includes('&')), JSON.stringify(res.diag.repairs));
  // the repaired text must read back as the original characters
  assert.ok(res.records[0].productDesc.includes('ABS&ESC'), res.records[0].productDesc);
});

test('valid entities are decoded once and never double escaped', async () => {
  const res = await app.ingestFile('t', file(SSML.reception(), 'b2b-t.xls'));
  assert.equal(res.records[1].customerNotes, 'سرویس دوره ای & بازدید');
  assert.ok(!res.records[1].customerNotes.includes('&amp;'));
  assert.ok(res.records[4].productDesc.endsWith('ی'), res.records[4].productDesc);
});

test('a file with no irregularities reports no repairs', async () => {
  const res = await app.ingestFile('t', file(SSML.receptionDeclared(), 'clean.xls'));
  assert.equal(res.ok, true);
  assert.equal(res.records.length, SSML.T_EXPECTED.valid);
  assert.ok(!res.diag.repairs || !res.diag.repairs.some((n) => n.includes('اعلان XML')));
});

test('identifiers stay text: leading zeros and long digits survive', async () => {
  const res = await app.ingestFile('t', file(SSML.identifiers(), 'ids.xls'));
  assert.equal(res.ok, true, res.diag && res.diag.errorMessage);
  assert.equal(res.records.length, 2);
  assert.equal(res.records[0].cardNo, '0000123456');
  assert.equal(res.records[0].plate, '11الف111-11');
  // declared as Number in the file, but it does not round-trip, so it stays text
  assert.equal(res.records[1].cardNo, '900700100200300400');
  assert.ok(!/e\+/i.test(res.records[1].cardNo));
  assert.equal(res.records[1].finalAmount, 2500);
});

test('ss:Index places cells without shifting the columns around them', async () => {
  const sheets = app.parseSpreadsheetMlNative(SSML.merged().toString('utf8'));
  const rows = sheets[0].rows;
  assert.deepEqual(Array.from(rows[0]), ['الف', 'ب', 'ج', 'د', 'ه', 'و']);
  // third row writes only columns 2 and 5 (1-based) — the rest stay empty in place
  assert.deepEqual(Array.from(rows[2]), ['', 'دوم', '', '', 'پنجم', '']);
});

test('ss:MergeAcross does not shift the columns that follow', async () => {
  const rows = app.parseSpreadsheetMlNative(SSML.merged().toString('utf8'))[0].rows;
  // "یک" spans two columns, so "سه" must land in column 3, not column 2
  assert.equal(rows[1][0], 'یک');
  assert.equal(rows[1][1], '');
  assert.equal(rows[1][2], 'سه');
  assert.equal(rows[1][5], 'شش');
});

test('the totals row keeps its column positions and is rejected, not merged in', async () => {
  const res = await app.ingestFile('t', file(SSML.reception(), 'b2b-t.xls'));
  const totals = res.diag.grid[res.diag.grid.length - 1];
  assert.equal(totals.length, SSML.T_EXPECTED.columns);
  assert.equal(totals[2], 'جمع');           // ss:Index="3" -> zero-based 2
  assert.equal(totals[11], '5,230,000');    // ss:Index="12" -> zero-based 11
  assert.equal(totals[0], '');
  assert.equal(res.diag.rejectedRowCount, 1);
  assert.ok(res.records.every((r) => r.cardNo !== 'جمع'));
});

test('a stored value is read and its formula is never evaluated', async () => {
  const rows = app.parseSpreadsheetMlNative(SSML.formula().toString('utf8'))[0].rows;
  assert.equal(rows[1][0], 2);
  assert.equal(rows[1][1], 3);
  assert.equal(rows[1][2], '5');            // the stored String, not a computed number
});

test('a truly empty report is distinguishable from a mapping failure', async () => {
  const res = await app.ingestFile('t', file(SSML.empty(), 'empty.xls'));
  assert.equal(res.ok, false);
  assert.equal(res.needsManualMap, undefined);
  assert.match(res.diag.errorMessage, /خالی/);
});

test('rows with headers this source does not know ask for manual mapping', async () => {
  const res = await app.ingestFile('t', file(SSML.wrongHeaders(), 'other.xls'));
  assert.equal(res.ok, false);
  assert.equal(res.needsManualMap, true);
  assert.equal(res.diag.errorMessage, null);
});

test('a well-formed XML that is not a workbook is reported clearly', async () => {
  const res = await app.ingestFile('t', file(SSML.noWorksheet(), 'notawb.xls'));
  assert.equal(res.ok, false);
  assert.match(res.diag.errorMessage, /Worksheet|شیت/);
});

test('unrecoverable XML raises a clear error instead of a partial table', async () => {
  const res = await app.ingestFile('t', file(SSML.broken(), 'broken.xls'));
  assert.equal(res.ok, false);
  assert.equal(res.needsManualMap, undefined);
  assert.match(res.diag.errorMessage, /XML/);
  assert.equal(res.records, undefined);
});

test('a failed read does not disturb the next successful read', async () => {
  await app.ingestFile('t', file(SSML.broken(), 'broken.xls'));
  const res = await app.ingestFile('t', file(SSML.reception(), 'b2b-t.xls'));
  assert.equal(res.ok, true);
  assert.equal(res.records.length, SSML.T_EXPECTED.valid);
});

/* ---------- formats that already worked must keep working ---------- */

test('the nobat xlsx reader is unaffected', async () => {
  const res = await app.ingestFile('n', file(FX.sampleWorkbook(), 'nobat.xlsx'));
  assert.equal(res.ok, true, res.diag && res.diag.errorMessage);
  assert.equal(res.records.length, FX.EXPECTED.rowCount);
  assert.equal(app.computeNobatStats(res.records).uniqueCards, FX.EXPECTED.uniqueCards);
});

test('the inventory HTML table is still detected as html (full parse is covered in the browser test)', async () => {
  const html = Buffer.from(`<html><head><meta charset="utf-8"></head><body><table>
    <tr><th>کد کالا</th><th>شرح کالا</th><th>موجودی</th><th>قیمت فروش</th></tr>
    <tr><td>A-100</td><td>قطعهٔ آزمایشی الف</td><td>5</td><td>250000</td></tr>
    <tr><td>A-101</td><td>قطعهٔ آزمایشی ب</td><td>0</td><td>310000</td></tr>
  </table></body></html>`, 'utf8');
  assert.equal(app.sniffFormat(ab(html)).kind, 'html');
  // parseHtmlTableGrid needs querySelectorAll, which the minimal Node shim does
  // not provide; tests/e2e-browser.js exercises this path in a real browser.
});

test('OLE2 is still refused instead of being claimed as read', async () => {
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
  assert.equal(app.sniffFormat(ab(ole)).kind, 'ole2');
  const res = await app.ingestFile('t', file(ole, 'old.xls'));
  assert.equal(res.ok, false);
  assert.match(res.diag.errorMessage, /OLE2/);
});

test('an unknown format is still refused', async () => {
  const txt = Buffer.from('این فایل گزارش نیست', 'utf8');
  const res = await app.ingestFile('t', file(txt, 'notes.txt'));
  assert.equal(res.ok, false);
  assert.match(res.diag.errorMessage, /شناسایی نشد/);
});
