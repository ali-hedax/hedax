/* The kept copy of each B2B report.

   Chrome shows a UUID name and "Removed" for these downloads because Playwright
   saves to a random temporary path and the companion deletes it once the bytes
   are read. That is expected. These checks cover the copy that replaces it: a
   meaningful name, an extension that matches the real bytes, pruning, and a read
   path that cannot escape the archive directory. Synthetic data only. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const archive = require('../companion/archive.cjs');
const SSML = require('./fixtures-ssml');
const FX = require('./fixtures');

async function tmpRoot() { return fs.mkdtemp(path.join(os.tmpdir(), 'hedax-archive-')); }
const htmlTable = Buffer.from('<html><body><table><tr><td>a</td></tr></table></body></html>', 'utf8');

test('the real format is read from the bytes, not from the name B2B used', () => {
  assert.equal(archive.detectFormat(FX.sampleWorkbook()), 'zip');
  assert.equal(archive.detectFormat(SSML.reception()), 'spreadsheetml');
  assert.equal(archive.detectFormat(htmlTable), 'html');
  assert.equal(archive.detectFormat(Buffer.from('not a report', 'utf8')), 'unknown');
});

test('the kept name carries the report, the range, the time and the true format', async () => {
  const root = await tmpRoot();
  try {
    const scope = { sourceId: 't', fromDate: '1405/07/01', toDate: '1405/07/07', part: true };
    const kept = await archive.keep({ root, sourceId: 't', scope, bytes: SSML.reception(), at: Date.parse('2026-09-26T12:15:00') });
    assert.equal(kept.saved, true);
    assert.match(kept.name, /^t-/);
    assert.match(kept.name, /1405-07-01_1405-07-07/);
    assert.match(kept.name, /spreadsheetml/);
    // .xls, because that is what Excel opens Excel-2003-XML from — but the name
    // still says spreadsheetml, so it is never mistaken for an OLE2 workbook.
    assert.match(kept.name, /\.xls$/);
    assert.equal(kept.format, 'spreadsheetml');
    const onDisk = await fs.readFile(path.join(archive.dir(root), kept.name));
    assert.equal(onDisk.length, SSML.reception().length, 'the copy must be byte-identical');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an xlsx report keeps the xlsx extension', async () => {
  const root = await tmpRoot();
  try {
    const kept = await archive.keep({ root, sourceId: 'n', scope: { dateKey: '1405/07/04', statusFilter: 'همه', hall: 'سالن تعمیرات' }, bytes: FX.sampleWorkbook() });
    assert.match(kept.name, /^n-1405-07-04-/);
    assert.match(kept.name, /zip\.xlsx$/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('the download object is used when there is one, so nothing is copied twice', async () => {
  const root = await tmpRoot();
  try {
    let savedTo = null;
    const download = { saveAs: async (p) => { savedTo = p; await fs.writeFile(p, FX.sampleWorkbook()); } };
    const kept = await archive.keep({ root, download, sourceId: 'n', scope: { dateKey: '1405/07/04' }, bytes: FX.sampleWorkbook() });
    assert.equal(kept.saved, true);
    assert.equal(savedTo, path.join(archive.dir(root), kept.name));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a name that tries to escape the directory is flattened', () => {
  assert.equal(archive.safePart('../../etc/passwd', 'x').includes('/'), false);
  assert.equal(archive.safePart('..\\..\\windows', 'x').includes('\\'), false);
  assert.equal(archive.safePart('..', 'fallback'), 'fallback');
  assert.equal(archive.safePart('', 'fallback'), 'fallback');
  assert.equal(archive.safePart('a\u0000b', 'x'), 'ab');
});

test('only the newest few copies per report are kept', async () => {
  const root = await tmpRoot();
  try {
    for (let i = 0; i < archive.KEEP_PER_SOURCE + 3; i++) {
      await archive.keep({ root, sourceId: 't', scope: { fromDate: '1405/07/0' + (i % 9 + 1), toDate: '1405/07/0' + (i % 9 + 1) }, bytes: SSML.reception(), at: Date.now() + i * 1000 });
      await new Promise((r) => setTimeout(r, 12)); // distinct mtimes
    }
    const files = await archive.list(root);
    assert.equal(files.filter((f) => f.sourceId === 't').length, archive.KEEP_PER_SOURCE);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('pruning one report never touches another report', async () => {
  const root = await tmpRoot();
  try {
    await archive.keep({ root, sourceId: 'n', scope: { dateKey: '1405/07/04' }, bytes: FX.sampleWorkbook() });
    for (let i = 0; i < archive.KEEP_PER_SOURCE + 2; i++) {
      await archive.keep({ root, sourceId: 'alef', scope: { dateKey: '1405/07/0' + (i % 9 + 1) }, bytes: htmlTable, at: Date.now() + i * 1000 });
      await new Promise((r) => setTimeout(r, 12));
    }
    const files = await archive.list(root);
    assert.equal(files.filter((f) => f.sourceId === 'n').length, 1);
    assert.equal(files.filter((f) => f.sourceId === 'alef').length, archive.KEEP_PER_SOURCE);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('reading is limited to files the listing actually shows', async () => {
  const root = await tmpRoot();
  try {
    const kept = await archive.keep({ root, sourceId: 'n', scope: { dateKey: '1405/07/04' }, bytes: FX.sampleWorkbook() });
    const good = await archive.read(root, kept.name);
    assert.equal(good.name, kept.name);
    assert.equal(Buffer.from(good.base64, 'base64').length, FX.sampleWorkbook().length);
    for (const bad of ['../../../package.json', '..\\..\\package.json', 'nope.xlsx', '', 'n-']) {
      assert.equal(await archive.read(root, bad), null, 'must refuse: ' + bad);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a failure to archive never fails the report itself', async () => {
  // no root at all
  const noRoot = await archive.keep({ root: '', sourceId: 't', scope: {}, bytes: SSML.reception() });
  assert.equal(noRoot.saved, false);
  assert.equal(noRoot.reason, 'NO_ROOT');
  assert.equal(noRoot.format, 'spreadsheetml', 'the format is still reported');
  // a download that refuses to save
  const root = await tmpRoot();
  try {
    const kept = await archive.keep({ root, download: { saveAs: async () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); } }, sourceId: 't', scope: {}, bytes: SSML.reception() });
    assert.equal(kept.saved, false);
    assert.equal(kept.reason, 'EACCES');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an empty archive lists nothing instead of failing', async () => {
  const root = await tmpRoot();
  try {
    assert.deepEqual(await archive.list(root), []);
    assert.equal(await archive.read(root, 'anything'), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('the archive route lists and returns a kept file, and refuses without the token', async () => {
  const { createServer } = require('../companion/server.cjs');
  const root = await tmpRoot();
  const port = 5193;
  const kept = await archive.keep({ root, sourceId: 'n', scope: { dateKey: '1405/07/04' }, bytes: FX.sampleWorkbook() });
  const server = createServer({ client: { channel: 'chrome' }, port, root });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const session = await (await fetch(`http://localhost:${port}/api/b2b/session`)).json();
    const post = (body, token = session.token) => fetch(`http://localhost:${port}/api/b2b/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hedax-Token': token, Origin: `http://localhost:${port}` },
      body: JSON.stringify(body),
    });
    const listed = await (await post({})).json();
    assert.equal(listed.files.length, 1);
    assert.equal(listed.files[0].name, kept.name);
    assert.equal(listed.keepPerSource, archive.KEEP_PER_SOURCE);

    const file = await (await post({ name: kept.name })).json();
    assert.equal(Buffer.from(file.base64, 'base64').length, FX.sampleWorkbook().length);

    assert.equal((await post({ name: '../package.json' })).status, 404);
    assert.equal((await post({}, 'wrong-token')).status, 403);
  } finally { server.close(); await fs.rm(root, { recursive: true, force: true }); }
});
