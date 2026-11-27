// PDF file → one PageSource per page, rendered by pdf.js. See docs/engine-design.md §3.
// The only module that imports pdf.js, and it is loaded on demand.

import {
  AnnotationMode,
  GlobalWorkerOptions,
  OPS,
  PDFWorker,
  getDocument,
  version as pdfjsVersion,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { SCANNED_PAGE_COVERAGE, largestImageCoverage } from './classify';
import { EngineError, type PageSource, type PdfInfo } from './types';

GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Where vite.config.ts serves pdf.js's WebAssembly decoders. The version in the path lets
 * browsers cache them for good (public/_headers), so they work offline once fetched.
 */
export const WASM_URL = `/pdfjs/${pdfjsVersion}/wasm/`;
const WASM_FILES = ['jbig2.wasm', 'openjpeg.wasm', 'qcms_bg.wasm'];

let sharedWorker: PDFWorker | null = null;

/** One pdf.js worker for the whole visit, so later files skip its startup. */
function pdfWorker(): PDFWorker {
  if (!sharedWorker || sharedWorker.destroyed) sharedWorker = new PDFWorker();
  return sharedWorker;
}

/**
 * Starts the pdf.js worker and loads its decoders into memory ahead of time, so the first
 * PDF starts sooner and nothing at all is downloaded while a file is processed.
 */
export function warmUp(): void {
  pdfWorker();
  for (const name of WASM_FILES) void wasmBytes(name).catch(() => undefined);
}

const wasmCache = new Map<string, Promise<Uint8Array>>();

/** A decoder's bytes, downloaded once per visit. */
function wasmBytes(name: string): Promise<Uint8Array> {
  let bytes = wasmCache.get(name);
  if (!bytes) {
    bytes = fetch(WASM_URL + name)
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(response.statusText))))
      .then((buffer) => new Uint8Array(buffer));
    bytes.catch(() => wasmCache.delete(name)); // allow a retry
    wasmCache.set(name, bytes);
  }
  return bytes;
}

/**
 * pdf.js asks this for its decoders (with `useWorkerFetch: false`) instead of fetching them
 * itself, so they come from memory. Hands out copies: pdf.js may transfer the buffer away.
 */
class PreloadedBinaryData {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    if (kind !== 'wasmUrl') throw new Error(`No ${kind} data is shipped`); // pdf.js falls back to system fonts
    return (await wasmBytes(filename)).slice();
  }
}

/** Options every getDocument() call shares. */
const documentOptions = {
  wasmUrl: WASM_URL,
  useWorkerFetch: false,
  BinaryDataFactory: PreloadedBinaryData,
};

export interface PdfDocument {
  pages: PageSource[];
  close(): Promise<void>;
}

/** Opens a PDF from its bytes. pdf.js takes ownership of `data`. */
export async function openPdf(data: Uint8Array): Promise<PdfDocument> {
  const task = getDocument({ data, worker: pdfWorker(), ...documentOptions });
  try {
    const doc = await task.promise;
    const pageNumbers = Array.from({ length: doc.numPages }, (_, i) => i + 1);
    const pages = await Promise.all(
      pageNumbers.map(async (pageNumber) => {
        // Size at scale 1 already includes the crop box and the page's /Rotate.
        const { width, height } = (await doc.getPage(pageNumber)).getViewport({ scale: 1 });
        return new PdfPage(doc, pageNumber, width, height);
      }),
    );
    return { pages, close: () => task.destroy() };
  } catch (error) {
    await task.destroy();
    throw toEngineError(error);
  }
}

/** Reads what a PDF is made of: signature, XFA form, scanned or digital pages. */
export async function inspect(data: Uint8Array): Promise<PdfInfo> {
  const task = getDocument({ data, worker: pdfWorker(), ...documentOptions });
  try {
    const doc = await task.promise;
    const { info } = (await doc.getMetadata()) as { info: Record<string, unknown> };
    const samples = [...new Set([1, Math.ceil(doc.numPages / 2), doc.numPages])];
    const scanned = await Promise.all(
      samples.map(async (pageNumber) => {
        const page = await doc.getPage(pageNumber);
        try {
          const { fnArray, argsArray } = await page.getOperatorList({
            intent: 'print',
            annotationMode: AnnotationMode.ENABLE_STORAGE,
          });
          const [x0, y0, x1, y1] = page.view; // crop box, in points
          const area = Math.abs((x1 - x0) * (y1 - y0));
          return largestImageCoverage(fnArray, argsArray, area, OPS) >= SCANNED_PAGE_COVERAGE;
        } finally {
          page.cleanup();
        }
      }),
    );
    const scannedCount = scanned.filter(Boolean).length;
    return {
      pageCount: doc.numPages,
      signed: info.IsSignaturesPresent === true,
      xfa: info.IsXFAPresent === true,
      kind: scannedCount === samples.length ? 'scanned' : scannedCount === 0 ? 'digital' : 'mixed',
    };
  } catch (error) {
    throw toEngineError(error);
  } finally {
    await task.destroy();
  }
}

class PdfPage implements PageSource {
  readonly widthPt: number;
  readonly heightPt: number;
  private readonly doc: PDFDocumentProxy;
  private readonly pageNumber: number;

  constructor(doc: PDFDocumentProxy, pageNumber: number, widthPt: number, heightPt: number) {
    this.doc = doc;
    this.pageNumber = pageNumber;
    this.widthPt = widthPt;
    this.heightPt = heightPt;
  }

  async draw(ctx: CanvasRenderingContext2D, pxPerPt: number): Promise<void> {
    const page = await this.doc.getPage(this.pageNumber);
    try {
      await page.render({
        canvas: ctx.canvas,
        viewport: page.getViewport({ scale: pxPerPt }),
        // Render the way pdf.js prints: filled-in form fields are drawn into the
        // image instead of being left to a separate on-screen layer.
        intent: 'print',
        annotationMode: AnnotationMode.ENABLE_STORAGE,
      }).promise;
    } finally {
      // Free the page's decoded images now; one page in memory at a time.
      page.cleanup();
    }
  }
}

function toEngineError(error: unknown): EngineError {
  if (error instanceof EngineError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'PasswordException') return new EngineError('password-protected', {}, { cause: error });
  return new EngineError('invalid-pdf', {}, { cause: error });
}
