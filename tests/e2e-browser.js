/* End-to-end check in a real browser: uploads a synthetic report through the
   page's own code, then reloads to prove IndexedDB survived the refresh.

   Run:  node tests/e2e-browser.js
         node tests/e2e-browser.js --chrome "C:\\path\\to\\chrome.exe"

   Skips (exit 0) when no Chrome is found, so it can sit alongside the unit
   tests without becoming a machine-specific hard requirement. */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const FX = require("./fixtures");

const APP = path.join(__dirname, "..", "index (4).html");

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

function findChrome() {
  const i = process.argv.indexOf("--chrome");
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1];
  return CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
}

function fileUrl(p) {
  return "file:///" + path.resolve(p).replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "$1").split("/").map(encodeURIComponent).join("/").replace("%3A", ":");
}

async function waitForTarget(port, tries) {
  for (let i = 0; i < (tries || 50); i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Chrome DevTools endpoint did not come up");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });
    ws.addEventListener("error", (e) => reject(new Error("devtools socket error")));
    ws.addEventListener("open", () => resolve({
      send(method, params) {
        return new Promise((res, rej) => { const n = ++id; pending.set(n, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
      },
      close() { ws.close(); },
    }));
  });
}

async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

/* waits until the page's own init has run */
const WAIT_READY = `new Promise((res) => { const t = setInterval(() => { if (typeof STATE !== "undefined" && typeof handleNobatUpload === "function") { clearInterval(t); res(true); } }, 50); setTimeout(() => { clearInterval(t); res(false); }, 10000); })`;

async function main() {
  const chrome = findChrome();
  if (!chrome) { console.log("Chrome یافت نشد — این آزمون رد شد (skip)."); return; }

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "hedax-e2e-"));
  const port = 9333;
  const proc = spawn(chrome, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--allow-file-access-from-files",
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`,
    fileUrl(APP),
  ], { stdio: "ignore" });

  let passed = 0, failed = 0;
  const ok = (name, cond, detail) => {
    if (cond) { passed++; console.log("  \u2713 " + name); }
    else { failed++; console.log("  \u2717 " + name + (detail ? " — " + detail : "")); }
  };

  let cdp;
  try {
    const target = await waitForTarget(port);
    cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    ok("صفحه بارگذاری شد", await evaluate(cdp, WAIT_READY));

    const b64 = FX.sampleWorkbook().toString("base64");
    const E = FX.EXPECTED;

    // بارگذاری اول
    const first = await evaluate(cdp, `(async () => {
      const bin = atob("${b64}");
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], "nobat-e2e.xlsx");
      switchTab("nobat");
      await handleNobatUpload(file, { dateKey: "1404/01/15", jy: 1404, jm: 1, jd: 15, dateLabel: "۱۵ فروردین ۱۴۰۴", statusFilter: "همه", hall: "سالن تعمیرات" });
      await new Promise((r) => setTimeout(r, 300));
      const rep = activeNobatReport();
      if (!rep) return { reports: STATE.nobat.reports.length, status: document.querySelector("#upcard-n .upload-status").textContent, diag: document.querySelector("#upcard-n .diag-slot").textContent.slice(0, 500) };
      const s = computeNobatStats(rep.records);
      return { reports: STATE.nobat.reports.length, rows: s.rowCount, cards: s.uniqueCards, noCard: s.rowsWithoutCard, turns: s.uniqueTurns, html: document.getElementById("nobatBody").innerHTML.length };
    })()`);
    ok("یک گزارش ثبت شد", first.reports === 1, JSON.stringify(first));
    ok("تعداد ردیف درست است", first.rows === E.rowCount, String(first.rows));
    ok("کارت یکتا درست است", first.cards === E.uniqueCards, String(first.cards));
    ok("ردیف بدون کارت درست است", first.noCard === E.rowsWithoutCard, String(first.noCard));
    ok("نوبت یکتا درست است", first.turns === E.uniqueTurns, String(first.turns));
    ok("بخش نوبت‌دهی رندر شد", first.html > 2000, String(first.html));

    // بارگذاری تکراری همان فایل با همان تاریخ/فیلتر
    const dup = await evaluate(cdp, `(async () => {
      const bin = atob("${b64}");
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await handleNobatUpload(new File([bytes], "nobat-e2e.xlsx"), { dateKey: "1404/01/15", jy: 1404, jm: 1, jd: 15, dateLabel: "۱۵ فروردین ۱۴۰۴", statusFilter: "همه", hall: "سالن تعمیرات" });
      await new Promise((r) => setTimeout(r, 300));
      const s = computeNobatStats(activeNobatReport().records);
      return { reports: STATE.nobat.reports.length, rows: s.rowCount, status: document.querySelector("#upcard-n .upload-status").textContent };
    })()`);
    ok("بارگذاری تکراری گزارش جدید نساخت", dup.reports === 1, JSON.stringify(dup.reports));
    ok("تعداد ردیف دو برابر نشد", dup.rows === E.rowCount, String(dup.rows));
    ok("پیام تکراری‌بودن نشان داده شد", /قبلاً بارگذاری شده/.test(dup.status || ""), dup.status);

    // فایل نامعتبر: آخرین دادهٔ معتبر باید بماند
    const bad = await evaluate(cdp, `(async () => {
      const file = new File([new TextEncoder().encode("این فایل اکسل نیست")], "bad.txt");
      await handleNobatUpload(file, { dateKey: "1404/01/16", jy: 1404, jm: 1, jd: 16, dateLabel: "۱۶ فروردین ۱۴۰۴", statusFilter: "همه", hall: "سالن تعمیرات" });
      await new Promise((r) => setTimeout(r, 300));
      return { reports: STATE.nobat.reports.length, rows: computeNobatStats(activeNobatReport().records).rowCount, status: document.querySelector("#upcard-n .upload-status").textContent, cls: document.querySelector("#upcard-n .upload-status").className };
    })()`);
    ok("فایل نامعتبر ذخیره نشد", bad.reports === 1, String(bad.reports));
    ok("آخرین دادهٔ معتبر حفظ شد", bad.rows === E.rowCount, String(bad.rows));
    ok("خطای روشن نمایش داده شد", /error/.test(bad.cls) && (bad.status || "").length > 15, bad.status);

    // تازه‌سازی صفحه: داده باید از IndexedDB برگردد
    await cdp.send("Page.reload");
    await new Promise((r) => setTimeout(r, 1200));
    const after = await evaluate(cdp, `(async () => {
      await ${WAIT_READY};
      await new Promise((r) => setTimeout(r, 800));
      switchTab("nobat");
      const rep = activeNobatReport();
      if (!rep) return { reports: STATE.nobat.reports.length, restored: false };
      const s = computeNobatStats(rep.records);
      return { reports: STATE.nobat.reports.length, restored: true, rows: s.rowCount, cards: s.uniqueCards, noCard: s.rowsWithoutCard, date: rep.dateKey, file: rep.fileName, html: document.getElementById("nobatBody").innerHTML.length };
    })()`);
    ok("پس از تازه‌سازی داده برگشت", after.restored === true, JSON.stringify(after));
    if (after.restored) {
      ok("تعداد گزارش‌ها پس از تازه‌سازی", after.reports === 1, String(after.reports));
      ok("تعداد ردیف پس از تازه‌سازی", after.rows === E.rowCount, String(after.rows));
      ok("کارت یکتا پس از تازه‌سازی", after.cards === E.uniqueCards, String(after.cards));
      ok("ردیف بدون کارت پس از تازه‌سازی", after.noCard === E.rowsWithoutCard, String(after.noCard));
      ok("تاریخ گزارش پس از تازه‌سازی", after.date === "1404/01/15", after.date);
      ok("بخش نوبت‌دهی پس از تازه‌سازی رندر شد", after.html > 2000, String(after.html));
    }

    // بخش‌های قبلی باید هنوز بدون خطا رندر شوند
    const tabs = await evaluate(cdp, `(() => {
      const out = {};
      for (const t of Object.keys(TAB_RENDERERS)) {
        try { switchTab(t); out[t] = "ok"; } catch (e) { out[t] = "ERROR: " + e.message; }
      }
      return out;
    })()`);
    Object.keys(tabs).forEach((t) => ok("تب «" + TABNAME(t) + "» بدون خطا رندر شد", tabs[t] === "ok", tabs[t]));
  } finally {
    if (cdp) cdp.close();
    proc.kill();
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log(`\n${"=".repeat(52)}\nموفق: ${passed}   ناموفق: ${failed}`);
  if (failed) process.exit(1);
}

function TABNAME(t) { return t; }

main().catch((e) => { console.error(e); process.exit(1); });
