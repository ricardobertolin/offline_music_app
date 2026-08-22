/** Dependency-free Chrome DevTools Protocol driver (Node 22 has a global WebSocket).
 *  Used by tests/ui.test.mjs to drive the real app in a real browser. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

export function findBrowser() {
  return CANDIDATES.find((p) => existsSync(p)) || null;
}

export async function launch(url, { port = 9333, headless = true } = {}) {
  const CHROME = findBrowser();
  if (!CHROME) throw new Error('No Chrome/Edge found — set CHROME_PATH to run the UI tests');
  const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-features=Translate',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-gpu', '--mute-audio',
  ];
  if (headless) args.push('--headless=new');
  args.push(url);
  const proc = spawn(CHROME, args, { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
  }
  if (!target) { proc.kill(); throw new Error('Chrome did not start'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const logs = [];
  const dialogs = [];
  // Declared up front because the message handler reads api.acceptDialogs.
  const api = { acceptDialogs: true, dialogs };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      logs.push(`[pageerror] ${d.exception?.description || d.text}`);
    }
    // confirm()/alert() would block the page forever in headless mode.
    if (msg.method === 'Page.javascriptDialogOpening') {
      dialogs.push({ type: msg.params.type, message: msg.params.message });
      ws.send(JSON.stringify({
        id: ++id,
        method: 'Page.handleJavaScriptDialog',
        params: { accept: api.acceptDialogs },
      }));
    }
  };

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

  await send('Runtime.enable');
  await send('Page.enable');

  const evaluate = async (fnOrExpr, { timeout = 60000 } = {}) => {
    const expression = typeof fnOrExpr === 'function' ? `(${fnOrExpr})()` : fnOrExpr;
    const res = await Promise.race([
      send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('evaluate timed out')), timeout)),
    ]);
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result.value;
  };

  return Object.assign(api, {
    send,
    evaluate,
    logs,
    dumpLogs(prefix = '  ') { for (const l of logs) console.log(prefix + l); logs.length = 0; },
    async goto(u) {
      await send('Page.navigate', { url: u });
      await new Promise((r) => setTimeout(r, 300));
    },
    async close() {
      try { ws.close(); } catch { /* already gone */ }
      try { await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`); } catch { /* ignore */ }
      proc.kill();
      setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ } }, 500);
    },
  });
}

/** Poll a page-side predicate until it returns true. */
export async function waitFor(page, expr, { timeout = 20000, label = expr } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page.evaluate(`(() => { try { return !!(${expr}); } catch { return false; } })()`)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for: ${label}`);
}
