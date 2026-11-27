import { describe, expect, it } from 'vitest';
import { otsu, pageStats, threshold } from './bitonal';
import {
  BLACK_MAKEUP,
  BLACK_TERMINATING,
  EOL,
  EXTENDED_MAKEUP,
  HORIZONTAL,
  PASS,
  VERTICAL,
  WHITE_MAKEUP,
  WHITE_TERMINATING,
  encodeG4,
} from './g4';

/** No code may be the beginning of another, or a decoder couldn't tell them apart. */
function expectPrefixFree(codes: readonly string[]) {
  for (const a of codes) {
    for (const b of codes) {
      if (a !== b) expect(b.startsWith(a), `${a} is a prefix of ${b}`).toBe(false);
    }
  }
  expect(new Set(codes).size).toBe(codes.length);
}

describe('G4 code tables', () => {
  it('have the sizes of ITU-T T.4 tables 2 and 3', () => {
    expect(WHITE_TERMINATING).toHaveLength(64);
    expect(BLACK_TERMINATING).toHaveLength(64);
    expect(WHITE_MAKEUP).toHaveLength(27);
    expect(BLACK_MAKEUP).toHaveLength(27);
    expect(EXTENDED_MAKEUP).toHaveLength(13);
  });

  it('are prefix-free within each colour, and among the mode codes', () => {
    expectPrefixFree([...WHITE_TERMINATING, ...WHITE_MAKEUP, ...EXTENDED_MAKEUP, EOL]);
    expectPrefixFree([...BLACK_TERMINATING, ...BLACK_MAKEUP, ...EXTENDED_MAKEUP, EOL]);
    expectPrefixFree([PASS, HORIZONTAL, ...VERTICAL, EOL]);
  });
});

/** Bytes as a bit string, for comparing with hand-worked examples. */
const bits = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(2).padStart(8, '0')).join('');
const EOFB = EOL + EOL;

describe('encodeG4', () => {
  it('codes each all-white row as vertical-0 against the (white) row above', () => {
    const encoded = encodeG4(new Uint8Array(8 * 8), 8, 8);
    expect(bits(encoded)).toBe(('11111111' + EOFB).padEnd(encoded.length * 8, '0'));
  });

  it('matches a hand-worked row: one black pixel at the left of a 4-pixel row', () => {
    // a1 = 0 is 4 from b1 (no change above), so horizontal mode: white run 0, black run 1.
    // Then a1 = b1 = 4 (end of row): vertical 0. Then the end-of-block code.
    const expected = HORIZONTAL + WHITE_TERMINATING[0] + BLACK_TERMINATING[1] + VERTICAL[3] + EOFB;
    const encoded = encodeG4(Uint8Array.of(1, 0, 0, 0), 4, 1);
    expect(bits(encoded)).toBe(expected.padEnd(encoded.length * 8, '0'));
  });

  it('matches a hand-worked pair of rows that needs pass mode', () => {
    // Row 1, black at 2..3, against the white row above: a1 = 2 is 6 from b1 = 8 (end),
    // so horizontal mode (white 2, black 2); then a1 = b1 = 8: vertical 0.
    // Row 2, all white, against row 1: b1 = 2, b2 = 4 both left of a1 = 8: pass to a0 = 4;
    // then a1 = b1 = 8: vertical 0.
    const image = Uint8Array.of(0, 0, 1, 1, 0, 0, 0, 0, /* row 2 */ 0, 0, 0, 0, 0, 0, 0, 0);
    const row1 = HORIZONTAL + WHITE_TERMINATING[2] + BLACK_TERMINATING[2] + VERTICAL[3];
    const row2 = PASS + VERTICAL[3];
    const encoded = encodeG4(image, 8, 2);
    expect(bits(encoded)).toBe((row1 + row2 + EOFB).padEnd(encoded.length * 8, '0'));
  });
});

describe('thresholding', () => {
  const gray = (...values: number[]) => Uint8ClampedArray.from(values.flatMap((v) => [v, v, v, 255]));

  it('splits a two-tone histogram between its peaks', () => {
    const histogram = new Array(256).fill(0);
    histogram[30] = 100;
    histogram[220] = 900;
    const cut = otsu(histogram, 1000);
    expect(cut).toBeGreaterThanOrEqual(30);
    expect(cut).toBeLessThan(220);
  });

  it('keeps a blank page white, despite paper noise', () => {
    const page = gray(...Array.from({ length: 1000 }, (_, i) => 236 + (i % 9)));
    expect(threshold(page).every((bit) => bit === 0)).toBe(true);
  });

  it('turns text dark and paper white', () => {
    expect([...threshold(gray(20, 240, 35, 250, 60))]).toEqual([1, 0, 1, 0, 1]);
  });

  it('counts mid-gray and coloured pixels', () => {
    const rgba = Uint8ClampedArray.from([0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255, 200, 20, 20, 255]);
    const stats = pageStats(rgba);
    expect(stats.midFraction).toBeCloseTo(2 / 4); // the gray and the red
    expect(stats.colourFraction).toBeCloseTo(1 / 4); // the red
  });
});
