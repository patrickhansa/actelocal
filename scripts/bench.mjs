// Benchmarks the engine in headless Chrome, driven over the DevTools protocol. Dev only.
//
//   node scripts/bench.mjs sample [pages] [noise]   create test-files/synthetic-scan-<pages>p.pdf
//   node scripts/bench.mjs run <file> [targetKB...]  compress test-files/<file> to each target
//   node scripts/bench.mjs photos <count> <layout> [targetKB...]   generated photos to one PDF
//   node scripts/bench.mjs encode                    time sequential vs parallel JPEG encoding
//   node scripts/bench.mjs csp                       check the CSP allows pdf.js and blocks uploads
//
// Add GRAY=1 to the environment for grayscale, PROD=1 to run against a production build
// served with the production headers (public/_headers) instead of the dev server.
//
// Set CHROME to the browser executable if it isn't in the default Windows location.

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, createServer, preview } from 'vite';

const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 9333;
const DEV_PORT = 5199;
const PROD = process.env.PROD === '1';

const [command = 'run', ...args] = process.argv.slice(2);

let server;
if (PROD) {
  await build({ mode: 'harness', logLevel: 'warn' });
  if (existsSync('test-files')) cpSync('test-files', 'dist-harness/test-files', { recursive: true });
  server = await preview({ mode: 'harness', preview: { port: DEV_PORT, strictPort: true }, logLevel: 'warn' });
  console.log('Production build with production headers');
} else {
  server = await createServer({ server: { port: DEV_PORT, strictPort: true }, logLevel: 'warn' });
  await server.listen();
}
const profile = mkdtempSync(join(tmpdir(), 'actelocal-bench-'));
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'],
  { stdio: 'ignore' },
);

try {
  const page = await connect();
  await page.open(`http://localhost:${DEV_PORT}/dev/engine.html`);

  if (command === 'sample') {
    const pages = Number(args[0] ?? 10);
    const noise = Number(args[1] ?? 10);
    const base64 = await page.evaluate(`makeSample(${pages}, ${noise})`);
    mkdirSync('test-files', { recursive: true });
    const path = `test-files/synthetic-scan-${pages}p.pdf`;
    writeFileSync(path, Buffer.from(base64, 'base64'));
    console.log(`Wrote ${path} (${(base64.length * 0.75 / 1e6).toFixed(1)} MB)`);
  } else if (command === 'snapshot') {
    // snapshot <file.pdf | photos:<count>:<layout>> <targetKB>: writes the PDF and its pages as PNG
    const [source, targetKb = '1000'] = args;
    const targets = [Number(targetKb) * 1000];
    const grayscale = process.env.GRAY === '1';
    // photos:<count>:<layout>[:<exif orientation>]
    const [, count, layout, exif] = source.split(':');
    const config = source.startsWith('photos:')
      ? { count: Number(count), layout, exif: Number(exif ?? 0), targets, grayscale }
      : { url: `/test-files/${source}`, targets, grayscale };
    const result = await page.evaluate(`snapshot(${JSON.stringify(config)})`);
    if (result.error) throw new Error(result.error);
    const name = `${source.replace(/[:.]/g, '-')}-${targetKb}k${grayscale ? '-gray' : ''}`;
    mkdirSync('test-files/out', { recursive: true });
    writeFileSync(`test-files/out/${name}.pdf`, Buffer.from(result.pdf, 'base64'));
    result.pages.forEach((png, i) => writeFileSync(`test-files/out/${name}-p${i + 1}.png`, Buffer.from(png, 'base64')));
    console.log(`Wrote test-files/out/${name}.pdf and ${result.pages.length} page PNG(s): ${(result.bytes / 1000).toFixed(0)} KB at ${result.dpi} dpi, q ${result.quality}`);
  } else if (command === 'csp') {
    console.log(await page.evaluate('cspCheck()'));
  } else if (command === 'encode') {
    for (const dpi of [100, 150, 200, 300]) console.log(await page.evaluate(`encodeBench(${dpi})`));
  } else {
    const grayscale = process.env.GRAY === '1';
    const isPhotos = command === 'photos';
    const [first, second, ...rest] = args;
    const targetsKb = isPhotos ? rest : [second, ...rest].filter(Boolean);
    const targets = (targetsKb.length ? targetsKb : ['500', '1000', '2000', '5000']).map((kb) => Number(kb) * 1000);
    const config = isPhotos
      ? { count: Number(first), layout: second, targets, grayscale }
      : { url: `/test-files/${first}`, targets, grayscale };
    const result = await page.evaluate(`bench(${JSON.stringify(config)})`);
    const label = isPhotos ? `${first} generated photos, ${second}` : first;
    console.log(`${label}${grayscale ? ' (grayscale)' : ''}: ${(result.inputBytes / 1e6).toFixed(1)} MB`);
    for (const run of result.runs) {
      const outcome = run.error ?? `${(run.bytes / 1000).toFixed(0)} KB at ${run.dpi} dpi, q ${run.quality}`;
      console.log(
        `  target ${run.targetBytes / 1000} KB -> ${outcome} in ${(run.ms / 1000).toFixed(2)} s` +
          ` (main thread blocked >50 ms: ${run.longTasks}x, longest ${run.longestTaskMs.toFixed(0)} ms)`,
      );
      for (const a of run.attempts) {
        console.log(
          `      ${String(a.dpi).padStart(3)} dpi: ${String(a.pagesRendered).padStart(2)} pages, fits [${a.fittingQualities.join(', ')}],` +
            ` render ${a.renderMs.toFixed(0)} ms, encode ${a.encodeMs.toFixed(0)} ms`,
        );
      }
    }
  }
  page.close();
} finally {
  const exited = new Promise((resolve) => chrome.once('exit', resolve));
  chrome.kill();
  await exited;
  await server.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

/** Minimal DevTools-protocol client for the first page target. */
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
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
      console.log(`  [page ${message.params.type}]`, message.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (message.method === 'Runtime.exceptionThrown') {
      console.log('  [page exception]', message.params.exceptionDetails.exception?.description);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Runtime.enable');
  return {
    evaluate,
    async open(url) {
      await send('Page.navigate', { url });
      for (let i = 0; i < 200; i++) {
        if (await evaluate(`typeof window.bench === 'function'`).catch(() => false)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`${url} did not load`);
    },
    close: () => ws.close(),
  };
}
