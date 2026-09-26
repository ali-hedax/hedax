/* Shared Chrome DevTools Protocol plumbing for the browser tests.
   Drives a real headless Chrome so the shipped page runs against real
   DOMParser, IndexedDB and fetch — not the minimal Node shims. */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.join(__dirname, '..', 'index (4).html');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findChrome(argv) {
  const i = (argv || process.argv).indexOf('--chrome');
  if (i > -1 && (argv || process.argv)[i + 1]) return (argv || process.argv)[i + 1];
  return CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
}

function fileUrl(p) {
  return 'file:///' + path.resolve(p).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace('%3A', ':');
}

async function waitForTarget(port, tries) {
  for (let i = 0; i < (tries || 60); i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Chrome DevTools endpoint did not come up');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });
    ws.addEventListener('error', () => reject(new Error('devtools socket error')));
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const n = ++id;
          pending.set(n, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: n, method, params: params || {} }));
        });
      },
      close() { ws.close(); },
    }));
  });
}

/* Waits until the page's own scripts have finished initialising. */
const WAIT_READY = 'new Promise((res) => { const t = setInterval(() => {' +
  ' if (typeof STATE !== "undefined" && typeof ingestFile === "function") { clearInterval(t); res(true); }' +
  ' }, 50); setTimeout(() => { clearInterval(t); res(false); }, 15000); })';

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception ? (d.exception.description || d.exception.value) : JSON.stringify(d));
  }
  return r.result.value;
}

/* Opens the dashboard in headless Chrome. Returns null when no Chrome exists,
   so a machine without one skips instead of failing. */
async function openDashboard(port) {
  const chrome = findChrome();
  if (!chrome) return null;
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hedax-cdp-'));
  const proc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files',
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`,
    fileUrl(APP),
  ], { stdio: 'ignore' });
  const target = await waitForTarget(port);
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // The page may still be parsing when the target appears; wait for its own init.
  if (!(await evaluate(cdp, WAIT_READY))) throw new Error('the dashboard did not finish initialising in the browser');
  return {
    cdp,
    evaluate: (expr) => evaluate(cdp, expr),
    async reload(waitMs) {
      await cdp.send('Page.reload');
      await new Promise((r) => setTimeout(r, waitMs || 1200));
      await evaluate(cdp, WAIT_READY);
    },
    close() {
      try { cdp.close(); } catch (e) {}
      proc.kill();
      try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}
    },
  };
}

module.exports = { APP, findChrome, fileUrl, waitForTarget, connect, evaluate, openDashboard, WAIT_READY };
