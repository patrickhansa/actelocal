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

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { build, createServer, preview } from 'vite';
import { launchChrome } from './chrome.mjs';

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
const browser = await launchChrome();

try {
  const { page } = browser;
  // MAIN_THREAD=1 forces the encoder's main-thread fallback (no OffscreenCanvas).
  await page.open(
    `http://localhost:${DEV_PORT}/dev/engine.html${process.env.MAIN_THREAD === '1' ? '?main-thread' : ''}`,
    `typeof window.bench === 'function'`,
  );
  const gpu = await page.evaluate(`(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'none';
  })()`);
  console.log(`GPU: ${gpu}`);

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
    const zoom = Number(process.env.ZOOM ?? 1); // ZOOM=2: render the result pages at 200%
    // photos:<count>:<layout>[:<exif orientation>]
    const [, count, layout, exif] = source.split(':');
    const config = source.startsWith('photos:')
      ? { count: Number(count), layout, exif: Number(exif ?? 0), targets, grayscale, zoom }
      : { url: `/test-files/${source}`, targets, grayscale, zoom };
    const result = await page.evaluate(`snapshot(${JSON.stringify(config)})`);
    if (result.error) throw new Error(result.error);
    const name = `${source.split('/').pop().replace(/[:.]/g, '-')}-${targetKb}k${grayscale ? '-gray' : ''}`;
    mkdirSync('test-files/out', { recursive: true });
    writeFileSync(`test-files/out/${name}.pdf`, Buffer.from(result.pdf, 'base64'));
    result.pages.forEach((png, i) => writeFileSync(`test-files/out/${name}-p${i + 1}.png`, Buffer.from(png, 'base64')));
    const encoding = result.encoding === 'bitonal' ? 'black & white (G4)' : `JPEG q ${result.quality}`;
    console.log(`Wrote test-files/out/${name}.pdf and ${result.pages.length} page PNG(s): ${(result.bytes / 1000).toFixed(0)} KB at ${result.dpi} dpi, ${encoding}`);
  } else if (command === 'inspect') {
    // inspect <file in test-files>...: page count, XFA, form fields, signatures
    console.table(await page.evaluate(`inspect(${JSON.stringify(args.map((f) => `/test-files/${f}`))})`));
  } else if (command === 'photo-steps') {
    console.table(await page.evaluate(`photoSteps(${JSON.stringify(args[0].split(',').map((f) => `/test-files/${f}`))})`));
  } else if (command === 'bw-stats') {
    // bw-stats <file in test-files>...: how black-and-white the sampled pages look
    const report = await page.evaluate(`bitonalStats(${JSON.stringify(args.map((f) => `/test-files/${f}`))})`);
    for (const [file, line] of Object.entries(report)) console.log(`${file.padEnd(32)} ${line}`);
  } else if (command === 'g4') {
    // Round trip of the G4 encoder through pdf.js's CCITT decoder.
    console.table(await page.evaluate('g4RoundTrip()'));
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
    // photos <count> <layout>: generated photos; photos <a.jpg,b.jpg> <layout>: files in test-files
    const realPhotos = isPhotos && /\.jpe?g/i.test(first);
    const config = isPhotos
      ? realPhotos
        ? { urls: first.split(',').map((f) => `/test-files/${f}`), count: 0, layout: second, targets, grayscale }
        : { count: Number(first), layout: second, targets, grayscale }
      : { url: `/test-files/${first}`, targets, grayscale, bitonal: process.env.BITONAL !== '0' };
    // PROFILE=1: sample the page's main thread and list where its time went.
    if (process.env.PROFILE === '1') {
      await page.send('Profiler.enable');
      await page.send('Profiler.setSamplingInterval', { interval: 200 });
      await page.send('Profiler.start');
    }
    // TRACE=1: record a performance trace and break down every main-thread task over 50 ms.
    if (process.env.TRACE === '1') await page.startTrace();
    const result = await page.evaluate(`bench(${JSON.stringify(config)})`);
    if (process.env.PROFILE === '1') {
      const { profile } = await page.send('Profiler.stop');
      printProfile(profile);
    }
    if (process.env.TRACE === '1') printLongTasks(await page.stopTrace());
    const label = isPhotos ? `${realPhotos ? first.split(',').length : first} ${realPhotos ? '' : 'generated '}photos, ${second}` : first;
    console.log(`${label}${grayscale ? ' (grayscale)' : ''}: ${(result.inputBytes / 1e6).toFixed(1)} MB, encoding on ${result.encoder}`);
    for (const run of result.runs) {
      const outcome =
        run.error ??
        `${(run.bytes / 1000).toFixed(0)} KB at ${run.dpi} dpi, ${run.encoding === 'bitonal' ? 'black & white (G4)' : `JPEG q ${run.quality}`}`;
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
} finally {
  await browser.close();
  await server.close();
}

/** Prints the functions with the most main-thread self time in a CPU profile. */
function printProfile(profile) {
  const byNode = new Map(profile.nodes.map((n) => [n.id, n]));
  const selfMs = new Map();
  profile.timeDeltas.forEach((delta, i) => {
    const { callFrame } = byNode.get(profile.samples[i]);
    const file = callFrame.url.split('/').pop()?.split('?')[0] || 'native';
    const key = `${callFrame.functionName || '(anonymous)'}  [${file}:${callFrame.lineNumber + 1}]`;
    selfMs.set(key, (selfMs.get(key) ?? 0) + delta / 1000);
  });
  const total = [...selfMs.values()].reduce((a, b) => a + b, 0);
  console.log(`  main thread profile (${total.toFixed(0)} ms sampled), top self time:`);
  for (const [key, ms] of [...selfMs].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
    console.log(`    ${ms.toFixed(0).padStart(6)} ms  ${key}`);
  }
}

/** For each main-thread task over 50 ms in a trace, prints its longest child events. */
function printLongTasks(events) {
  const main = events.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
  if (!main) return console.log('  no renderer main thread in trace');
  const onMain = events.filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === 'X' && e.dur);
  const tasks = onMain.filter((e) => e.name === 'RunTask' && e.dur > 50_000);
  console.log(`  ${tasks.length} main-thread task(s) over 50 ms:`);
  for (const task of tasks) {
    const children = onMain
      .filter((e) => e !== task && e.ts >= task.ts && e.ts + e.dur <= task.ts + task.dur && e.dur > 5_000)
      .sort((a, b) => b.dur - a.dur)
      .slice(0, 5)
      .map((e) => `${e.name}${e.args?.data?.functionName ? `(${e.args.data.functionName})` : ''} ${(e.dur / 1000).toFixed(0)}ms`);
    console.log(`    ${(task.dur / 1000).toFixed(0)} ms: ${children.join(', ') || '(no child events)'}`);
  }
}
