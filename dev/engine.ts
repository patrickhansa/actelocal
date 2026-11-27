// Dev harness for the engine: run it on real files and see every attempt.
// Also exposes window.bench / window.makeSample / window.encodeBench for scripts/bench.mjs.

import {
  compressPdf,
  EngineError,
  photosToPdf,
  warmUpPdf,
  type AttemptLog,
  type EngineOptions,
  type EngineResult,
  type PhotoLayout,
} from '../src/engine';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { makeScanPdf } from './sample';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const filesInput = $<HTMLInputElement>('files');
const runButton = $<HTMLButtonElement>('run');
const cancelButton = $<HTMLButtonElement>('cancel');
const logBox = $<HTMLPreElement>('log');
const download = $<HTMLAnchorElement>('download');
const preview = $<HTMLImageElement>('preview');

const kb = (bytes: number) => `${(bytes / 1000).toFixed(0)} KB`;
const log = (line: string) => {
  logBox.textContent += `${line}\n`;
};
const describeAttempt = (a: AttemptLog) =>
  `  ${String(a.dpi).padStart(3)} dpi: ${a.pagesRendered} page(s) rendered, ` +
  `fits at [${a.fittingQualities.join(', ')}], render ${a.renderMs.toFixed(0)} ms, encode ${a.encodeMs.toFixed(0)} ms`;

void warmUpPdf();

let controller: AbortController | null = null;

runButton.onclick = async () => {
  const files = [...(filesInput.files ?? [])];
  if (files.length === 0) return;
  controller = new AbortController();
  runButton.disabled = true;
  cancelButton.disabled = false;
  logBox.textContent = '';
  download.hidden = true;
  preview.removeAttribute('src');

  const options: EngineOptions = {
    targetBytes: Number($<HTMLSelectElement>('target').value),
    grayscale: $<HTMLInputElement>('gray').checked,
    signal: controller.signal,
    onAttempt: (a) => log(describeAttempt(a)),
  };
  const inputBytes = files.reduce((sum, f) => sum + f.size, 0);
  log(`Input: ${files.length} file(s), ${kb(inputBytes)}, target ${kb(options.targetBytes)}`);

  const start = performance.now();
  try {
    const isPdf = files[0].type === 'application/pdf' || files[0].name.toLowerCase().endsWith('.pdf');
    const result = isPdf
      ? await compressPdf(files[0], options)
      : await photosToPdf(
          files.map((file) => ({ file, rotation: 0 as const })),
          { ...options, layout: $<HTMLSelectElement>('layout').value as PhotoLayout },
        );
    showResult(result, performance.now() - start);
  } catch (error) {
    log(error instanceof EngineError ? `EngineError: ${error.code} ${JSON.stringify(error.detail)}` : String(error));
    console.error(error);
  } finally {
    runButton.disabled = false;
    cancelButton.disabled = true;
  }
};

cancelButton.onclick = () => controller?.abort();

