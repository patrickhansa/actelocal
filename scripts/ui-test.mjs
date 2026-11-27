// End-to-end test of the real pages in headless Chrome: picks files the way a user would,
// presses the buttons and checks what the page shows. Each tool runs with the network cut
// off after the page has loaded, and the test counts requests made while processing (the
// privacy promise is that there are none). Saves screenshots at phone and desktop size. Dev only.
//
//   node scripts/ui-test.mjs                                    production build + production headers
//   BASE=https://actelocal.pages.dev node scripts/ui-test.mjs   the live site
//   SHOTS=docs/screenshots node scripts/ui-test.mjs             where README screenshots go (test-files/out/ui by default)
//
// Uses public-domain test files from test-files/web/ (see docs/engine-design.md §9);
// test-files/real/ is used, if present, only for checks whose screenshots stay in test-files/.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build, preview } from 'vite';
import { launchChrome } from './chrome.mjs';

const PORT = 5198;
let server = null;
let base = process.env.BASE;
if (!base) {
  await build({ logLevel: 'warn' });
  server = await preview({ preview: { port: PORT, strictPort: true }, logLevel: 'warn' });
  base = `http://localhost:${PORT}`;
}
// Full-page shots of every step go to test-files/out/ui; README-sized ones (public files only) to SHOTS.
const shots = 'test-files/out/ui';
const privateShots = shots;
const readmeShots = process.env.SHOTS ?? shots;
mkdirSync(shots, { recursive: true });
mkdirSync(readmeShots, { recursive: true });
const testFile = (path) => resolve('test-files', path);

const browser = await launchChrome();
const { page } = browser;
let failures = 0;
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures++;
};

let requests = [];
page.on('Network.requestWillBeSent', ({ request }) => {
  if (!/^(blob|data):/.test(request.url)) requests.push(request.url);
});
await page.send('Network.enable');
await page.send('Page.enable');
await page.send('DOM.enable');
// THEME=dark for dark-mode screenshots.
await page.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: process.env.THEME === 'dark' ? 'dark' : 'light' }],
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const offline = (on) =>
  page.send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
const click = (selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const clickText = (selector, text) =>
  page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.innerText.includes(${JSON.stringify(text)})).click()`);
const textOf = (selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);

async function viewport(kind) {
  const phone = kind === 'phone';
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: phone ? 390 : 1280,
    height: phone ? 844 : 900,
    deviceScaleFactor: phone ? 2 : 1,
    mobile: phone,
  });
}

async function screenshot(name, dir = shots) {
  const { cssContentSize } = await page.send('Page.getLayoutMetrics');
  const { data } = await page.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: cssContentSize.width, height: Math.min(cssContentSize.height, 4000), scale: 1 },
  });
  writeFileSync(`${dir}/${name}.png`, Buffer.from(data, 'base64'));
}

/** A phone-screen-sized shot with `selector` scrolled to the top, for the README (SHOTS dir). */
async function readmeShot(name, selector) {
  await page.evaluate(`window.scrollTo(0, document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().top + scrollY - 16)`);
  await pause(300);
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${readmeShots}/${name}.png`, Buffer.from(data, 'base64'));
}

async function chooseFiles(paths) {
  const { root } = await page.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await page.send('DOM.setFileInputFiles', { nodeId, files: paths });
}

/** Whether the page scrolls sideways (it never should, even on a phone). */
const scrollsSideways = () => page.evaluate('document.documentElement.scrollWidth > window.innerWidth + 1');

/** Opens a tool, waits for it to warm up, then cuts the network. */
async function openOffline(path) {
  await page.open(`${base}${path}`, `!!document.querySelector('.dropzone')`);
  await pause(3000); // the page loads the engine while idle
  await offline(true);
  requests = [];
}

async function waitForOutcome() {
  return page.waitFor(
    `document.querySelector('.result-card, .card.alert.error') ? document.querySelector('.job').innerText : null`,
    180_000,
  );
}

