/* The whole hands-off scenario, in a real browser, against a simulated companion:

     HEDAX opens → fetching starts → the session is missing → Chrome is brought
     forward and HEDAX says «منتظر ورود» → the user signs in by hand → fetching
     resumes on its own → reports are stored and the charts update → the page is
     reloaded and the data is still there.

   Also covers a session that was already valid, and one that expires midway.

   The companion is simulated here: there is no B2B connection, no Chrome
   automation and no credential of any kind. Every payload is synthetic.
   Run:  node tests/autosync-browser.cjs   (skips when no Chrome is installed) */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDashboard } = require('./cdp.cjs');
const SSML = require('./fixtures-ssml');
const FX = require('./fixtures');

const PORT = 5199;
const APP = path.join(__dirname, '..', 'index (4).html');
const WAIT_TEXT = require('../companion/b2b.cjs').LOGIN_WAIT_MESSAGE;

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + detail : '')); }
};
const eq = (name, a, b) => ok(name, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/* ---------- simulated companion ---------- */
function startCompanion() {
  const state = { signedIn: false, loginCalls: 0, reportCalls: [], syncCalls: 0, statePolls: 0, expireAfter: Infinity, served: 0 };
  const token = 'test-run-token';
  const inventoryHtml = Buffer.from('<html><head><meta charset="utf-8"></head><body><table>' +
    '<tr><th>کد کالا</th><th>شرح کالا</th><th>موجودی</th><th>قیمت فروش</th></tr>' +
    '<tr><td>A-100</td><td>قطعهٔ آزمایشی الف</td><td>5</td><td>250000</td></tr>' +
    '<tr><td>A-101</td><td>قطعهٔ آزمایشی ب</td><td>0</td><td>310000</td></tr></table></body></html>', 'utf8');
  const dplanHtml = Buffer.from('<html><head><meta charset="utf-8"></head><body><table>' +
    '<tr><th>کد اختصاصی</th><th>شرح کالا</th><th>نوع گردش</th><th>موجودی نمایندگی</th></tr>' +
    '<tr><td>B-1</td><td>قطعهٔ آزمایشی ج</td><td>کند گردش</td><td>2</td></tr></table></body></html>', 'utf8');
  const emdadHtml = Buffer.from('<html><head><meta charset="utf-8"></head><body><table>' +
    '<tr><th>کد اختصاصی</th><th>تاریخ ثبت امداد ویژه</th><th>شرح اختصاصی</th></tr>' +
    '<tr><td>B-1</td><td>1405/03/01</td><td>قطعهٔ آزمایشی ج</td></tr></table></body></html>', 'utf8');

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost:' + PORT);
    if (req.method === 'GET' && url.pathname === '/api/b2b/session') {
      return json(res, 200, { token, version: 1, build: 'test', browser: 'chrome' });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/b2b/')) {
      if (req.headers['x-hedax-token'] !== token) return json(res, 403, { message: 'Request rejected' });
      let body = ''; for await (const c of req) body += c;
      const input = JSON.parse(body || '{}');
      const route = url.pathname.split('/').pop();
      if (route === 'login') { state.loginCalls++; return json(res, 200, { message: WAIT_TEXT }); }
      if (route === 'state') { state.statePolls++; return json(res, 200, { browser: 'open', ready: state.signedIn }); }
      if (!state.signedIn) return json(res, 401, { code: 'LOGIN_REQUIRED', message: WAIT_TEXT });
      if (route === 'sync') {
        state.syncCalls++;
        return json(res, 200, { scope: input, receivedAt: Date.now(), fileName: 'b2b-nobat.xlsx', base64: FX.sampleWorkbook().toString('base64') });
      }
      // route === 'report'
      state.reportCalls.push(input.sourceId);
      if (state.reportCalls.length > state.expireAfter) { state.signedIn = false; return json(res, 401, { code: 'LOGIN_REQUIRED', message: WAIT_TEXT }); }
      const id = input.sourceId;
      const bytes = id === 'alef' ? inventoryHtml
        : id === 'b' ? dplanHtml
        : id === 'p' ? emdadHtml
        : SSML.receptionForRange(input.fromDate, ['C' + state.reportCalls.length.toString().padStart(6, '0')]);
      return json(res, 200, { scope: input, receivedAt: Date.now(), fileName: 'b2b-' + id, base64: bytes.toString('base64') });
    }
    if (req.method === 'GET' && ['/', '/index.html'].includes(url.pathname)) {
      state.served++;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(APP));
    }
    return json(res, 404, { message: 'Not found' });
  });
  return { server, state, token };
}

const SPEED = 'B2BGate.configure({pollMs:250,maxWaitMs:120000});';
const waitFor = async (fn, ms = 10000, every = 150) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (fn()) return true; await new Promise((r) => setTimeout(r, every)); }
  return fn();
};
const until = async (page, expr, ms = 45000, every = 300) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await page.evaluate(`(()=>{try{return !!(${expr})}catch(e){return false}})()`)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, every));
  }
};

