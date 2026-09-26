/* Retrieving an export without depending on the browser staying alive.

   B2B serves its exports as a plain GET on its report host; the "خروجی Excel"
   button only points a short-lived popup at that address. Observed live: the
   popup closes, the main page closes and the whole Chrome window goes down
   before the transfer finishes, so Playwright reports
   "Target page, context or browser has been closed" and no bytes arrive.

   The address and the session cookies are captured while the window is
   certainly alive, so when that happens the file is fetched directly instead.
   Cookies are used for that one request and are never logged or written
   anywhere. A download that fails for any other reason is a real failure and
   is reported as one. */
const CLOSED_TARGET = /Target page, context or browser has been closed|Target closed/i;

function cookieHeaderFor(url, cookies) {
  const host = new URL(url).hostname;
  return (cookies || [])
    .filter((c) => { const d = String(c.domain || '').replace(/^\./, ''); return d && (host === d || host.endsWith('.' + d)); })
    .map((c) => c.name + '=' + c.value)
    .join('; ');
}

async function fetchWithSession(url, cookies, userAgent, fail) {
  const header = cookieHeaderFor(url, cookies);
  if (!header) throw fail('DOWNLOAD_FAILED', 'پنجرهٔ مرورگر پیش از پایان انتقال بسته شد و نشست معتبری برای بازیابی فایل در دسترس نبود.');
  let res;
  try {
    res = await fetch(url, {headers:{Cookie:header, 'User-Agent':userAgent || '', Accept:'*/*'}, signal:AbortSignal.timeout(120000)});
  } catch (err) {
    throw fail('DOWNLOAD_FAILED', 'پنجرهٔ مرورگر بسته شد و بازیابی مستقیم فایل هم انجام نشد (' + (err.name === 'TimeoutError' ? 'زمان انتظار تمام شد' : err.message) + ').');
  }
  if (!res.ok) throw fail('DOWNLOAD_FAILED', 'پنجرهٔ مرورگر بسته شد و بازیابی مستقیم فایل با پاسخ HTTP ' + res.status + ' ناموفق بود.');
  return Buffer.from(await res.arrayBuffer());
}

/* Clicks the export control and returns its bytes.
   `via` says how they were obtained: 'download' normally, 'session' when the
   window died and the file had to be fetched from the captured address. */
async function captureExport({context, page, click, timeout = 120000, fail, readFile, session}) {
  // Captured before the click, while the window is certainly still alive. A jar
  // read from a window that already died comes back empty, so the last good one
  // is remembered and reused — it is the same persistent profile either way.
  let cookies = await context.cookies().catch(() => []);
  if (cookies.length) { if (session) session.cookies = cookies; }
  else if (session && session.cookies) cookies = session.cookies;
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
  const pending = context.waitForEvent('download', {timeout});
  pending.catch(() => {});
  await click();
  const download = await pending;
  const suggested = typeof download.suggestedFilename === 'function' ? download.suggestedFilename() : '';
  let url = '';
  try { url = download.url(); } catch { url = ''; }

  // Whatever happens from here, the temporary Playwright wrote must not be left
  // behind: the caller only gets a chance to clean up if this returns.
  const discard = async () => { try { await download.delete(); } catch {} };
  const why = await download.failure();
  if (!why) return {download, bytes: await readFile(await download.path()), via:'download', suggested, cookieCount:cookies.length};
  if (!CLOSED_TARGET.test(why)) { await discard(); throw fail('DOWNLOAD_FAILED', 'دریافت گزارش کامل نشد (' + why + ').'); }
  if (!url) { await discard(); throw fail('DOWNLOAD_FAILED', 'دریافت گزارش کامل نشد (' + why + ') و نشانی خروجی هم در دسترس نبود.'); }
  try {
    return {download, bytes: await fetchWithSession(url, cookies, userAgent, fail), via:'session', suggested, cookieCount:cookies.length};
  } catch (err) { await discard(); throw err; }
}

module.exports = {captureExport, fetchWithSession, cookieHeaderFor, CLOSED_TARGET};
