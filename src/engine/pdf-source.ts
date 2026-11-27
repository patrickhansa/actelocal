// PDF file → one PageSource per page, rendered by pdf.js. See docs/engine-design.md §3.
// The only module that imports pdf.js, and it is loaded on demand.

import { AnnotationMode, GlobalWorkerOptions, PDFWorker, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { EngineError, type PageSource } from './types';

GlobalWorkerOptions.workerSrc = workerUrl;

/** Where vite.config.ts serves pdf.js's WebAssembly decoders. */
const WASM_URL = '/pdfjs/wasm/';

let sharedWorker: PDFWorker | null = null;

/** One pdf.js worker for the whole visit, so later files skip its startup. */
function pdfWorker(): PDFWorker {
  if (!sharedWorker || sharedWorker.destroyed) sharedWorker = new PDFWorker();
  return sharedWorker;
}

/** Starts the pdf.js worker ahead of time. */
export function warmUp(): void {
  pdfWorker();
}

export interface PdfDocument {
  pages: PageSource[];
  close(): Promise<void>;
}

/** Opens a PDF from its bytes. pdf.js takes ownership of `data`. */
export async function openPdf(data: Uint8Array): Promise<PdfDocument> {
  const task = getDocument({ data, worker: pdfWorker(), wasmUrl: WASM_URL });
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
