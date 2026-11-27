// Headless Chrome driven over the DevTools protocol, with no dependencies. Dev only; used by
// scripts/bench.mjs and scripts/ui-test.mjs. Set CHROME to the browser executable if it
// isn't in the default Windows location, and GPU=1 to use the real GPU.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 9333;

/** Starts Chrome and connects to its first tab. Call close() when done. */
export async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'actelocal-chrome-'));
  const gpuFlags = process.env.GPU === '1' ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] : [];
  const chrome = spawn(
    CHROME,
    ['--headless=new', ...gpuFlags, `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'],
    { stdio: 'ignore' },
  );
  const page = await connect();
  return {
    page,
    async close() {
      page.close();
      const exited = new Promise((resolve) => chrome.once('exit', resolve));
      chrome.kill();
      await exited;
      rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    },
  };
}

async function connect() {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      target = targets.find((t) => t.type === 'page');
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!target) throw new Error('Chrome did not start');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  let traceEvents = [];
  let traceDone = null;
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    if (message.method === 'Tracing.dataCollected') traceEvents.push(...message.params.value);
    if (message.method === 'Tracing.tracingComplete') traceDone?.(traceEvents);
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
      console.log(`  [page ${message.params.type}]`, message.params.args.map((a) => a.value ?? a.description).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      console.log('  [page exception]', message.params.exceptionDetails.exception?.description);
    }
    for (const listener of listeners.get(message.method) ?? []) listener(message.params);
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  /** Polls `expression` until it is truthy; returns its value. */
  const waitFor = async (expression, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await evaluate(expression).catch(() => null);
      if (value) return value;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for: ${expression}`);
  };
  await send('Runtime.enable');

  return {
    send,
    evaluate,
    waitFor,
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener]);
    },
    async open(url, readyExpression = 'document.readyState === "complete"') {
      await send('Page.navigate', { url });
      await new Promise((r) => setTimeout(r, 200));
      await waitFor(readyExpression, 20_000);
    },
    async startTrace() {
      traceEvents = [];
      await send('Tracing.start', {
        categories: 'devtools.timeline,disabled-by-default-devtools.timeline,v8.execute,blink,gpu',
        transferMode: 'ReportEvents',
      });
    },
    async stopTrace() {
      const done = new Promise((resolve) => (traceDone = resolve));
      await send('Tracing.end');
      return done;
    },
    close: () => ws.close(),
  };
}
