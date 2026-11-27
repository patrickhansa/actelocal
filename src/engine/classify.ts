// Tells scanned pages from digitally made ones, from a pdf.js operator list.
// Pure logic: the operator codes are passed in, so it runs without pdf.js.

/** The pdf.js operator codes this module looks at (pdf.js exports them as `OPS`). */
export interface OpCodes {
  save: number;
  restore: number;
  transform: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
  paintImageMaskXObject: number;
}

/** A page counts as scanned when one image covers at least this share of it. */
export const SCANNED_PAGE_COVERAGE = 0.5;

/**
 * The largest share of the page (0..1) covered by a single image.
 *
 * An image is drawn into the unit square mapped by the current transform, so its area
 * is |det| of that transform. Determinants multiply, so tracking one number per
 * graphics-state level is enough: no full matrices needed.
 */
export function largestImageCoverage(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
  pageArea: number,
  ops: OpCodes,
): number {
  const stack: number[] = [];
  let areaScale = 1; // |det| of the current transform; user space starts at 1 unit = 1 pt
  let largest = 0;
  const det = (m: unknown) => {
    const [a, b, c, d] = m as number[];
    return Math.abs(a * d - b * c);
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[] | null;
    if (fn === ops.save) {
      stack.push(areaScale);
    } else if (fn === ops.restore || fn === ops.paintFormXObjectEnd) {
      areaScale = stack.pop() ?? 1;
    } else if (fn === ops.transform) {
      areaScale *= det(args);
    } else if (fn === ops.paintFormXObjectBegin) {
      stack.push(areaScale);
      if (args?.[0]) areaScale *= det(args[0]);
    } else if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject || fn === ops.paintImageMaskXObject) {
      largest = Math.max(largest, areaScale);
    }
  }
  return pageArea > 0 ? Math.min(1, largest / pageArea) : 0;
}
