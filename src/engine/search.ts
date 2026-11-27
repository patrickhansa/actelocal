// Chooses the resolution and JPEG quality for a document. See docs/engine-design.md §5.
// Pure logic: rendering, encoding and PDF assembly are passed in, so this runs without a browser.

import {
  ABANDON_MARGIN,
  CLIMB_SIZE_EXPONENT,
  LAST_RESORT_QUALITIES,
  LEVELS_DPI,
  QUALITIES,
  pdfOverhead,
} from './config';
import { EngineError, throwIfCancelled, type AttemptLog, type Progress } from './types';

/** Anything with a byte size: a JPEG Blob in the browser, a stub in tests. */
export interface Sized {
  readonly size: number;
}

/** One page rendered at one resolution. */
export interface RenderedPage<J extends Sized> {
  /** Encodes the page as JPEG at each quality (0..1), in order. Can be called more than once. */
  encode(qualities: readonly number[]): Promise<J[]>;
  /** Frees the page's pixels. */
  release(): void;
}

export interface SearchInput<J extends Sized> {
  pageCount: number;
  targetBytes: number;
  /**
   * Render page `index` (0-based) at `dpi`. The search renders the next page while the
   * previous one is still encoding, and releases every page it rendered.
   */
  renderPage: (index: number, dpi: number) => Promise<RenderedPage<J>>;
  /** Build the output PDF from one JPEG per page. */
  assemble: (jpegs: readonly J[]) => Promise<Uint8Array>;
  /** Qualities to try above the last level, and at it; QUALITIES and LAST_RESORT_QUALITIES by default. */
  qualities?: { normal: readonly number[]; lastResort: readonly number[] };
  /** How many pages may encode at once at `dpi` (results still come in page order). Default 1. */
  pagesInFlight?: (dpi: number) => number;
  onProgress?: (progress: Progress) => void;
  onAttempt?: (attempt: AttemptLog) => void;
  signal?: AbortSignal;
  /** Clock for the attempt log; injectable for tests. */
  now?: () => number;
}

export interface SearchResult<J extends Sized> {
  pdf: Uint8Array;
  dpi: number;
  quality: number;
  /** The chosen JPEG of every page. */
  jpegs: J[];
}

/** What one attempt at one resolution found. */
type LevelOutcome<J extends Sized> =
  | { kind: 'fits'; result: SearchResult<J>; lowestQualityBytes: number }
  /** Measured over the budget: the level certainly doesn't fit. */
  | { kind: 'failed'; estimatedJpegBytes: number; estimatedPdfBytes: number }
  /** Projected well over the budget and stopped early: the level probably doesn't fit. */
  | { kind: 'abandoned'; estimatedJpegBytes: number };

/**
 * Finds the highest resolution at which the document fits, then the highest quality there.
 *
 * 1. Descend: try a resolution; once it is (or is projected to be) too big, use the bytes
 *    measured so far to jump to the highest lower resolution predicted to fit.
 * 2. Climb: jumps and abandoned attempts can skip a level that fits (say, dense first pages
 *    and blank later ones), so recheck skipped levels just above the one that fits, using an
 *    optimistic estimate from the complete measurements there.
 */
