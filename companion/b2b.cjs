'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const archive = require('./archive.cjs');
const {captureExport} = require('./export.cjs');
const REPORT_URL = 'https://b2b.isaco.ir/PlanningReport';
const STATUS = ['همه', 'در صف نوبت', 'در صف پذیرش', 'در صف تقسیم کار', 'در صف سالن', 'در حال تعمیر', 'در صف تغییر جایگاه'];
const HALLS = ['سالن تعمیرات', 'فضای گازسوز', 'سرویس سریع'];
// Shown while HEDAX waits for the user; fetching resumes on its own afterwards.
const LOGIN_WAIT_MESSAGE = 'در پنجرهٔ Chrome وارد B2B شوید؛ دریافت گزارش‌ها پس از ورود خودکار ادامه پیدا می‌کند.';
function failure(code, message) { return Object.assign(new Error(message), {code}); }
function validateScope(input) {
  if (!input || typeof input !== 'object') throw failure('INVALID_SCOPE', 'محدوده گزارش نامعتبر است.');
  const {dateKey, statusFilter, hall} = input;
  const m = /^(1[34]\d{2})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])$/.exec(dateKey || '');
  if (!m || (+m[2] > 6 && +m[3] > 30) || !STATUS.includes(statusFilter) || !HALLS.includes(hall)) {
    throw failure('INVALID_SCOPE', 'تاریخ یا فیلتر گزارش معتبر نیست.');
  }
  return {dateKey, statusFilter, hall};
}
// Select only named report controls observed on PlanningReport. No operational forms.
async function selectReportValue(page, name, value) {
  const field = page.getByRole('listbox', {name, exact:true});
  await field.waitFor({state:'visible', timeout:20000});
  await field.press('Alt+ArrowDown');
  const popupId = await field.getAttribute('aria-owns');
  if (!popupId) throw failure('PAGE_CHANGED', 'ساختار فهرست گزارش تغییر کرده است.');
  const popup = page.locator('[id=' + JSON.stringify(popupId) + ']');
  await popup.getByRole('option', {name:value, exact:true}).click({timeout:15000});
  if ((await field.inputValue()).trim() !== value.trim()) throw failure('FILTER_MISMATCH', 'فیلتر انتخاب‌شده تأیید نشد.');
}
class B2BClient {
  constructor({profileDir, chromium, channel='chrome', root} = {}) {
    this.profileDir = profileDir; this.chromium = chromium; this.channel = channel;
    this.root = root || path.resolve(__dirname, '..');
    this.context = null; this.page = null; this.launching = null; this.busy = false;
  }
  async open() {
    if (this.context && this.page && !this.page.isClosed()) return this.page;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      await fs.mkdir(this.profileDir, {recursive:true});
      const chromium = this.chromium || require('playwright').chromium;
      try {
        this.context = await chromium.launchPersistentContext(this.profileDir, {
          channel:this.channel, headless:false, acceptDownloads:true, chromiumSandbox:true,
          viewport:null, timeout:30000
        });
      } catch {
        throw failure('BROWSER_START_FAILED', 'مرورگر Google Chrome اجرا نشد. نصب Chrome را بررسی کنید و فایل start-hedax.cmd را از خود ویندوز اجرا کنید.');
      }
      this.context.on('close', () => { this.context = null; this.page = null; });
      this.page = this.context.pages()[0] || await this.context.newPage();
      this.page.setDefaultTimeout(20000);
      await this.page.goto(REPORT_URL, {waitUntil:'domcontentloaded', timeout:45000});
      return this.page;
    })();
    try { return await this.launching; } finally { this.launching = null; }
  }
  async login() {
    if (this.busy) throw failure('BUSY', 'دریافت گزارش در حال اجراست.');
    this.busy=true;
    try {
      const page = await this.open();
      await page.bringToFront();
      // Only navigate when the window is somewhere else entirely. Re-opening the
      // report URL while the user is halfway through a password or a captcha
      // would throw their input away.
      if (!page.url().startsWith('https://b2b.isaco.ir/')) await page.goto(REPORT_URL);
      return {message:LOGIN_WAIT_MESSAGE};
    } finally { this.busy=false; }
  }
  /* Passive login probe. It never launches a window, never navigates and never
     reloads, so it is safe to call on a timer while the user is typing.
     `ready` means "nothing here says the user is signed out" — it is a hint for
     resuming, not proof. The authoritative check stays where it always was: a
     report fetch that waits for the real report controls and raises
     LOGIN_REQUIRED when they are absent. */
  async state() {
    if (this.busy) return {browser:'busy', ready:true, busy:true};
    if (!this.context || !this.page || this.page.isClosed()) return {browser:'closed', ready:false, reason:'NO_WINDOW'};
    let url;
    try { url = new URL(this.page.url()); } catch { return {browser:'open', ready:false, reason:'NO_PAGE'}; }
    if (url.origin !== 'https://b2b.isaco.ir') return {browser:'open', ready:false, reason:'OFF_SITE'};
    let signInVisible = false;
    try {
      signInVisible = await this.page.locator('input[type="password"]').first().isVisible({timeout:1500});
    } catch { signInVisible = false; } // a detached or navigating page is simply "not yet"
    if (signInVisible) return {browser:'open', ready:false, reason:'LOGIN_FORM', path:url.pathname};
    return {browser:'open', ready:true, path:url.pathname};
  }
  async sync(input) {
    const scope = validateScope(input);
    if (this.busy) throw failure('BUSY', 'دریافت دیگری در حال اجراست؛ کمی بعد دوباره تلاش کنید.');
    this.busy = true;
    let phase = 'باز کردن مرورگر';
    try {
      const page = await this.open();
      phase = 'باز کردن گزارش نوبت‌دهی';
      await page.goto(REPORT_URL, {waitUntil:'domcontentloaded', timeout:45000});
      const report = page.getByRole('listbox', {name:'گزارش', exact:true});
      try { await report.waitFor({state:'visible', timeout:15000}); }
      catch {
        if (new URL(page.url()).pathname !== '/PlanningReport') throw failure('LOGIN_REQUIRED', LOGIN_WAIT_MESSAGE);
        throw failure('PAGE_CHANGED', 'فهرست گزارش نوبت‌دهی پیدا نشد؛ صفحهٔ B2B را بررسی کنید.');
      }
      if (new URL(page.url()).origin !== 'https://b2b.isaco.ir') throw failure('LOGIN_REQUIRED', LOGIN_WAIT_MESSAGE);
      phase = 'تنظیم تاریخ، وضعیت و سالن';
      await selectReportValue(page, 'گزارش', 'گزارش نوبت دهی و برنامه تعمیرات');
      const date = page.getByRole('textbox', {name:'تاریخ روز', exact:true});
      await date.fill(scope.dateKey); await date.press('Tab');
      await selectReportValue(page, 'وضعیت مراجعه', scope.statusFilter);
      await selectReportValue(page, 'سالن تعمیرات پذیرش', scope.hall);
      const normalizeDigits = s => s.replace(/[۰-۹]/g, c => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c)).replace(/[٠-٩]/g, c => '٠١٢٣٤٥٦٧٨٩'.indexOf(c));
      if (normalizeDigits(await date.inputValue()) !== scope.dateKey) throw failure('FILTER_MISMATCH', 'تاریخ گزارش تأیید نشد.');
      // The address and session are captured before the click, so a window that
      // closes mid-transfer no longer loses the report.
      phase = 'دریافت اکسل نوبت‌دهی';
      const stages = {download:'pending', read:'pending', format:'pending', archive:'skipped'};
      const {download, bytes, via, suggested, cookieCount} = await captureExport({
        context: page.context(), page, timeout: 90000, fail: failure, readFile: f => fs.readFile(f), session: this,
        click: () => page.getByRole('button', {name:'خروجی Excel', exact:true}).click(),
      });
      try {
        stages.download = via === 'session' ? 'recovered-from-session' : 'ok';
        if (bytes.length > 25 * 1024 * 1024) throw failure('INVALID_FILE', 'حجم گزارش بیش از حد مجاز است.');
        stages.read = 'ok';
        const format = archive.detectFormat(bytes);
        stages.format = format;
        if (format !== 'zip') throw failure('INVALID_FILE', 'پاسخ B2B فایل xlsx معتبر نیست (قالب دریافتی: ' + format + ').');
        const kept = await archive.keep({root:this.root, download: via === 'download' ? download : null, sourceId:'n', scope, bytes});
        stages.archive = kept.saved ? 'ok' : kept.reason;
        return {scope, receivedAt:Date.now(), fileName:'b2b-nobat-' + scope.dateKey.replaceAll('/','-') + '.xlsx', base64:bytes.toString('base64'),
          diagnostics:{bytes:bytes.length, format, via, sessionCookies:cookieCount, suggestedFilename:archive.safePart(suggested, ''), archived:kept.saved ? kept.name : null, stages}};
      } finally { await download.delete().catch(() => {}); }
    } catch (err) {
      if (err.code) throw err;
      throw failure('B2B_UNAVAILABLE', 'دریافت نوبت‌دهی در مرحلهٔ «' + phase + '» کامل نشد؛ صفحهٔ B2B را بررسی کنید. گزارش قبلی حفظ شده است.');
    } finally { this.busy = false; }
  }
  async report(input) { return require('./operations.cjs').runOperation(this,input,selectReportValue); }
  async close() { if (this.context) await this.context.close(); }
}
module.exports = {B2BClient, validateScope, selectReportValue, STATUS, HALLS, LOGIN_WAIT_MESSAGE};
