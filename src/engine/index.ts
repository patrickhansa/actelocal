// Public API of the engine. See docs/engine-design.md §7.

import { assemblePdf } from './assemble';
import { jpegEncoder } from './encoder';
import { photoPages } from './photo-source';
import { Rasterizer } from './raster';
import { searchSettings } from './search';
import {
  EngineError,
  type EngineOptions,
  type EngineResult,
  type PageSource,
  type PhotoInput,
  type PhotoLayout,
} from './types';

export * from './types';

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
        preview: null,
        firstPageSize: sizeOf(doc.pages[0]),
        unchanged: true,
      };
    }
    return await compressPages(doc.pages, options);
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
  return compressPages(await photoPages(photos, options.layout), options);
}

/** Where JPEG encoding runs in this browser, for diagnostics: e.g. "3 workers" or "main thread". */
export function encoderInfo(): string {
  return jpegEncoder().describe();
}

/** Loads pdf.js and starts its worker in the background, so the first PDF starts sooner. */
export async function warmUpPdf(): Promise<void> {
  jpegEncoder();
  (await import('./pdf-source')).warmUp();
}

async function compressPages(pages: readonly PageSource[], options: EngineOptions): Promise<EngineResult> {
  const raster = new Rasterizer(options.grayscale);
  try {
    const result = await searchSettings<Blob>({
      pageCount: pages.length,
      targetBytes: options.targetBytes,
      renderPage: (index, dpi) => raster.render(pages[index], dpi),
      assemble: (jpegs) => assemblePdf(pages, jpegs),
      onProgress: options.onProgress,
      onAttempt: options.onAttempt,
      signal: options.signal,
    });
    return {
      pdf: result.pdf,
      pageCount: pages.length,
      dpi: result.dpi,
      quality: result.quality,
      preview: result.jpegs[0],
      firstPageSize: sizeOf(pages[0]),
      unchanged: false,
    };
  } finally {
    raster.dispose();
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
