/* End-to-end check in a real browser: uploads a synthetic report through the
   page's own code, then reloads to prove IndexedDB survived the refresh.

   Run:  node tests/e2e-browser.js
         node tests/e2e-browser.js --chrome "C:\\path\\to\\chrome.exe"

   Skips (exit 0) when no Chrome is found, so it can sit alongside the unit
   tests without becoming a machine-specific hard requirement. */
"use strict";

const { openDashboard, WAIT_READY } = require("./cdp.cjs");
const FX = require("./fixtures");

async function main() {
  const page = await openDashboard(9333);
  if (!page) { console.log("Chrome یافت نشد — این آزمون رد شد (skip)."); return; }
  const evaluate = (_cdp, expr) => page.evaluate(expr);
  const cdp = page.cdp;

  let passed = 0, failed = 0;
  const ok = (name, cond, detail) => {
    if (cond) { passed++; console.log("  \u2713 " + name); }
    else { failed++; console.log("  \u2717 " + name + (detail ? " — " + detail : "")); }
  };

  try {
    ok("صفحه بارگذاری شد", await evaluate(cdp, "typeof handleNobatUpload === 'function'"));

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
    await page.reload();
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
    Object.keys(tabs).forEach((t) => ok("تب «" + t + "» بدون خطا رندر شد", tabs[t] === "ok", tabs[t]));
  } finally {
    page.close();
  }

  console.log(`\n${"=".repeat(52)}\nموفق: ${passed}   ناموفق: ${failed}`);
  if (failed) process.exit(1);
}


main().catch((e) => { console.error(e); process.exit(1); });