async function main() {
  const { server, state } = startCompanion();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const page = await openDashboard(9337, 'http://localhost:' + PORT + '/');
  if (!page) { console.log('Chrome یافت نشد — این آزمون رد شد (skip).'); server.close(); return; }

  try {
    /* ---------- 1. opens signed out: waits for the user, fetches nothing ---------- */
    console.log('\n۱. باز شدن هداکس در حالت خارج‌شده از B2B');
    await page.evaluate(SPEED + 'true');
    ok('صفحه از همراه محلی سرو شد', state.served >= 1);

    const sawWait = await until(page, `Array.from(document.querySelectorAll('[data-ops-status]')).some(el=>el.textContent.includes('منتظر ورود'))`);
    ok('وضعیت «منتظر ورود» نمایش داده شد', sawWait);
    ok('پنجرهٔ Chrome جلو آورده شد', state.loginCalls >= 1, 'loginCalls=' + state.loginCalls);
    const waitText = await page.evaluate(`(Array.from(document.querySelectorAll('[data-ops-status]')).find(el=>el.textContent.includes('منتظر ورود'))||{}).textContent||''`);
    ok('پیام دقیقاً همان متن توافق‌شده است', waitText.includes(WAIT_TEXT), waitText);
    ok('پیام دکمهٔ «وارد شدم» یا «دریافت مجدد» نمی‌خواهد', !/وارد شدم|دریافت مجدد/.test(waitText));
    const before = await page.evaluate('JSON.stringify({alef:!!STATE.sources.alef,n:STATE.nobat.reports.length})');
    eq('هیچ گزارشی پیش از ورود ذخیره نشد', before, '{"alef":false,"n":0}');
    const polled = await waitFor(() => state.statePolls >= 1, 8000);
    ok('همراه برای تشخیص ورود poll می‌شود', polled, 'polls=' + state.statePolls);

    /* ---------- 2. the user signs in by hand ---------- */
    console.log('\n۲. ورود دستی کاربر در پنجرهٔ Chrome');
    state.signedIn = true;               // this is the only thing the user does
    const gotInventory = await until(page, 'STATE.sources.alef && STATE.sources.alef.records.length===2');
    ok('دریافت بدون هیچ کلیک اضافه ادامه پیدا کرد', gotInventory);
    const gotNobat = await until(page, 'STATE.nobat.reports.length>0');
    ok('نوبت‌دهی هم خودکار دریافت شد', gotNobat, 'syncCalls=' + state.syncCalls);
    const gotReception = await until(page, 'STATE.sources.t && STATE.sources.t.records.length>0', 90000);
    ok('پذیرش تا ترخیص با بخش‌بندی سال دریافت شد', gotReception, 'parts=' + state.reportCalls.filter((x) => x === 't').length);

    const summary = await page.evaluate(`(()=>{
      const n=activeNobatReport();
      return {alef:STATE.sources.alef.records.length, alefOrigin:STATE.sources.alef.meta.origin,
        t:STATE.sources.t.records.length, tParts:STATE.sources.t.meta.parts.length, tPartitioned:!!STATE.sources.t.meta.partitioned,
        nobat:computeNobatStats(n.records).rowCount, nobatSource:n.source,
        b:STATE.sources.b?STATE.sources.b.records.length:0,
        p:STATE.sources.p?STATE.sources.p.records.length:0,
        pStatus:(document.querySelector('[data-ops-status="p"]')||{}).textContent||''};
    })()`);
    eq('موجودی انبار', summary.alef, 2);
    eq('منبع موجودی b2b است', summary.alefOrigin, 'b2b');
    eq('DPLAN', summary.b, 1);
    eq('نوبت‌دهی', summary.nobat, FX.EXPECTED.rowCount);
    eq('منبع نوبت‌دهی b2b است', summary.nobatSource, 'b2b');
    ok('پذیرش از چند بخش جمع شد', summary.tParts > 1 && summary.tPartitioned, JSON.stringify({ parts: summary.tParts }));
    eq('ردیف پذیرش برابر تعداد بخش‌هاست', summary.t, summary.tParts);
    ok('امداد یا دریافت شد یا منتظر ساعت ۱۰ است',
      summary.p === 1 || /ساعت ۱۰ صبح/.test(summary.pStatus), JSON.stringify({ p: summary.p, msg: summary.pStatus }));

    /* ---------- 3. the analysis actually updates ---------- */
    console.log('\n۳. به‌روزرسانی تحلیل‌ها و نمودارها');
    const rendered = await page.evaluate(`(()=>{
      switchTab('dashboard');
      const dash=document.getElementById('tab-dashboard').innerHTML;
      STATE.receptionDay=STATE.sources.t.meta.parts[0].fromDate; switchTab('reception');
      const rec=document.getElementById('receptionBody').innerHTML;
      switchTab('nobat');
      const nob=document.getElementById('nobatBody').innerHTML;
      return {dash:dash.length, rec:rec.length, nob:nob.length,
        saved:Array.from(document.querySelectorAll('[data-ops-status]')).filter(el=>el.textContent.includes('ذخیره شد')).length,
        charts:document.querySelectorAll('svg').length};
    })()`);
    ok('داشبورد مدیریتی رندر شد', rendered.dash > 4000, String(rendered.dash));
    ok('تب پذیرش رندر شد', rendered.rec > 2000, String(rendered.rec));
    ok('تب نوبت‌دهی رندر شد', rendered.nob > 2000, String(rendered.nob));
    ok('وضعیت «ذخیره شد» نمایش داده شد', rendered.saved >= 1, 'count=' + rendered.saved);
    ok('نمودارها ترسیم شدند', rendered.charts > 0, 'svg=' + rendered.charts);

    /* ---------- 4. reload keeps everything ---------- */
    console.log('\n۴. تازه‌سازی صفحه');
    const callsBeforeReload = state.reportCalls.length;
    await page.reload();
    await page.evaluate(SPEED + 'true');
    const kept = await until(page, 'STATE.sources.alef && STATE.sources.t && STATE.nobat.reports.length>0');
    ok('داده پس از تازه‌سازی از IndexedDB برگشت', kept);
    const after = await page.evaluate(`JSON.stringify({alef:STATE.sources.alef.records.length,t:STATE.sources.t.records.length,n:STATE.nobat.reports.length})`);
    ok('همان داده‌ها برگشتند', after === JSON.stringify({ alef: 2, t: summary.t, n: 1 }), after);
    await new Promise((r) => setTimeout(r, 2500));
    eq('پذیرش سررسیدنشده دوباره دانلود نشد', state.reportCalls.filter((x) => x === 't').length, summary.tParts);
    eq('DPLAN ماهانه دوباره دانلود نشد', state.reportCalls.filter((x) => x === 'b').length, 1);
    ok('امداد ماهانه دوباره دانلود نشد', state.reportCalls.filter((x) => x === 'p').length <= 1);
    // موجودی طبق قرار با هر بار بازشدن بخش تازه می‌شود، پس یک درخواست تازه مورد انتظار است.
    ok('تنها موجودی — که قرارش همین است — دوباره گرفته شد', state.reportCalls.length - callsBeforeReload <= 1, 'delta=' + (state.reportCalls.length - callsBeforeReload));
    eq('نوبت‌دهی امروز دوباره دانلود نشد', state.syncCalls, 1);

    /* ---------- 5. a session that expires midway ---------- */
    console.log('\n۵. منقضی‌شدن نشست وسط دریافت');
    const inventoryCallsBefore = state.reportCalls.filter((x) => x === 'alef').length;
    state.expireAfter = state.reportCalls.length + 1;   // the next report succeeds, the one after fails
    state.loginCalls = 0;
    await page.evaluate(`(()=>{OperationsSync.sync('alef',true);OperationsSync.sync('b',true);return true})()`);
    const stalled = await until(page, `Array.from(document.querySelectorAll('[data-ops-status]')).some(el=>el.textContent.includes('منتظر ورود'))`);
    ok('دریافت در نیمهٔ راه متوقف شد و منتظر ورود ماند', stalled);
    ok('پنجرهٔ ورود دوباره جلو آورده شد', state.loginCalls >= 1);
    const keptDuring = await page.evaluate('STATE.sources.t ? STATE.sources.t.records.length : 0');
    eq('دادهٔ معتبر قبلی دست‌نخورده ماند', keptDuring, summary.t);

    state.expireAfter = Infinity; state.signedIn = true;  // the user signs in again
    const resumed = await waitFor(() => state.reportCalls.filter((x) => x === 'b').length >= 2, 20000);
    ok('پس از ورود مجدد، همان گزارش ناتمام دوباره اجرا شد', resumed, 'b calls=' + state.reportCalls.filter((x) => x === 'b').length);
    ok('و نتیجه‌اش ذخیره شد', await until(page, 'STATE.sources.b && STATE.sources.b.records.length===1'));
    eq('پذیرشِ کامل‌شده دوباره دریافت نشد', state.reportCalls.filter((x) => x === 't').length, summary.tParts);
    ok('فقط بخش ناتمام دوباره اجرا شد', state.reportCalls.filter((x) => x === 'alef').length <= inventoryCallsBefore + 2,
      'alef calls=' + state.reportCalls.filter((x) => x === 'alef').length);

    /* ---------- 6. a session that is already valid ---------- */
    console.log('\n۶. نشست از قبل معتبر');
    state.signedIn = true; state.loginCalls = 0; state.statePolls = 0;
    await page.reload();
    await page.evaluate(SPEED + 'true');
    await new Promise((r) => setTimeout(r, 3000));
    const noWait = await page.evaluate(`Array.from(document.querySelectorAll('[data-ops-status]')).every(el=>!el.textContent.includes('منتظر ورود'))`);
    ok('هیچ پیام «منتظر ورود» نشان داده نشد', noWait);
    eq('پنجرهٔ ورود بیهوده باز نشد', state.loginCalls, 0);
    ok('داده همچنان در دسترس است', await page.evaluate('!!STATE.sources.t && STATE.nobat.reports.length>0'));
  } finally {
    page.close();
    server.close();
  }

  console.log(`\n${'='.repeat(52)}\nموفق: ${passed}   ناموفق: ${failed}`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