try {
  // ---- Compress a PDF: a black-and-white scan, at phone and desktop size ----
  for (const kind of ['phone', 'desktop']) {
    await viewport(kind);
    await openOffline('/compress-pdf/');
    await screenshot(`${kind}-pdf-1-start`);
    check(!(await scrollsSideways()), `${kind}: PDF page doesn't scroll sideways`);
    await chooseFiles([testFile('web/nasa-19650014783/nasa-19650014783.pdf')]);
    await page.waitFor(`document.querySelector('.file-summary')?.innerText.includes('pagini')`);
    await clickText('.target-picker .chip', '500 KB');
    await screenshot(`${kind}-pdf-2-chosen`);
    await click('.options .button.primary');
    const outcome = await waitForOutcome();
    await screenshot(`${kind}-pdf-3-result`);
    if (kind === 'phone') await readmeShot('pdf-result', '.result-card');
    await offline(false);
    check(outcome.includes('Gata'), `${kind}: scan compressed offline: ${outcome.split('\n').slice(1, 3).join(' | ')}`);
    check(outcome.includes('alb-negru'), `${kind}: black-and-white mode explained`);
    check(requests.length === 0, `${kind}: no network requests while processing (${requests.length}) ${requests.join(' ')}`);
    check(!(await scrollsSideways()), `${kind}: result (with a 100% preview) doesn't scroll sideways`);
  }

  await viewport('phone');

  // ---- Photos: three page photos, two per page, the first rotated ----
  await openOffline('/photos-to-pdf/');
  await screenshot('phone-photos-1-start');
  const photos = [1, 2, 3].map((n) => testFile(`web/ia-royal-typewriter/photo-${n}.jpg`));
  await chooseFiles(photos);
  await page.waitFor(`document.querySelectorAll('.photo-card canvas').length === 3 &&
    [...document.querySelectorAll('.photo-card canvas')].every((c) => c.width > 1)`);
  await clickText('.chip', 'Două poze');
  await click('.photo-card .icon-button:nth-of-type(2)'); // rotate the first photo
  check((await textOf('.photo-grid')).includes('Pag. 2, sus'), 'two per page: photo 3 is labelled page 2, top');
  await pause(400); // let the rotation animation finish
  await screenshot('phone-photos-2-chosen');
  await readmeShot('photos', 'h1');
  await click('.options .button.primary');
  const photoOutcome = await waitForOutcome();
  await clickText('.preview-zoom .button', 'Toată pagina');
  check(await page.evaluate(`document.querySelector('.preview-frame').classList.contains('fit')`), 'preview switches to whole page');
  await screenshot('phone-photos-3-result');
  await offline(false);
  check(photoOutcome.includes('Gata'), `photos made into a PDF offline: ${photoOutcome.split('\n').slice(1, 3).join(' | ')}`);
  check(photoOutcome.includes('GPS'), 'photo metadata note shown');
  check(requests.length === 0, `no network requests while processing photos (${requests.length})`);
  check(!(await scrollsSideways()), "photos page doesn't scroll sideways");

  // ---- A file that isn't a PDF ----
  await page.open(`${base}/compress-pdf/`, `!!document.querySelector('.dropzone')`);
  await chooseFiles([photos[0]]);
  await page.waitFor(`document.querySelector('.notes')?.innerText.length > 0`);
  check((await textOf('.notes')).includes('nu este un PDF'), 'a photo in the PDF tool is refused');

  // ---- A file already under the limit ----
  if (existsSync(testFile('real/camscanner.pdf'))) {
    await page.open(`${base}/compress-pdf/`, `!!document.querySelector('.dropzone')`);
    await chooseFiles([testFile('real/camscanner.pdf')]);
    await page.waitFor(`document.querySelector('.file-summary')?.innerText.includes('pagin')`);
    await clickText('.target-picker .chip', '1 MB');
    check((await textOf('.notes')).includes('deja sub limită'), 'small file: "already under the limit" note');
    await click('.options .button.primary');
    check((await waitForOutcome()).includes('Nu e nevoie'), 'small file is returned untouched');
  }

  // ---- Warnings: a signed digital invoice, an ANAF form ----
  for (const [name, expected] of [
    ['real/factura-gaze.pdf', ['semnătură electronică', 'creat pe calculator']],
    ['real/bilant.pdf', ['semnătură electronică', 'formular ANAF']],
  ]) {
    if (!existsSync(testFile(name))) continue;
    await page.open(`${base}/compress-pdf/`, `!!document.querySelector('.dropzone')`);
    await chooseFiles([testFile(name)]);
    await page.waitFor(`document.querySelector('.file-summary')?.innerText.includes('pagin')`);
    const notes = await textOf('.notes');
    for (const text of expected) check(notes.includes(text), `${name}: warns "${text}"`);
    await screenshot(`phone-warnings-${name.split('/').pop().replace('.pdf', '')}`, privateShots);
  }

  // ---- Home ----
  await page.open(`${base}/`, `!!document.querySelector('.tools')`);
  await screenshot('phone-home');
  check(!(await scrollsSideways()), "home doesn't scroll sideways");
} finally {
  await browser.close();
  await server?.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
