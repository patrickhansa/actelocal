// Every tunable number of the engine lives here. See docs/engine-design.md §5.

/** Resolution levels, tried from first to last. */
export const LEVELS_DPI: readonly number[] = [300, 250, 200, 175, 150, 125, 100];

/** JPEG qualities allowed at every level except the last, ascending. */
export const QUALITIES: readonly number[] = [0.55, 0.65, 0.75, 0.85];

/** JPEG qualities allowed at the last (lowest) level, ascending. */
export const LAST_RESORT_QUALITIES: readonly number[] = [0.35, 0.45, 0.55, 0.65, 0.75, 0.85];

/**
 * How JPEG bytes grow with pixel count when climbing back up a resolution: bytes ∝ pixels^x.
 * Measured scans give x ≈ 0.92; using a lower value makes the estimate optimistic, so a
 * level that might fit is tried rather than skipped. See search.ts.
 */
export const CLIMB_SIZE_EXPONENT = 0.75;

/**
 * While descending, a resolution is abandoned once the pages so far project its lowest
 * quality above budget × this margin. Abandoned levels count as skipped, not failed, so
 * the climb can still come back to them. See search.ts.
 */
export const ABANDON_MARGIN = 1.1;

/**
 * Most pixels encoded at once. Each JPEG encode copies the canvas, so this caps the
 * extra memory (4 bytes per pixel) while qualities are encoded in parallel.
 */
export const MAX_PARALLEL_ENCODE_PIXELS = 20_000_000;

/** PDF points per inch. */
export const PT_PER_INCH = 72;

/** A4 in PDF points. */
export const A4 = { widthPt: 595.28, heightPt: 841.89 } as const;

/**
 * Pages whose long edge is longer than A4's get the pixel count an A4 page would get.
 * Bounds memory (long edge <= 3508 px at 300 dpi) and handles nonsense page sizes.
 */
export const MAX_LONG_EDGE_PT = A4.heightPt;

const mm = (millimetres: number) => (millimetres / 25.4) * PT_PER_INCH;

/** Photo layout on A4 pages. */
export const PHOTO_MARGIN_PT = mm(10);
export const PHOTO_GAP_PT = mm(10);

/**
 * Bytes a PDF needs on top of its JPEGs (header, page objects, cross-reference table).
 * Upper bound checked by assemble.test.ts.
 */
export function pdfOverhead(pageCount: number): number {
  return 1_000 + 400 * pageCount;
}