export async function searchSettings<J extends Sized>(input: SearchInput<J>): Promise<SearchResult<J>> {
  if (input.pageCount === 0) throw new EngineError('no-pages');
  const budget = input.targetBytes - pdfOverhead(input.pageCount);
  if (budget <= 0) throw new EngineError('target-unreachable');

  const last = LEVELS_DPI.length - 1;
  const settled = new Set<number>(); // levels known to fit or not to fit
  let attempt = 0;
  const tryLevel = async (level: number, mayAbandon: boolean) => {
    const outcome = await tryResolution(input, budget, level, ++attempt, mayAbandon);
    if (outcome.kind !== 'abandoned') settled.add(level);
    return outcome;
  };

  // 1. Descend. The last level is never abandoned: it gives the final answer.
  let level = 0;
  let outcome = await tryLevel(level, level < last);
  while (outcome.kind !== 'fits') {
    if (outcome.kind === 'failed' && level === last) {
      throw new EngineError('target-unreachable', { smallestBytes: Math.ceil(outcome.estimatedPdfBytes) });
    }
    level = nextLevelDown(level, outcome.estimatedJpegBytes, budget);
    outcome = await tryLevel(level, level < last);
  }

  // 2. Climb back over skipped levels while an optimistic estimate says they might fit.
  let best = outcome;
  for (let above = level - 1; above >= 0 && !settled.has(above); above--) {
    const scale = (LEVELS_DPI[above] / LEVELS_DPI[level]) ** (2 * CLIMB_SIZE_EXPONENT);
    if (best.lowestQualityBytes * scale > budget) break;
    const higher = await tryLevel(above, false);
    if (higher.kind !== 'fits') break;
    best = higher;
    level = above;
  }
  return best.result;
}

/**
 * The highest level below `level` whose predicted size fits. JPEG bytes shrink a little
 * slower than pixel count, so scaling by pixels slightly underestimates the lower level.
 * Falls back to the last level, which is always tried before giving up.
 */
function nextLevelDown(level: number, jpegBytes: number, budget: number): number {
  const last = LEVELS_DPI.length - 1;
  for (let lower = level + 1; lower < last; lower++) {
    if (jpegBytes * (LEVELS_DPI[lower] / LEVELS_DPI[level]) ** 2 <= budget) return lower;
  }
  return last;
}

