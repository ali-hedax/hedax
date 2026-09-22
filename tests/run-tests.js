/* Test suite for the «نوبت‌دهی و برنامه تعمیرات» source and for keeping the
   existing sources intact.
   Run:  node tests/run-tests.js
   Optionally check a real export locally (never commit one):
         node tests/run-tests.js --real "<path to .xlsx>" --rows 79 --cards 47 --nocard 32 */
"use strict";

const fs = require("fs");
const { loadApp, APP_FILE } = require("./harness");
const { makeFakeIndexedDB } = require("./shims/fake-indexeddb");
const { makeDocument } = require("./shims/fake-dom");
const FX = require("./fixtures");

const app = loadApp();
let passed = 0, failed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), Object.is(actual, expected) ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { console.log("\n" + t); }

function fileOf(buf, name) { return new app.__context.File([buf], name); }
function statusCount(stats, label) {
  const r = stats.statusRows.find((x) => x.label === label);
  return r ? r.count : 0;
}

async function main() {
  const E = FX.EXPECTED;

  /* ---------------------------------------------------------------- */
  section("۱. خواندن فایل نمونهٔ ساختگی «گزارش نوبت دهی»");
  const res = await app.ingestFile("n", fileOf(FX.sampleWorkbook(), "nobat-sample.xlsx"));
  ok("فایل بدون خطا پردازش شد", res.ok === true, res.ok ? "" : JSON.stringify(res.diag && res.diag.errorMessage));
  eq("شیت انتخاب‌شده بر اساس نام", res.diag.pickedSheet, "گزارش نوبت دهی");
  eq("تعداد ردیف‌های داده", res.records.length, E.rowCount);

  const stats = app.computeNobatStats(res.records);
  eq("تعداد ردیف‌های گزارش", stats.rowCount, E.rowCount);
  eq("کارت‌های پذیرش یکتا", stats.uniqueCards, E.uniqueCards);
  eq("ردیف‌های بدون شماره کارت", stats.rowsWithoutCard, E.rowsWithoutCard);
  eq("نوبت‌های یکتا", stats.uniqueTurns, E.uniqueTurns);
  eq("ردیف‌های بدون شماره نوبت", stats.rowsWithoutTurn, E.rowsWithoutTurn);
  ok("ردیف‌های بدون شماره کارت حذف نشده‌اند",
    stats.rowCount === res.records.length && stats.rowsWithoutCard > 0);

  section("۲. توزیع وضعیت مراجعه");
  eq("وضعیت «" + FX.REPAIR + "»", statusCount(stats, FX.REPAIR), E.statuses[FX.REPAIR]);
  eq("وضعیت «" + FX.QUEUE + "»", statusCount(stats, FX.QUEUE), E.statuses[FX.QUEUE]);
  eq("وضعیت «" + FX.MOVE + "»", statusCount(stats, FX.MOVE), E.statuses[FX.MOVE]);
  eq("ردیف با وضعیت خالی جداگانه شمرده شد", statusCount(stats, app.NOBAT_EMPTY_STATUS), E.statuses.empty);
  eq("مجموع توزیع برابر تعداد ردیف‌هاست", stats.statusRows.reduce((s, r) => s + r.count, 0), E.rowCount);
  ok("مقدار خالی صفر تلقی نشده", stats.statusRows.some((r) => r.label === app.NOBAT_EMPTY_STATUS));

  section("۳. حفظ شناسه‌ها به‌صورت متن");
  eq("سلول عددی به نماد نمایی تبدیل نشد", res.records[6].cardNo, "1405000006");
  eq("ارقام فارسی به لاتین نرمال شد", res.records[1].cardNo, "1405000002");
  eq("فاصله‌های اضافی حذف شد", res.records[3].cardNo, "1405000003");
  ok("شماره کارت رشته است", typeof res.records[0].cardNo === "string");
  ok("شماره نوبت رشته است", typeof res.records[0].turnNo === "string");
  eq("شماره نوبت با ارقام فارسی", res.records[3].turnNo, "104");
  ok("پلاک دست‌نخورده باقی ماند", res.records[0].plate.includes("الف"));

  section("۴. ستون «جایگاه» به‌صورت مقدار خام");
  ok("مقدار جایگاه به‌صورت متن نگه داشته شد", res.records[0].slot === "09000000001");
  const srcTxt = fs.readFileSync(APP_FILE, "utf8");
  ok("هیچ محاسبهٔ ظرفیت/عملکرد جایگاه در برنامه نیست",
    !/ظرفیت\s*جایگاه|عملکرد\s*جایگاه|slotCapacity|bayUtilization/.test(srcTxt));

  section("۵. جابه‌جایی ستون‌ها و املای عربی");
  const shuffled = await app.ingestFile("n", fileOf(FX.shuffledWorkbook(), "shuffled.xlsx"));
  ok("فایل با ترتیب متفاوت ستون‌ها پردازش شد", shuffled.ok === true);
  const sStats = app.computeNobatStats(shuffled.records);
  eq("تعداد ردیف یکسان", sStats.rowCount, E.rowCount);
  eq("کارت یکتا یکسان", sStats.uniqueCards, E.uniqueCards);
  eq("بدون شماره کارت یکسان", sStats.rowsWithoutCard, E.rowsWithoutCard);
  eq("نوبت یکتا یکسان", sStats.uniqueTurns, E.uniqueTurns);
  eq("وضعیت مراجعه با املای عربی هم شناسایی شد", statusCount(sStats, FX.QUEUE), E.statuses[FX.QUEUE]);
  eq("ستون «پلاك» به فیلد پلاک نگاشت شد", shuffled.records[0].plate, res.records[0].plate);
  ok("ستون اضافی باعث نگاشت اشتباه نشد", shuffled.records[0].vehicle === res.records[0].vehicle);

  section("۶. دادهٔ ناقص");
  const partial = await app.ingestFile("n", fileOf(FX.partialWorkbook(), "partial.xlsx"));
  ok("فایل با ستون‌های کم پردازش شد", partial.ok === true, partial.ok ? "" : JSON.stringify(partial.diag.errorMessage));
  eq("ردیف خالی بالای هدر نادیده گرفته شد", partial.records.length, E.rowCount);
  const pStats = app.computeNobatStats(partial.records);
  eq("شمارش کارت با ستون‌های کمتر درست است", pStats.uniqueCards, E.uniqueCards);
  eq("ردیف بدون کارت با ستون‌های کمتر درست است", pStats.rowsWithoutCard, E.rowsWithoutCard);
  eq("ستون غایب مقدار خالی می‌گیرد", partial.records[0].plate, "");
  ok("ستون غایب به‌جای undefined خالی است", partial.records.every((r) => r.customer === ""));

  section("۷. انتخاب شیت بر اساس نام، نه اندازه یا نام فایل");
  const decoy = await app.ingestFile("n", fileOf(FX.decoyWorkbook(), "unrelated-name.xls"));
  ok("فایل چندشیتی پردازش شد", decoy.ok === true);
  eq("شیت درست انتخاب شد", decoy.diag.pickedSheet, "گزارش نوبت دهی");
  eq("ردیف‌ها از شیت درست خوانده شدند", decoy.records.length, E.rowCount);

  section("۸. فایل نامعتبر");
  const bad = await app.ingestFile("n", fileOf(FX.notASpreadsheet(), "notes.txt"));
  ok("فایل نامعتبر رد شد", bad.ok === false);
  ok("پیام خطای روشن دارد", !!(bad.diag && bad.diag.errorMessage && bad.diag.errorMessage.length > 10), bad.diag && bad.diag.errorMessage);
  const emptyWb = await app.ingestFile("n", fileOf(FX.emptyWorkbook(), "empty.xlsx"));
  ok("فایل فقط-هدر بدون ردیف برمی‌گردد", emptyWb.ok === true && emptyWb.records.length === 0);

  section("۹. تاریخ گزارش (شمسی)");
  const d = app.parseJalaliInput("۱۴۰۵/۰۶/۲۸");
  ok("تاریخ با ارقام فارسی پذیرفته شد", d.valid === true);
  eq("کلید تاریخ", d.key, "1405/06/28");
  ok("تاریخ خالی رد شد", app.parseJalaliInput("").valid === false);
  ok("ماه ۱۳ رد شد", app.parseJalaliInput("1405/13/01").valid === false);
  ok("۳۱ اسفند رد شد", app.parseJalaliInput("1405/12/31").valid === false);
  ok("۳۱ مهر رد شد", app.parseJalaliInput("1405/07/31").valid === false);
  ok("متن نامعتبر رد شد", app.parseJalaliInput("سه‌شنبه").valid === false);
  ok("تاریخ میلادی به‌عنوان تاریخ شمسی پذیرفته نشد", app.parseJalaliInput("2026/09/19").valid === false);
  ok("هر تاریخ نامعتبر دلیل دارد", !!app.parseJalaliInput("1405/13/01").reason);

  section("۱۰. تاریخ گزارش جایگزین تاریخ پذیرش نمی‌شود");
  const meta1 = {
    dateKey: "1405/06/28", jy: 1405, jm: 6, jd: 28, dateLabel: "۲۸ شهریور ۱۴۰۵",
    statusFilter: app.NOBAT_STATUS_ALL, hall: app.NOBAT_HALL_DEFAULT,
    fileName: "nobat-sample.xlsx", contentHash: "sha256:aaaa1111bbbb2222", receivedAt: 1758300000000,
  };
  const rep1 = app.buildNobatReport(meta1, res.records, res.diag, 1);
  eq("تاریخ گزارش جدا ذخیره شد", rep1.dateKey, "1405/06/28");
  ok("تاریخ گزارش داخل ردیف‌ها نوشته نشد",
    rep1.records.every((r) => !Object.values(r).includes("1405/06/28")));
  eq("زمان پذیرش ردیف دست‌نخورده است", rep1.records[0].receptionTime, "08:10");
  ok("زمان ورود به هداکس ثبت شد", rep1.receivedAt === meta1.receivedAt);
  ok("نام فایل و شناسهٔ محتوا ذخیره شد", rep1.fileName === "nobat-sample.xlsx" && rep1.contentHash === meta1.contentHash);

  section("۱۱. جلوگیری از بارگذاری تکراری و نسخه‌بندی");
  const scope1 = app.nobatScopeKey(meta1);
  const store = [rep1];
  const again = app.classifyIncomingReport(store, { scopeKey: scope1, contentHash: meta1.contentHash });
  eq("همان فایل + همان دامنه = تکراری", again.action, "duplicate");

  const newer = app.classifyIncomingReport(store, { scopeKey: scope1, contentHash: "sha256:cccc3333" });
  eq("محتوای تازه در همان دامنه = نسخه تازه", newer.action, "revision");
  eq("شماره نسخه", newer.revision, 2);

  const meta2 = Object.assign({}, meta1, { contentHash: "sha256:cccc3333" });
  const rep2 = app.buildNobatReport(meta2, res.records.slice(0, 5), res.diag, newer.revision);
  const store2 = store.concat([rep2]);
  const latest = app.latestPerScope(store2);
  eq("فقط یک گزارش برای هر دامنه", latest.length, 1);
  eq("آمار پیش‌فرض از آخرین نسخه ساخته می‌شود", latest[0].revision, 2);
  eq("سابقهٔ نسخه‌ها حفظ شد", app.revisionsOfScope(store2, scope1).length, 2);
  eq("داده دو برابر نشد", store2.filter((r) => r.scopeKey === scope1).length, 2);
  ok("ردیف‌ها با هم جمع نشدند", latest[0].rowCount === 5);

  const otherDate = app.classifyIncomingReport(store2, { scopeKey: app.nobatScopeKey(Object.assign({}, meta1, { dateKey: "1405/06/29" })), contentHash: "sha256:dddd4444" });
  eq("تاریخ دیگر = گزارش تازه", otherDate.action, "new");
  eq("نسخهٔ گزارش تاریخ دیگر از ۱ شروع می‌شود", otherDate.revision, 1);

  const otherFilter = app.classifyIncomingReport(store2, { scopeKey: app.nobatScopeKey(Object.assign({}, meta1, { statusFilter: FX.REPAIR })), contentHash: "sha256:eeee5555" });
  eq("فیلتر متفاوت = دامنهٔ جدا", otherFilter.action, "new");

  const meta3 = Object.assign({}, meta1, { dateKey: "1405/06/29", contentHash: "sha256:dddd4444" });
  const rep3 = app.buildNobatReport(meta3, res.records, res.diag, 1);
  const store3 = store2.concat([rep3]);
  eq("دامنه‌های مختلف جدا نگه داشته شدند", app.latestPerScope(store3).length, 2);
  ok("دامنه‌ها با هم جمع نمی‌شوند",
    app.latestPerScope(store3).every((r) => r.rowCount === 5 || r.rowCount === E.rowCount));

  section("۱۲. شناسهٔ محتوای فایل");
  const buf1 = FX.sampleWorkbook(), buf2 = FX.sampleWorkbook(), buf3 = FX.shuffledWorkbook();
  const h1 = await app.hashBytes(buf1.buffer.slice(buf1.byteOffset, buf1.byteOffset + buf1.byteLength));
  const h2 = await app.hashBytes(buf2.buffer.slice(buf2.byteOffset, buf2.byteOffset + buf2.byteLength));
  const h3 = await app.hashBytes(buf3.buffer.slice(buf3.byteOffset, buf3.byteOffset + buf3.byteLength));
  eq("محتوای یکسان، شناسهٔ یکسان", h1, h2);
  ok("محتوای متفاوت، شناسهٔ متفاوت", h1 !== h3);

  section("۱۳. ماندگاری داده پس از تازه‌سازی صفحه");
  const disk = new Map(); // شبیه‌سازی فضای ذخیره‌سازی مرورگر
  app.NobatStore._idb = makeFakeIndexedDB(disk);
  app.NobatStore.reset();
  await app.NobatStore.put(rep1);
  await app.NobatStore.put(rep2);
  await app.NobatStore.put(rep3);
  eq("سه گزارش ذخیره شد", (await app.NobatStore.all()).length, 3);
  await app.NobatStore.put(rep1); // same id again
  eq("ذخیرهٔ دوبارهٔ همان گزارش رکورد جدید نساخت", (await app.NobatStore.all()).length, 3);

  // simulate a page refresh: fresh store handle, same backing storage
  app.NobatStore.reset();
  app.NobatStore._idb = makeFakeIndexedDB(disk);
  const restored = await app.NobatStore.all();
  eq("پس از تازه‌سازی، گزارش‌ها برگشتند", restored.length, 3);
  eq("ردیف‌های گزارش هم برگشتند", restored.find((r) => r.id === rep3.id).records.length, E.rowCount);
  const restoredStats = app.computeNobatStats(restored.find((r) => r.id === rep3.id).records);
  eq("آمار پس از بازیابی یکسان است", restoredStats.uniqueCards, E.uniqueCards);
  eq("آخرین نسخه پس از بازیابی درست است", app.latestPerScope(restored).length, 2);

  section("۱۴. بازیابی همزمان با بارگذاری");
  {
    const ctx = app.__context;
    const realDoc = ctx.document;
    ctx.document = makeDocument(["fileDots", "nobatBody"]);
    const previousTab = app.STATE.activeTab;
    app.STATE.activeTab = "nobat"; // This fixture covers the nobat view; dashboard has its own browser suite.
    try {
      // گزارشی که کاربر پیش از پایان بازیابی بارگذاری کرده است
      app.STATE.nobat.reports = [rep3];
      app.STATE.nobat.activeScope = null;
      app.NobatStore.reset();
      app.NobatStore._idb = makeFakeIndexedDB(disk); // شامل rep1 و rep2 و rep3
      await app.loadNobatFromStore();
      const ids = app.STATE.nobat.reports.map((r) => r.id).sort();
      eq("گزارش بارگذاری‌شده حین بازیابی پاک نشد", ids.length, 3);
      ok("گزارش درون حافظه حفظ شد", ids.includes(rep3.id));
      ok("گزارش‌های ذخیره‌شده هم آمدند", ids.includes(rep1.id) && ids.includes(rep2.id));

      // اگر ذخیره‌سازی محلی خطا بدهد، دادهٔ درون حافظه نباید از بین برود
      app.STATE.nobat.reports = [rep3];
      app.STATE.nobat.activeScope = null;
      app.NobatStore.reset();
      app.NobatStore._idb = { open() { const rq = { onupgradeneeded: null, onsuccess: null, onerror: null, error: new Error("دسترسی به پایگاه داده محلی ممکن نیست") }; setTimeout(() => rq.onerror && rq.onerror(), 0); return rq; } };
      await app.loadNobatFromStore();
      eq("با خطای ذخیره‌سازی، دادهٔ حافظه باقی ماند", app.STATE.nobat.reports.length, 1);
      ok("خطای ذخیره‌سازی ثبت شد", !!app.STATE.nobat.storeError);

      app.renderNobat();
      ok("هشدار نبودِ نگهداری محلی نمایش داده شد",
        ctx.document.__el("nobatBody").innerHTML.includes("نگهداری محلی در دسترس نیست"));
    } finally {
      ctx.document = realDoc;
      app.STATE.activeTab = previousTab;
      app.STATE.nobat.reports = [];
      app.STATE.nobat.activeScope = null;
      app.STATE.nobat.storeError = null;
      app.NobatStore.reset();
      app.NobatStore._idb = makeFakeIndexedDB(disk);
    }
  }

  section("۱۵. سالم ماندن منابع قبلی");
  ok("منبع «موجودی و قیمت انبار» دست‌نخورده", !!app.SOURCE_DEFS.alef && app.SOURCE_DEFS.alef.fields.some((f) => f.key === "sellPrice" && f.required));
  ok("منبع «گردش و سفارش‌گذاری» دست‌نخورده", !!app.SOURCE_DEFS.b && app.SOURCE_DEFS.b.fields.some((f) => f.key === "turnover" && f.required));
  ok("منبع «امداد ویژه» دست‌نخورده", !!app.SOURCE_DEFS.p && app.SOURCE_DEFS.p.fields.some((f) => f.key === "date" && f.required));
  ok("منبع «پذیرش تا ترخیص» دست‌نخورده", !!app.SOURCE_DEFS.t && app.SOURCE_DEFS.t.fields.some((f) => f.key === "cardNo" && f.required));
  ok("منبع نوبت‌دهی مستقل است و به «پذیرش تا ترخیص» تبدیل نشده",
    app.SOURCE_DEFS.n.id === "n" && app.SOURCE_DEFS.n.fields.length === 18 && app.SOURCE_DEFS.t !== app.SOURCE_DEFS.n && app.SOURCE_DEFS.t.fields.some(f=>f.key==='createdAt'));
  ok("هیچ ستونی در نوبت‌دهی باعث حذف ردیف نمی‌شود", app.SOURCE_DEFS.n.fields.every((f) => !f.required));
  ok("کارت‌های شناسایی نوع فایل تعریف شده‌اند", app.mapRequiredFields(app.SOURCE_DEFS.n).length === 3);

  // the older sources still drop rows that miss their required fields
  const tGrid = [["شماره کارت پذیرش", "تاریخ و زمان ایجاد"], ["123", "1405/06/28 08:00"], ["", "1405/06/28 09:00"]];
  const tBuilt = app.buildRecords(app.SOURCE_DEFS.t, tGrid, 0, app.autoMapColumns(tGrid[0], app.SOURCE_DEFS.t.fields).map, {});
  eq("«پذیرش تا ترخیص» هنوز ردیف بدون شماره کارت را رد می‌کند", tBuilt.records.length, 1);
  eq("و آن را شمارش می‌کند", tBuilt.rejected, 1);
  ok("تب‌های قبلی در صفحه باقی مانده‌اند",
    ['data-tab="dashboard"', 'data-tab="priority"', 'data-tab="slow"', 'data-tab="emdad"', 'data-tab="oil"', 'data-tab="reception"', 'data-tab="nobat"']
      .every((t) => srcTxt.includes(t)));
  ok("رندرکنندهٔ هر تب ثبت شده", /nobat:\s*renderNobat/.test(srcTxt));

  section("۱۶. رندر بخش نوبت‌دهی");
  {
    const ctx = app.__context;
    const realDoc = ctx.document;
    const doc = makeDocument(["nobatBody", "nbScope", "nbStatusChart", "nbStatusTable", "nbRowsTable", "fileDots"]);
    ctx.document = doc;
    try {
      // بدون گزارش: حالت خالی، بدون خطا
      app.STATE.nobat.reports = [];
      app.STATE.nobat.activeScope = null;
      app.renderNobat();
      ok("حالت خالی بدون خطا رندر شد", doc.__el("nobatBody").innerHTML.includes("بارگذاری کنید"));

      // با گزارش
      app.STATE.nobat.reports = [rep1, rep2, rep3];
      app.STATE.nobat.activeScope = rep3.scopeKey;
      app.renderNobat();
      const out = doc.__el("nobatBody").innerHTML;
      ok("تعداد ردیف‌های گزارش نمایش داده شد", out.includes("تعداد ردیف‌های گزارش"));
      ok("کارت‌های پذیرش یکتا نمایش داده شد", out.includes("کارت‌های پذیرش یکتا"));
      ok("ردیف‌های بدون شماره کارت نمایش داده شد", out.includes("ردیف‌های بدون شماره کارت"));
      ok("نوبت‌های یکتا نمایش داده شد", out.includes("نوبت‌های یکتا"));
      ok("عنوان «تعداد پذیرش» به کار نرفته", !out.includes("تعداد پذیرش"));
      ok("تاریخ گزارش نمایش داده شد", out.includes(rep3.dateKey));
      ok("فیلتر وضعیت مراجعه نمایش داده شد", out.includes("فیلتر وضعیت مراجعه"));
      ok("سالن تعمیرات نمایش داده شد", out.includes("سالن تعمیرات"));
      ok("زمان ورود فایل به هداکس نمایش داده شد", out.includes("زمان ورود فایل به هداکس"));
      ok("نام فایل نمایش داده شد", out.includes(rep3.fileName));
      ok("محدودیت زمان تقریبی ترخیص نوشته شده", out.includes("زمان تقریبی ترخیص") && out.includes("تخمین است"));
      ok("هشدار دربارهٔ ستون جایگاه نوشته شده", out.includes("جایگاه تعمیرگاهی نیستند"));
      ok("هشدار دربارهٔ خالی‌نبودن‌برابر‌صفر نوشته شده", out.includes("خالی به معنی صفر نیست"));
      ok("فهرست نسخه‌ها نمایش داده شد", out.includes("نسخه‌های ثبت‌شده"));
      ok("انتخابگر دامنهٔ گزارش ساخته شد", out.includes("nbScope"));
      ok("همهٔ دامنه‌ها در انتخابگر هستند", (out.match(/<option /g) || []).length === 2);

      // نسخهٔ فعال باید آخرین نسخه باشد، نه نسخهٔ قدیمی
      app.STATE.nobat.activeScope = rep1.scopeKey;
      app.renderNobat();
      eq("نسخهٔ فعال، آخرین نسخه است", app.activeNobatReport().revision, 2);
    } finally {
      ctx.document = realDoc;
      app.STATE.nobat.reports = [];
      app.STATE.nobat.activeScope = null;
    }
  }

  section("۱۷. نبودن مقادیر مخصوص فایل نمونه در کد برنامه");
  const appOnly = srcTxt;
  ok("تاریخ فایل نمونه در کد ثابت نشده", !appOnly.includes("1405/06/28") && !appOnly.includes("۱۴۰۵/۰۶/۲۸".replace("۱۴۰۵/۰۶/۲۸", "1405/06/28")));
  ok("اعداد گزارش نمونه در کد ثابت نشده",
    !/(rowCount|uniqueCards|rowsWithoutCard)\s*[=:]\s*(79|47|32)\b/.test(appOnly));
  ok("وضعیت‌های فایل نمونه در کد ثابت نشده",
    !app.computeNobatStats.toString().includes("در صف تقسيم کار") && !app.computeNobatStats.toString().includes("در صف تقسیم کار"));
  ok("نام فایل نمونه در کد نیست", !/res\s*\(2\)\.xlsx/.test(appOnly));
  ok("مسیر یا نام فایل مبنای تشخیص نوع منبع نیست", !/fileHint\s*===|file\.name\s*\.includes/.test(appOnly));

  /* ---------------------------------------------------------------- */
  const realIdx = process.argv.indexOf("--real");
  if (realIdx > -1 && process.argv[realIdx + 1]) {
    section("۱۸. بررسی محلی با فایل واقعی (خارج از مخزن)");
    const p = process.argv[realIdx + 1];
    const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > -1 ? Number(process.argv[i + 1]) : dflt; };
    const realRes = await app.ingestFile("n", fileOf(fs.readFileSync(p), require("path").basename(p)));
    ok("فایل واقعی پردازش شد", realRes.ok === true, realRes.ok ? "" : JSON.stringify(realRes.diag.errorMessage));
    if (realRes.ok) {
      const rStats = app.computeNobatStats(realRes.records);
      console.log("    شیت: " + realRes.diag.pickedSheet);
      eq("تعداد ردیف‌های گزارش", rStats.rowCount, arg("--rows", 79));
      eq("کارت‌های پذیرش یکتا", rStats.uniqueCards, arg("--cards", 47));
      eq("ردیف‌های بدون شماره کارت", rStats.rowsWithoutCard, arg("--nocard", 32));
      console.log("    نوبت‌های یکتا: " + rStats.uniqueTurns);
      console.log("    توزیع وضعیت مراجعه: " + rStats.statusRows.map((r) => r.label + "=" + r.count).join(" · "));
    }
  } else {
    console.log("\n(برای بررسی با فایل واقعی: node tests/run-tests.js --real \"<path>\" — فایل واقعی هرگز در مخزن ذخیره نمی‌شود)");
  }

  console.log(`\n${"=".repeat(52)}\nموفق: ${passed}   ناموفق: ${failed}`);
  if (failed) { console.log("\nموارد ناموفق:"); failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
