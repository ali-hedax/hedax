/* Loads the real dashboard source out of the single-file app and runs it in a
   Node vm with just enough browser surface to exercise the data layer.
   Tests therefore run against the code that actually ships, not a copy. */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { DOMParser } = require("./shims/dom-parser");

const APP_FILE = path.join(__dirname, "..", "index (4).html");

/* The names the tests reach for. They are `const`/`function` declarations inside
   the page's script blocks, so an explicit epilogue is what makes them visible. */
const EXPORTS = [
  "norm", "normKey", "normNum", "textCell", "parseJalaliInput", "jalaliKey", "JAL", "JMONTHS",
  "SOURCE_DEFS", "SOURCE_META", "mapColumnsByName", "autoMapColumns", "mapRequiredFields",
  "detectHeaderRow", "pickSheet", "buildRecords", "ingestFile", "parseXlsxNative", "readZip",
  "sniffFormat", "parseSpreadsheetMlNative", "repairSpreadsheetMlText", "decodeXmlText", "gridHasAnyValue", "parseFlexDate", "ssmlCellValue",
  "computeNobatStats", "nobatScopeKey", "nobatScopeLabel", "classifyIncomingReport",
  "latestPerScope", "revisionsOfScope", "hashBytes", "NobatStore", "buildNobatReport",
  "NOBAT_EMPTY_STATUS", "NOBAT_STATUS_ALL", "NOBAT_HALL_DEFAULT", "STATE",
  "B2BGate", "B2BRequests", "nobatDue", "operationDue", "operationsToday", "operationsScope", "OperationsSync", "B2BSync", "computeReceptionStats", "receptionFlow", "receptionCovers", "receptionDate", "receptionPartitions", "receptionWeekScope", "receptionCardKey", "mergeReceptionRecords", "mergeReceptionCoverage", "receptionCoverageSpans", "receptionCoverageLabel", "fetchReceptionWindow", "renderNobat", "renderReception", "renderDashboard", "activeNobatReport", "setActiveNobatSource", "fmtJalaliDateTime", "loadNobatFromStore", "TAB_RENDERERS", "TAB_TITLES",
];

function extractScripts(html) {
  const out = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  if (!out.length) throw new Error("no <script> blocks found in " + APP_FILE);
  return out;
}

function loadApp() {
  const html = fs.readFileSync(APP_FILE, "utf8");
  const blocks = extractScripts(html);

  const noop = () => {};
  const fakeEl = {
    innerHTML: "", textContent: "", className: "", style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, appendChild: noop, removeChild: noop, remove: noop, focus: noop, setAttribute: noop, getAttribute: () => null,
    querySelector: () => fakeEl, querySelectorAll: () => [], getElementsByTagName: () => [], clientWidth: 600,
  };
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    TextDecoder, TextEncoder, DataView, Uint8Array, ArrayBuffer, Blob, Response, File,
    DecompressionStream, CompressionStream, Promise, Math, JSON, Date, Intl,
    crypto: globalThis.crypto,
    AbortSignal, AbortController, fetch: globalThis.fetch, Response: globalThis.Response, URL, TypeError, SyntaxError,
    DOMParser,
    performance: { now: () => Date.now() },
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    matchMedia: () => ({ matches: false }),
    localStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })(),
    document: {
      addEventListener: noop, createElement: () => Object.create(fakeEl), body: Object.create(fakeEl),
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      documentElement: { setAttribute: noop },
    },
    indexedDB: undefined,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);
  const epilogue = "\n;globalThis.__hedax = { " + EXPORTS.map((k) => `${k}: typeof ${k} === "undefined" ? undefined : ${k}`).join(", ") + " };\n";
  vm.runInContext(blocks.join("\n;\n") + epilogue, context, { filename: "hedax-app.js" });

  const api = context.__hedax;
  const missing = EXPORTS.filter((k) => api[k] === undefined);
  if (missing.length) throw new Error("app symbols missing from the page: " + missing.join(", "));
  api.__context = context;
  return api;
}

module.exports = { loadApp, APP_FILE };
