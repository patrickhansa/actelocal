import { describe, expect, it } from 'vitest';
import { largestImageCoverage, type OpCodes } from './classify';

const OPS: OpCodes = {
  save: 1,
  restore: 2,
  transform: 3,
  paintFormXObjectBegin: 4,
  paintFormXObjectEnd: 5,
  paintImageXObject: 6,
  paintInlineImageXObject: 7,
  paintImageMaskXObject: 8,
};
const A4 = { width: 595, height: 842 };
const AREA = A4.width * A4.height;

/** Builds an operator list from [op, args] pairs. */
function ops(...list: [number, unknown[] | null][]) {
  return { fnArray: list.map(([fn]) => fn), argsArray: list.map(([, args]) => args) };
}
const coverage = (list: ReturnType<typeof ops>) => largestImageCoverage(list.fnArray, list.argsArray, AREA, OPS);

describe('largestImageCoverage', () => {
  it('sees a scanned page: one image stretched over the whole page', () => {
    const page = ops(
      [OPS.save, null],
      [OPS.transform, [A4.width, 0, 0, A4.height, 0, 0]],
      [OPS.paintImageXObject, ['img1', 2480, 3508]],
      [OPS.restore, null],
    );
    expect(coverage(page)).toBeCloseTo(1);
  });

  it('sees a small logo on a text page as low coverage', () => {
    const page = ops(
      [OPS.save, null],
      [OPS.transform, [100, 0, 0, 50, 40, 760]],
      [OPS.paintImageXObject, ['logo', 400, 200]],
      [OPS.restore, null],
    );
    expect(coverage(page)).toBeCloseTo((100 * 50) / AREA);
  });

  it('applies nested transforms and form matrices, and forgets them after restore', () => {
    const page = ops(
      [OPS.save, null],
      [OPS.transform, [2, 0, 0, 2, 0, 0]], // area × 4
      [OPS.paintFormXObjectBegin, [[A4.width / 2, 0, 0, A4.height / 2, 0, 0], [0, 0, 1, 1]]],
      [OPS.paintImageMaskXObject, [{}]], // full page: 4 × (A4 / 4)
      [OPS.paintFormXObjectEnd, null],
      [OPS.restore, null],
      [OPS.transform, [10, 0, 0, 10, 0, 0]],
      [OPS.paintInlineImageXObject, [{}]], // 100 pt², the transform above was restored away
    );
    expect(coverage(page)).toBeCloseTo(1);
  });

  it('ignores rotation: a rotated full-page image still covers the page', () => {
    // 90° rotation scaled to the page: [0, w, -h, 0, ...] has |det| = w × h.
    const page = ops([OPS.transform, [0, A4.width, -A4.height, 0, A4.height, 0]], [OPS.paintImageXObject, ['img', 1, 1]]);
    expect(coverage(page)).toBeCloseTo(1);
  });

  it('reports zero for a page without images', () => {
    expect(coverage(ops([OPS.save, null], [OPS.transform, [1, 0, 0, 1, 72, 72]], [OPS.restore, null]))).toBe(0);
  });
});
