'use strict';
/* Keeps a readable copy of each report B2B hands over, so a failure can be
   inspected without digging a UUID-named temporary out of Chrome's history.

   Playwright saves downloads to a random temporary path and HEDAX deletes that
   temporary once the bytes are read — which is why Chrome shows a UUID name and
   "Removed". That is expected and is not the failure; the copy kept here is the
   evidence. Copies live under .local, which git ignores, and are pruned so old
   reports cannot pile up. */
const fs = require('node:fs/promises');
const path = require('node:path');

const DIR = ['.local', 'report-archive'];
const KEEP_PER_SOURCE = 5;
const MAX_BYTES = 50 * 1024 * 1024;

/* The real format of the bytes, independent of what B2B named the file. */
function detectFormat(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) return 'zip';
  const head = bytes.subarray(0, 8192).toString('utf8');
  if (/urn:schemas-microsoft-com:office:spreadsheet/i.test(head) || /mso-application\s+progid="Excel\.Sheet"/i.test(head)) return 'spreadsheetml';
  if (/<(?:!doctype\s+html|html|table)\b/i.test(head) && !/<(?:input|form)\b/i.test(head)) return 'html';
  return 'unknown';
}
/* Excel opens all three from these extensions; the real format also goes in the
   name, so an .xls that is really Excel XML is never mistaken for OLE2. */
const EXT = { zip: '.xlsx', spreadsheetml: '.xls', html: '.xls', unknown: '.bin' };

/* One path segment: no separators, no traversal, no control characters. */
function safePart(value, fallback) {
  const s = String(value === null || value === undefined ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\.\.+/g, '.')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 48);
  return s || fallback;
}
function stamp(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
/* A name that says what the report is, which range it covers and what the bytes
   really are — e.g. t-1405-07-04_1405-07-04-20260926-121500-spreadsheetml.xls */
function archiveName({ sourceId, label, format, at }) {
  return [safePart(sourceId, 'report'), safePart(label, 'scope'), stamp(at), safePart(format, 'unknown')].join('-') + (EXT[format] || EXT.unknown);
}
/* A label for the range this report covers, used only for the file name. */
function scopeLabel(scope) {
  if (!scope || typeof scope !== 'object') return 'scope';
  if (scope.dateKey && !scope.sourceId) return String(scope.dateKey).replaceAll('/', '-');
  if (scope.fromDate && scope.toDate) return String(scope.fromDate).replaceAll('/', '-') + '_' + String(scope.toDate).replaceAll('/', '-');
  if (scope.dateKey) return String(scope.dateKey).replaceAll('/', '-');
  return 'scope';
}
function dir(root) { return path.join(root, ...DIR); }

async function prune(root, sourceId) {
  const base = dir(root);
  let names;
  try { names = await fs.readdir(base); } catch { return; }
  const mine = names.filter((n) => n.startsWith(safePart(sourceId, 'report') + '-'));
  if (mine.length <= KEEP_PER_SOURCE) return;
  const withTime = [];
  for (const n of mine) {
    try { withTime.push({ n, t: (await fs.stat(path.join(base, n))).mtimeMs }); } catch {}
  }
  withTime.sort((a, b) => b.t - a.t);
  for (const { n } of withTime.slice(KEEP_PER_SOURCE)) {
    await fs.rm(path.join(base, n), { force: true }).catch(() => {});
  }
}

/* Saves the copy. Never throws: losing the archive must not fail a report that
   was otherwise received correctly. Returns the entry, or null with a reason. */
async function keep({ root, download, sourceId, scope, bytes, at = Date.now() }) {
  const format = detectFormat(bytes);
  // Without a project root there is nowhere safe to write; the report itself is fine.
  if (!root) return { saved: false, reason: 'NO_ROOT', format };
  const name = archiveName({ sourceId, label: scopeLabel(scope), format, at });
  const base = dir(root);
  const target = path.join(base, name);
  try {
    if (bytes.length > MAX_BYTES) return { saved: false, reason: 'SIZE', format };
    await fs.mkdir(base, { recursive: true });
    // saveAs copies the download Playwright already has on disk; when a caller
    // has no download object (a replayed payload) the bytes are written instead.
    if (download && typeof download.saveAs === 'function') await download.saveAs(target);
    else await fs.writeFile(target, bytes);
    await prune(root, sourceId);
    return { saved: true, name, size: bytes.length, format, at };
  } catch (err) {
    return { saved: false, reason: err.code || 'WRITE_FAILED', format };
  }
}

async function list(root) {
  const base = dir(root);
  let names;
  try { names = await fs.readdir(base); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (n.includes('/') || n.includes('\\')) continue;
    try {
      const s = await fs.stat(path.join(base, n));
      if (s.isFile()) out.push({ name: n, size: s.size, savedAt: Math.round(s.mtimeMs), sourceId: n.split('-')[0] });
    } catch {}
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/* Reads one archived file by name. The name is matched against the listing
   rather than joined blindly, so nothing outside the archive can be read. */
async function read(root, name) {
  const entries = await list(root);
  const hit = entries.find((e) => e.name === name);
  if (!hit) return null;
  const bytes = await fs.readFile(path.join(dir(root), hit.name));
  return { name: hit.name, size: bytes.length, savedAt: hit.savedAt, base64: bytes.toString('base64') };
}

module.exports = { keep, list, read, detectFormat, archiveName, scopeLabel, safePart, dir, KEEP_PER_SOURCE, EXT };
