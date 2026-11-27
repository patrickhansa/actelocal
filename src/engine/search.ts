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
  const alive = new Map<number, { total: number; jpegs: J[] }>();
  for (const quality of isLast ? LAST_RESORT_QUALITIES : QUALITIES) alive.set(quality, { total: 0, jpegs: [] });
  const lowest = () => alive.values().next().value!;
  const projection = (bytes: number, pages: number) => (bytes / pages) * pageCount;

  const log: AttemptLog = { dpi, pagesRendered: 0, fittingQualities: [], renderMs: 0, encodeMs: 0 };
  const finish = <T extends LevelOutcome<J>>(outcome: T): T => {
    log.fittingQualities = outcome.kind === 'fits' ? [...alive.keys()] : [];
    onAttempt?.(log);
    return outcome;
  };

  let nextRender: Promise<RenderedPage<J>> | null = renderPage(0, dpi);
  try {
    for (let page = 0; page < pageCount; page++) {
      throwIfCancelled(signal);
      onProgress?.({ dpi, attempt, page: page + 1, pageCount });

      let start = now();
      const rendered = await nextRender!;
      nextRender = null;
      log.renderMs += now() - start;
      // Draw the next page while this one encodes. (A failure surfaces when it is awaited;
      // the empty catch only stops the browser reporting it as unhandled in the meantime.)
      nextRender = page + 1 < pageCount ? renderPage(page + 1, dpi) : null;
      nextRender?.catch(() => undefined);

      start = now();
      const qualities = [...alive.keys()];
      let jpegs: J[];
      try {
        if (mayAbandon && page === 0) {
          // First page: encode only the lowest quality and give up early on a hopeless level.
          const [first] = await rendered.encode(qualities.slice(0, 1));
          if (projection(first.size, 1) > budget * ABANDON_MARGIN) {
            log.encodeMs += now() - start;
            log.pagesRendered = 1;
            return finish({ kind: 'abandoned', estimatedJpegBytes: projection(first.size, 1) });
          }
          jpegs = [first, ...(await rendered.encode(qualities.slice(1)))];
        } else {
          jpegs = await rendered.encode(qualities);
        }
      } finally {
        rendered.release();
      }
      log.encodeMs += now() - start;
      log.pagesRendered = page + 1;

      for (const [i, quality] of qualities.entries()) {
        const candidate = alive.get(quality)!;
        if (candidate.total + jpegs[i].size > budget) {
          if (i === 0) {
            const estimatedJpegBytes = projection(candidate.total + jpegs[i].size, page + 1);
            return finish({ kind: 'failed', estimatedJpegBytes, estimatedPdfBytes: estimatedJpegBytes + pdfOverhead(pageCount) });
          }
          // A higher quality never makes a smaller JPEG, so every higher quality is out too.
          for (const q of qualities.slice(i)) alive.delete(q);
          break;
        }
        candidate.total += jpegs[i].size;
        candidate.jpegs.push(jpegs[i]);
      }

      if (mayAbandon && projection(lowest().total, page + 1) > budget * ABANDON_MARGIN) {
        return finish({ kind: 'abandoned', estimatedJpegBytes: projection(lowest().total, page + 1) });
      }
    }
  } finally {
    // Never leave a render running into a canvas the next attempt will reuse, or unreleased.
    (await nextRender?.catch(() => null))?.release();
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
