import { describe, expect, it } from 'vitest';
import { A4, PHOTO_MARGIN_PT } from './config';
import { layoutPhotos, type Placement } from './photo-source';
import { pixelsPerPoint } from './raster';

const portrait = { width: 3000, height: 4000, rotation: 0 as const };
const landscape = { width: 4000, height: 3000, rotation: 0 as const };

function insideMargins(p: Placement, page: { widthPt: number; heightPt: number }) {
  const eps = 1e-6;
  return (
    p.x >= PHOTO_MARGIN_PT - eps &&
    p.y >= PHOTO_MARGIN_PT - eps &&
    p.x + p.width <= page.widthPt - PHOTO_MARGIN_PT + eps &&
    p.y + p.height <= page.heightPt - PHOTO_MARGIN_PT + eps
  );
}

describe('layoutPhotos, one per page', () => {
  it('puts a portrait photo on a portrait A4 page, inside the margins, aspect ratio kept', () => {
    const [page] = layoutPhotos([portrait], 'one-per-page');
    expect(page).toMatchObject({ widthPt: A4.widthPt, heightPt: A4.heightPt });
    const [p] = page.placements;
    expect(insideMargins(p, page)).toBe(true);
    expect(p.width / p.height).toBeCloseTo(3 / 4);
  });

  it('turns the page for a landscape photo', () => {
    const [page] = layoutPhotos([landscape], 'one-per-page');
    expect(page).toMatchObject({ widthPt: A4.heightPt, heightPt: A4.widthPt });
  });

  it('applies the rotation before choosing the orientation', () => {
    const [page] = layoutPhotos([{ ...landscape, rotation: 90 }], 'one-per-page');
    expect(page).toMatchObject({ widthPt: A4.widthPt, heightPt: A4.heightPt });
    expect(page.placements[0].width / page.placements[0].height).toBeCloseTo(3 / 4);
  });
});

describe('layoutPhotos, two per page', () => {
  it('pairs photos top and bottom, and leaves an odd last photo alone at the top', () => {
    const pages = layoutPhotos([landscape, landscape, portrait], 'two-per-page');
    expect(pages).toHaveLength(2);
    const [top, bottom] = pages[0].placements;
    expect([top.photo, bottom.photo]).toEqual([0, 1]);
    expect(top.y + top.height).toBeLessThan(bottom.y);
    expect(pages[1].placements).toHaveLength(1);
    expect(pages[1].placements[0].y + pages[1].placements[0].height).toBeLessThan(A4.heightPt / 2);
    for (const page of pages) {
      expect(page).toMatchObject({ widthPt: A4.widthPt, heightPt: A4.heightPt });
      for (const p of page.placements) expect(insideMargins(p, page)).toBe(true);
    }
  });
});

describe('pixelsPerPoint', () => {
  it('uses the dpi as is up to A4 size', () => {
    expect(pixelsPerPoint(A4, 300)).toBeCloseTo(300 / 72);
    expect(pixelsPerPoint({ widthPt: 420, heightPt: 595 }, 150)).toBeCloseTo(150 / 72); // A5
  });

  it('gives a larger page the pixel count of an A4 page', () => {
    const huge = { widthPt: 3000, heightPt: 4000 }; // a photo converted at 1 px = 1 pt
    const longEdgePx = 4000 * pixelsPerPoint(huge, 300);
    expect(longEdgePx).toBeCloseTo(A4.heightPt * (300 / 72));
  });
});
