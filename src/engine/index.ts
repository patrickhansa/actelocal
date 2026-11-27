// Public API of the engine. See docs/engine-design.md §7.

import { assemblePdf } from './assemble';
import {
  BITONAL_ANALYSIS_DPI,
  BITONAL_MAX_COLOUR_FRACTION,
  BITONAL_MAX_MID_FRACTION,
  BITONAL_QUALITY,
  MAX_PARALLEL_ENCODE_PIXELS,
} from './config';
import { imageEncoder, type EncodedImage } from './encoder';
import { photoPages } from './photo-source';
import { Rasterizer, pixelsPerPoint } from './raster';
import { searchSettings } from './search';
import {
  EngineError,
  type EngineOptions,
  type EngineResult,
  type PageSource,
  type PdfInfo,
  type PhotoInput,
  type PhotoLayout,
} from './types';

export * from './types';

/**
 * What a PDF is made of, so the page can warn before compressing: a signature or an XFA
 * form won't survive, and digitally made pages usually grow when turned into images.
 */
export async function inspectPdf(file: File): Promise<PdfInfo> {
  if (!(await looksLikePdf(file))) throw new EngineError('invalid-pdf');
  const { inspect } = await import('./pdf-source');
  return inspect(new Uint8Array(await file.arrayBuffer()));
}

/** Shrinks a PDF under `options.targetBytes`. */
export async function compressPdf(file: File, options: EngineOptions): Promise<EngineResult> {
  if (!(await looksLikePdf(file))) throw new EngineError('invalid-pdf');

  const { openPdf } = await import('./pdf-source');
  const doc = await openPdf(new Uint8Array(await file.arrayBuffer()));
  try {
    if (doc.pages.length === 0) throw new EngineError('no-pages');
    if (file.size <= options.targetBytes && !options.grayscale) {
      return {
        pdf: new Uint8Array(await file.arrayBuffer()),
        pageCount: doc.pages.length,
        dpi: 0,
        quality: 0,
        encoding: 'unchanged',
        preview: null,
        firstPageSize: sizeOf(doc.pages[0]),
        unchanged: true,
      };
    }
    return await compressPages(doc.pages, options, options.bitonal !== false);
  } finally {
    await doc.close();
  }
}

/** Puts photos on A4 pages, in one PDF under `options.targetBytes`. */
export async function photosToPdf(
  photos: readonly PhotoInput[],
  options: EngineOptions & { layout: PhotoLayout },
): Promise<EngineResult> {
  if (photos.length === 0) throw new EngineError('no-pages');
  // Photos are never black-and-white documents in the sense that matters here: no G4.
  return compressPages(await photoPages(photos, options.layout), options, false);
}

/** Where encoding runs in this browser, for diagnostics: e.g. "3 workers" or "main thread". */
export function encoderInfo(): string {
  return imageEncoder().describe();
}

/** Loads pdf.js and starts its workers in the background, so the first PDF starts sooner. */
export async function warmUpPdf(): Promise<void> {
  imageEncoder();
  (await import('./pdf-source')).warmUp();
}

async function compressPages(
  pages: readonly PageSource[],
  options: EngineOptions,
  allowBitonal: boolean,
): Promise<EngineResult> {
  const raster = new Rasterizer(options.grayscale);
  try {
    const bitonal = allowBitonal && (await looksBlackAndWhite(pages, raster));
    raster.mode = bitonal ? 'bitonal' : 'jpeg';
    const result = await searchSettings<EncodedImage>({
      pageCount: pages.length,
      targetBytes: options.targetBytes,
      renderPage: (index, dpi) => raster.render(pages[index], dpi),
      assemble: (images) => assemblePdf(pages, images),
      qualities: bitonal ? { normal: [BITONAL_QUALITY], lastResort: [BITONAL_QUALITY] } : undefined,
      // A black-and-white page is one job on one worker, so encode several pages at once.
      // (A JPEG page already spreads its qualities across the workers.)
      pagesInFlight: bitonal ? (dpi) => pagesInFlight(pages[0], dpi) : undefined,
      onProgress: options.onProgress,
      onAttempt: options.onAttempt,
      signal: options.signal,
    });
    const first = result.jpegs[0];
    return {
      pdf: result.pdf,
      pageCount: pages.length,
      dpi: result.dpi,
      quality: result.quality,
      encoding: bitonal ? 'bitonal' : 'jpeg',
      preview: first.format === 'jpeg' ? first.blob : await bitonalPreview(raster, pages[0], result.dpi),
      firstPageSize: sizeOf(pages[0]),
      unchanged: false,
    };
  } finally {
    raster.dispose();
  }
}

/**
 * Whether the document already looks black and white: renders the first, middle and last
 * page and checks they have almost no mid-gray or coloured pixels.
 */
async function looksBlackAndWhite(pages: readonly PageSource[], raster: Rasterizer): Promise<boolean> {
  const samples = [...new Set([0, Math.floor(pages.length / 2), pages.length - 1])];
  for (const index of samples) {
    const page = await raster.render(pages[index], BITONAL_ANALYSIS_DPI);
    try {
      const { midFraction, colourFraction } = await page.analyze();
      if (midFraction > BITONAL_MAX_MID_FRACTION || colourFraction > BITONAL_MAX_COLOUR_FRACTION) return false;
    } finally {
      page.release();
    }
  }
  return true;
}

/** Pages that may encode at once: one per worker, capped by pixels in flight (memory). */
function pagesInFlight(page: PageSource, dpi: number): number {
  const pxPerPt = pixelsPerPoint(page, dpi);
  const pixels = page.widthPt * pxPerPt * page.heightPt * pxPerPt;
  return Math.max(1, Math.min(imageEncoder().parallelism(), Math.floor(MAX_PARALLEL_ENCODE_PIXELS / pixels)));
}

async function bitonalPreview(raster: Rasterizer, page: PageSource, dpi: number): Promise<Blob> {
  const rendered = await raster.render(page, dpi);
  try {
    return await rendered.bitonalPreview();
  } finally {
    rendered.release();
  }
}

function sizeOf({ widthPt, heightPt }: PageSource) {
  return { widthPt, heightPt };
}

/** A PDF starts with "%PDF-" within its first kilobyte. */
async function looksLikePdf(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  return new TextDecoder('latin1').decode(head).includes('%PDF-');
}