/** Renders every page at one resolution, encoding each at all qualities still in the running. */
async function tryResolution<J extends Sized>(
  input: SearchInput<J>,
  budget: number,
  level: number,
  attempt: number,
  mayAbandon: boolean,
): Promise<LevelOutcome<J>> {
  const { pageCount, renderPage, assemble, onProgress, onAttempt, signal } = input;
  const now = input.now ?? (() => performance.now());
  const dpi = LEVELS_DPI[level];
  const isLast = level === LEVELS_DPI.length - 1;

  // Quality → running total and JPEGs. A Map keeps insertion order, so it iterates ascending.
  const allowed = input.qualities ?? { normal: QUALITIES, lastResort: LAST_RESORT_QUALITIES };
  const alive = new Map<number, { total: number; jpegs: J[] }>();
  for (const quality of isLast ? allowed.lastResort : allowed.normal) alive.set(quality, { total: 0, jpegs: [] });
  const lowest = () => alive.values().next().value!;
  const projection = (bytes: number, pages: number) => (bytes / pages) * pageCount;

  const log: AttemptLog = { dpi, pagesRendered: 0, fittingQualities: [], renderMs: 0, encodeMs: 0 };
  const finish = <T extends LevelOutcome<J>>(outcome: T): T => {
    log.fittingQualities = outcome.kind === 'fits' ? [...alive.keys()] : [];
    onAttempt?.(log);
    return outcome;
  };

  const lowestQuality = alive.keys().next().value!;

  /** Adds one page's encodes to the running totals; returns an outcome if the level failed. */
  const addPage = (page: number, qualities: readonly number[], jpegs: readonly J[]): LevelOutcome<J> | null => {
    for (const [i, quality] of qualities.entries()) {
      const candidate = alive.get(quality);
      if (!candidate) continue; // dropped after this page was sent off to encode
      if (candidate.total + jpegs[i].size > budget) {
        if (quality === lowestQuality) {
          const estimatedJpegBytes = projection(candidate.total + jpegs[i].size, page + 1);
          return { kind: 'failed', estimatedJpegBytes, estimatedPdfBytes: estimatedJpegBytes + pdfOverhead(pageCount) };
        }
        // A higher quality never makes a smaller JPEG, so every higher quality is out too.
        for (const q of [...alive.keys()]) if (q >= quality) alive.delete(q);
        break;
      }
      candidate.total += jpegs[i].size;
      candidate.jpegs.push(jpegs[i]);
    }
    log.pagesRendered = page + 1;
    return null;
  };

  // Pages render one after another (there is one canvas) while up to `window` of them
  // encode at once; results are taken strictly in page order.
  const window = Math.max(1, input.pagesInFlight?.(dpi) ?? 1);
  const inFlight: { rendered: RenderedPage<J>; qualities: number[]; encoded: Promise<J[]> }[] = [];
  let rendering: Promise<RenderedPage<J>> | null = renderPage(0, dpi);
  let renderedCount = 0;

  /** Waits for the page being rendered and starts rendering the one after it. */
  const nextRendered = async (): Promise<RenderedPage<J>> => {
    const start = now();
    const rendered = await rendering!;
    log.renderMs += now() - start;
    renderedCount++;
    rendering = renderedCount < pageCount ? renderPage(renderedCount, dpi) : null;
    // A failure surfaces when awaited; this only stops it being reported as unhandled meanwhile.
    rendering?.catch(() => undefined);
    return rendered;
  };

  try {
    let page = 0;
    if (mayAbandon) {
      // First page: encode only the lowest quality and give up early on a hopeless level.
      throwIfCancelled(signal);
      onProgress?.({ dpi, attempt, page: 1, pageCount });
      const first = await nextRendered();
      const qualities = [...alive.keys()];
      const start = now();
      let jpegs: J[];
      try {
        const [lowestJpeg] = await first.encode(qualities.slice(0, 1));
        if (projection(lowestJpeg.size, 1) > budget * ABANDON_MARGIN) {
          log.encodeMs += now() - start;
          log.pagesRendered = 1;
          return finish({ kind: 'abandoned', estimatedJpegBytes: projection(lowestJpeg.size, 1) });
        }
        jpegs = [lowestJpeg, ...(await first.encode(qualities.slice(1)))];
      } finally {
        first.release();
      }
      log.encodeMs += now() - start;
      const failed = addPage(0, qualities, jpegs);
      if (failed) return finish(failed);
      page = 1;
    }

    for (; page < pageCount; page++) {
      throwIfCancelled(signal);
      onProgress?.({ dpi, attempt, page: page + 1, pageCount });
      while (renderedCount < pageCount && inFlight.length < window) {
        const rendered = await nextRendered();
        const qualities = [...alive.keys()];
        const encoded = rendered.encode(qualities);
        encoded.catch(() => undefined); // awaited below, in page order
        inFlight.push({ rendered, qualities, encoded });
      }

      const { rendered, qualities, encoded } = inFlight.shift()!;
      const start = now();
      let jpegs: J[];
      try {
        jpegs = await encoded;
      } finally {
        rendered.release();
      }
      log.encodeMs += now() - start;
      const failed = addPage(page, qualities, jpegs);
      if (failed) return finish(failed);

      if (mayAbandon && projection(lowest().total, page + 1) > budget * ABANDON_MARGIN) {
        return finish({ kind: 'abandoned', estimatedJpegBytes: projection(lowest().total, page + 1) });
      }
    }
  } finally {
    // Leave nothing running into a canvas the next attempt reuses, and nothing unreleased.
    for (const { rendered, encoded } of inFlight.splice(0)) {
      await encoded.catch(() => undefined);
      rendered.release();
    }
    (await rendering?.catch(() => null))?.release();
  }

  // Every quality left fits the budget for all pages. Take the highest one whose assembled
  // PDF really is under the target (the overhead is an estimate).
  const lowestQualityBytes = lowest().total;
  let smallestPdf = Infinity;
  for (const quality of [...alive.keys()].reverse()) {
    const { jpegs } = alive.get(quality)!;
    const pdf = await assemble(jpegs);
    if (pdf.length <= input.targetBytes) {
      return finish({ kind: 'fits', result: { pdf, dpi, quality, jpegs }, lowestQualityBytes });
    }
    smallestPdf = Math.min(smallestPdf, pdf.length);
  }
  return finish({ kind: 'failed', estimatedJpegBytes: lowestQualityBytes, estimatedPdfBytes: smallestPdf });
}
