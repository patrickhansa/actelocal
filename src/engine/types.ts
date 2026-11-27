/** One output page: its size and a way to draw it. See docs/engine-design.md §3. */
export interface PageSource {
  /** Output page size in PDF points (1 pt = 1/72 inch). */
  readonly widthPt: number;
  readonly heightPt: number;
  /**
   * Draw the page onto `ctx`, which is already filled white, sized to the page at
   * `pxPerPt` pixels per point and has an identity transform.
   */
  draw(ctx: CanvasRenderingContext2D, pxPerPt: number): Promise<void>;
}

export type Rotation = 0 | 90 | 180 | 270;

export interface PhotoInput {
  file: File;
  /** Clockwise rotation applied on top of the photo's own EXIF orientation. */
  rotation: Rotation;
}

export type PhotoLayout = 'one-per-page' | 'two-per-page';

/** What a PDF is made of, to warn before compressing. See docs/engine-design.md §10. */
export interface PdfInfo {
  pageCount: number;
  /** Has an electronic signature. Compressing makes a new, unsigned file. */
  signed: boolean;
  /** Contains an XFA form (as ANAF forms do). Its interactive content won't survive. */
  xfa: boolean;
  /**
   * From sampled pages (first, middle, last):
   * - 'scanned': every sampled page is mostly one image. Compressing works well.
   * - 'digital': no sampled page is. Text and drawings, which usually grow as images.
   * - 'mixed': some of each.
   */
  kind: 'scanned' | 'digital' | 'mixed';
}

export interface Progress {
  /** Resolution being tried. */
  dpi: number;
  /** 1 for the first resolution tried, 2 for the second, ... */
  attempt: number;
  /** Page being processed, 1-based. */
  page: number;
  pageCount: number;
}

/** One finished attempt at a resolution, for the dev harness. */
export interface AttemptLog {
  dpi: number;
  pagesRendered: number;
  /** Qualities that fit for the whole document (empty if the resolution was too big). */
  fittingQualities: number[];
  /** Time spent waiting for pages to render (rendering overlaps with encoding). */
  renderMs: number;
  /** Time spent waiting for JPEG encodes. */
  encodeMs: number;
}

export interface EngineOptions {
  /** Maximum output size in bytes, e.g. 1_000_000. */
  targetBytes: number;
  grayscale: boolean;
  /** Called before each page is rendered. */
  onProgress?: (progress: Progress) => void;
  /** Called after each resolution attempt. Development use. */
  onAttempt?: (attempt: AttemptLog) => void;
  /** Cancels the job; checked between pages. */
  signal?: AbortSignal;
}

export interface EngineResult {
  /** The finished file. */
  pdf: Uint8Array;
  pageCount: number;
  /** Chosen resolution (0 if unchanged). */
  dpi: number;
  /** Chosen JPEG quality (0 if unchanged). */
  quality: number;
  /** Page 1 as JPEG, for the readability preview. Null if unchanged. */
  preview: Blob | null;
  /** Size of page 1 in points, to show the preview as large as a PDF viewer at 100% would. */
  firstPageSize: { widthPt: number; heightPt: number };
  /** The input already fitted and grayscale was off, so `pdf` is the original file. */
  unchanged: boolean;
}

export type EngineErrorCode =
  | 'invalid-pdf'
  | 'password-protected'
  | 'unsupported-image'
  | 'no-pages'
  | 'target-unreachable'
  | 'render-failed'
  | 'cancelled';

export interface EngineErrorDetail {
  /** The photo that couldn't be decoded (unsupported-image). */
  fileName?: string;
  /** Estimated smallest achievable size in bytes (target-unreachable). */
  smallestBytes?: number;
}

/** Every failure the engine reports. The UI maps `code` to a message. */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly detail: EngineErrorDetail;

  constructor(code: EngineErrorCode, detail: EngineErrorDetail = {}, options?: { cause?: unknown }) {
    super(code, options);
    this.name = 'EngineError';
    this.code = code;
    this.detail = detail;
  }
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new EngineError('cancelled');
}