function showResult(result: EngineResult, ms: number) {
  log(
    result.unchanged
      ? `Already under the target: returned unchanged (${result.pageCount} pages).`
      : `Result: ${kb(result.pdf.length)}, ${result.pageCount} pages, ${result.dpi} dpi, quality ${result.quality}`,
  );
  log(`Total time: ${(ms / 1000).toFixed(2)} s`);

  const blob = new Blob([result.pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
  download.href = URL.createObjectURL(blob);
  download.download = `result-${result.dpi}dpi-q${result.quality}.pdf`;
  download.hidden = false;

  if (result.preview) {
    // 100% zoom in a PDF viewer shows 1 pt as 96/72 CSS pixels.
    preview.style.width = `${(result.firstPageSize.widthPt * 96) / 72}px`;
    preview.src = URL.createObjectURL(result.preview);
  }
}

// ---- Hooks for scripts/bench.mjs ----

interface BenchConfig {
  url: string;
  targets: number[];
  grayscale?: boolean;
}

interface PhotoBenchConfig {
  count: number;
  targets: number[];
  layout: PhotoLayout;
  grayscale?: boolean;
  /** EXIF orientation to stamp on the generated photos (6 = phone held upright). */
  exif?: number;
}

/** Inserts an EXIF block with just an Orientation tag after the JPEG's JFIF header. */
function withExifOrientation(jpeg: ArrayBuffer, orientation: number): ArrayBuffer {
  const src = new Uint8Array(jpeg);
  // SOI (2 bytes), then APP0 whose length field follows its marker.
  const afterApp0 = 4 + ((src[4] << 8) | src[5]);
  const tiff = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0];
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]; // "Exif\0\0" + TIFF
  const segment = [0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
  const out = new Uint8Array(src.length + segment.length);
  out.set(src.subarray(0, afterApp0));
  out.set(segment, afterApp0);
  out.set(src.subarray(afterApp0), afterApp0 + segment.length);
  return out.buffer;
}

/** Compresses to each target; `files` is either a fetched PDF or generated photos. */
async function bench(config: BenchConfig | PhotoBenchConfig) {
  let inputBytes: number;
  let job: (options: EngineOptions) => Promise<EngineResult>;
  if ('url' in config) {
    const blob = await (await fetch(config.url)).blob();
    const file = new File([blob], config.url.split('/').pop()!, { type: 'application/pdf' });
    inputBytes = file.size;
    job = (options) => compressPdf(file, options);
  } else {
    const plain = await makeScanPdfPageJpeg();
    const jpeg = config.exif ? withExifOrientation(plain, config.exif) : plain;
    const photos = Array.from({ length: config.count }, (_, i) => ({
      file: new File([jpeg], `photo-${i}.jpg`, { type: 'image/jpeg' }),
      rotation: ((i % 4) * 90) as 0 | 90 | 180 | 270,
    }));
    inputBytes = jpeg.byteLength * config.count;
    job = (options) => photosToPdf(photos, { ...options, layout: config.layout });
  }

  const runs = [];
  for (const targetBytes of config.targets) {
    const attempts: AttemptLog[] = [];
    const longTasks: number[] = [];
    const observer = new PerformanceObserver((list) => list.getEntries().forEach((e) => longTasks.push(e.duration)));
    observer.observe({ type: 'longtask' });
    const start = performance.now();
    const timing = () => ({
      ms: performance.now() - start,
      longTasks: longTasks.length,
      longestTaskMs: Math.max(0, ...longTasks),
    });
    try {
      const r = await job({ targetBytes, grayscale: config.grayscale ?? false, onAttempt: (a) => attempts.push(a) });
      const pdf = (config as { keepPdf?: boolean }).keepPdf ? r.pdf : undefined;
      runs.push({ targetBytes, ...timing(), bytes: r.pdf.length, dpi: r.dpi, quality: r.quality, attempts, pdf });
    } catch (error) {
      runs.push({ targetBytes, ...timing(), error: String((error as EngineError).code ?? error), attempts });
    } finally {
      observer.disconnect();
    }
  }
  return { inputBytes, runs };
}

/**
 * Runs one job and returns the output PDF plus every page rendered back by pdf.js at
 * 96 dpi (what a viewer shows at 100%), as base64, to check the result by eye.
 */
async function snapshot(config: BenchConfig | PhotoBenchConfig) {
  const result = await bench({ ...config, targets: [config.targets[0]], keepPdf: true } as never);
  const run = result.runs[0] as { pdf?: Uint8Array; error?: string };
  if (!run.pdf) return { error: run.error };
  const { openPdf } = await import('../src/engine/pdf-source');
  const doc = await openPdf(run.pdf.slice());
  const pages: string[] = [];
  for (const page of doc.pages) {
    const pxPerPt = 96 / 72;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(page.widthPt * pxPerPt);
    canvas.height = Math.round(page.heightPt * pxPerPt);
    await page.draw(canvas.getContext('2d')!, pxPerPt);
    pages.push(await toBase64(await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'))));
  }
  await doc.close();
  return { ...result.runs[0], pdf: await toBase64(new Blob([run.pdf as Uint8Array<ArrayBuffer>])), pages };
}

async function makeSample(pages: number, noise: number): Promise<string> {
  const pdf = await makeScanPdf(pages, noise);
  return toBase64(new Blob([pdf as Uint8Array<ArrayBuffer>]));
}

/** Times sequential versus parallel JPEG encoding of one page-sized canvas. */
async function encodeBench(dpi: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(8.27 * dpi);
  canvas.height = Math.round(11.69 * dpi);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const sample = await createImageBitmap(new Blob([await makeScanPdfPageJpeg()]));
  ctx.drawImage(sample, 0, 0, canvas.width, canvas.height);
  const qualities = [0.55, 0.65, 0.75, 0.85];
  const encode = (q: number) => new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/jpeg', q));

  let start = performance.now();
  for (const q of qualities) await encode(q);
  const sequentialMs = performance.now() - start;
  start = performance.now();
  await Promise.all(qualities.map(encode));
  const parallelMs = performance.now() - start;
  return { dpi, pixels: canvas.width * canvas.height, sequentialMs, parallelMs };
}

/** One page of the synthetic scan as JPEG bytes, cached. */
let samplePage: ArrayBuffer | null = null;
async function makeScanPdfPageJpeg(): Promise<ArrayBuffer> {
  if (samplePage) return samplePage;
  const doc = await PDFDocument.load(await makeScanPdf(1));
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && object.dict.get(PDFName.of('Filter')) === PDFName.of('DCTDecode')) {
      samplePage = object.contents.slice().buffer as ArrayBuffer;
      return samplePage;
    }
  }
  throw new Error('no JPEG found');
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(blob);
  });
}

/**
 * Checks what the Content-Security-Policy allows: pdf.js's WebAssembly decoders must load
 * and compile, and a request to another origin must be blocked. Uses a .invalid host, which
 * never resolves, so nothing can leave the machine even if the policy were missing.
 */
async function cspCheck() {
  const results: Record<string, string> = {};
  for (const name of ['jbig2.wasm', 'openjpeg.wasm', 'qcms_bg.wasm']) {
    try {
      await WebAssembly.compileStreaming(fetch(`/pdfjs/wasm/${name}`));
      results[name] = 'compiled';
    } catch (error) {
      results[name] = String(error);
    }
  }
  let violation = '';
  const onViolation = (e: SecurityPolicyViolationEvent) => (violation = e.effectiveDirective);
  document.addEventListener('securitypolicyviolation', onViolation);
  await fetch('https://csp-check.invalid/upload', { method: 'POST', body: 'x' }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 100)); // the violation event is queued
  document.removeEventListener('securitypolicyviolation', onViolation);
  results.uploadToOtherOrigin = violation ? `blocked by ${violation}` : 'NOT blocked by the CSP';
  return results;
}

Object.assign(window, { bench, snapshot, makeSample, encodeBench, cspCheck });
