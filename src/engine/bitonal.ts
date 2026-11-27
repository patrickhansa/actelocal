// Black-and-white analysis and thresholding of rendered pages. Pure logic, no browser APIs.

/** How black-and-white a rendered page looks. */
export interface PageStats {
  /** Share of pixels with mid-gray brightness (64..191): photos and gradients have many. */
  midFraction: number;
  /** Share of clearly coloured pixels (channel spread > 48): stamps, signatures, photos. */
  colourFraction: number;
}

/** Perceived brightness 0..255 (ITU-R BT.601 weights, in integer arithmetic). */
const brightness = (r: number, g: number, b: number) => (r * 77 + g * 150 + b * 29) >> 8;

export function pageStats(rgba: Uint8ClampedArray): PageStats {
  const pixels = rgba.length >> 2;
  let mid = 0;
  let colour = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const y = brightness(r, g, b);
    if (y >= 64 && y <= 191) mid++;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 48) colour++;
  }
  return { midFraction: mid / pixels, colourFraction: colour / pixels };
}

/**
 * Turns RGBA pixels into one byte per pixel, 1 = black, using Otsu's threshold (the cut
 * that best separates dark from light). The threshold is clamped so a blank page, whose
 * only "dark" pixels are paper noise, stays white.
 */
export function threshold(rgba: Uint8ClampedArray): Uint8Array {
  const pixels = rgba.length >> 2;
  const luma = new Uint8Array(pixels);
  const histogram = new Uint32Array(256);
  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    const y = brightness(rgba[i], rgba[i + 1], rgba[i + 2]);
    luma[p] = y;
    histogram[y]++;
  }
  const cut = Math.min(180, Math.max(80, otsu(histogram, pixels)));
  const bits = luma; // reuse the buffer
  for (let p = 0; p < pixels; p++) bits[p] = luma[p] <= cut ? 1 : 0;
  return bits;
}

/** Otsu's method: the brightness that maximises the variance between the two classes. */
export function otsu(histogram: ArrayLike<number>, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let darkCount = 0;
  let darkSum = 0;
  let best = -1;
  let cut = 127;
  for (let t = 0; t < 256; t++) {
    darkCount += histogram[t];
    if (darkCount === 0) continue;
    const lightCount = total - darkCount;
    if (lightCount === 0) break;
    darkSum += t * histogram[t];
    const between = darkCount * lightCount * (darkSum / darkCount - (sum - darkSum) / lightCount) ** 2;
    if (between > best) {
      best = between;
      cut = t;
    }
  }
  return cut;
}

/** RGBA pixels showing a 1-bit image (1 = black), for previews. */
export function bitsToRgba(bits: Uint8Array): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(bits.length * 4);
  for (let p = 0, i = 0; p < bits.length; p++, i += 4) {
    const v = bits[p] ? 0 : 255;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
    rgba[i + 3] = 255;
  }
  return rgba;
}
