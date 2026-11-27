// CCITT Group 4 (ITU-T T.6) encoder for 1-bit images: the compression fax machines and
// scanners use for black-and-white pages, read by PDF's CCITTFaxDecode filter with K = -1.
// Pure logic, no browser APIs.
//
// Each row is coded against the row above (the reference row; above the first row is an
// imaginary white row) in one of three modes: pass, vertical (a colour change within 3
// pixels of one in the row above) or horizontal (two run lengths). The code tables below
// are ITU-T T.4 tables 2, 3 and 4, written as bit strings so they can be checked against
// the standard by eye; scripts/check-g4-tables.mjs also checks them against libtiff.

type Code = readonly [bits: number, length: number];
const code = (bits: string): Code => [parseInt(bits, 2), bits.length];

/** T.4 table 2: white run terminating codes, runs 0..63. */
export const WHITE_TERMINATING: readonly string[] = [
  '00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111',
  '10011', '10100', '00111', '01000', '001000', '000011', '110100', '110101',
  '101010', '101011', '0100111', '0001100', '0001000', '0010111', '0000011', '0000100',
  '0101000', '0101011', '0010011', '0100100', '0011000', '00000010', '00000011', '00011010',
  '00011011', '00010010', '00010011', '00010100', '00010101', '00010110', '00010111', '00101000',
  '00101001', '00101010', '00101011', '00101100', '00101101', '00000100', '00000101', '00001010',
  '00001011', '01010010', '01010011', '01010100', '01010101', '00100100', '00100101', '01011000',
  '01011001', '01011010', '01011011', '01001010', '01001011', '00110010', '00110011', '00110100',
];

/** T.4 table 3: white make-up codes, runs 64, 128, ... 1728. */
export const WHITE_MAKEUP: readonly string[] = [
  '11011', '10010', '010111', '0110111', '00110110', '00110111', '01100100', '01100101',
  '01101000', '01100111', '011001100', '011001101', '011010010', '011010011', '011010100', '011010101',
  '011010110', '011010111', '011011000', '011011001', '011011010', '011011011', '010011000', '010011001',
  '010011010', '011000', '010011011',
];

/** T.4 table 2: black run terminating codes, runs 0..63. */
export const BLACK_TERMINATING: readonly string[] = [
  '0000110111', '010', '11', '10', '011', '0011', '0010', '00011',
  '000101', '000100', '0000100', '0000101', '0000111', '00000100', '00000111', '000011000',
  '0000010111', '0000011000', '0000001000', '00001100111', '00001101000', '00001101100', '00000110111', '00000101000',
  '00000010111', '00000011000', '000011001010', '000011001011', '000011001100', '000011001101', '000001101000', '000001101001',
  '000001101010', '000001101011', '000011010010', '000011010011', '000011010100', '000011010101', '000011010110', '000011010111',
  '000001101100', '000001101101', '000011011010', '000011011011', '000001010100', '000001010101', '000001010110', '000001010111',
  '000001100100', '000001100101', '000001010010', '000001010011', '000000100100', '000000110111', '000000111000', '000000100111',
  '000000101000', '000001011000', '000001011001', '000000101011', '000000101100', '000001011010', '000001100110', '000001100111',
];

/** T.4 table 3: black make-up codes, runs 64, 128, ... 1728. */
export const BLACK_MAKEUP: readonly string[] = [
  '0000001111', '000011001000', '000011001001', '000001011011', '000000110011', '000000110100', '000000110101', '0000001101100',
  '0000001101101', '0000001001010', '0000001001011', '0000001001100', '0000001001101', '0000001110010', '0000001110011', '0000001110100',
  '0000001110101', '0000001110110', '0000001110111', '0000001010010', '0000001010011', '0000001010100', '0000001010101', '0000001011010',
  '0000001011011', '0000001100100', '0000001100101',
];

/** T.4 table 3 (extended): make-up codes for runs 1792, 1856, ... 2560, same for both colours. */
export const EXTENDED_MAKEUP: readonly string[] = [
  '00000001000', '00000001100', '00000001101', '000000010010', '000000010011', '000000010100', '000000010101',
  '000000010110', '000000010111', '000000011100', '000000011101', '000000011110', '000000011111',
];

/** T.4 table 4 (and T.6): two-dimensional mode codes. Index of VERTICAL is a1 − b1 + 3. */
export const PASS = '0001';
export const HORIZONTAL = '001';
export const VERTICAL: readonly string[] = ['0000010', '000010', '010', '1', '011', '000011', '0000011'];
export const EOL = '000000000001';

const WHITE = 0; // and black is 1

const tables = {
  terminating: [WHITE_TERMINATING.map(code), BLACK_TERMINATING.map(code)],
  makeup: [WHITE_MAKEUP.map(code), BLACK_MAKEUP.map(code)],
  extended: EXTENDED_MAKEUP.map(code),
  pass: code(PASS),
  horizontal: code(HORIZONTAL),
  vertical: VERTICAL.map(code),
  eol: code(EOL),
};

/**
 * Encodes a 1-bit image. `pixels` holds one byte per pixel, row by row: 1 = black,
 * 0 = white. The result is the data of a PDF image with
 * /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns width /Rows height >>,
 * /ColorSpace /DeviceGray and /BitsPerComponent 1 (0 = black, the default BlackIs1 false).
 */
export function encodeG4(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const out = new BitWriter(Math.max(64, (width * height) >> 5));
  // Changing elements of a row: positions where the colour differs from the pixel before
  // (the pixel before the first one counts as white), followed by sentinels at `width`.
  let reference = new Int32Array(width + 3).fill(width); // imaginary all-white row
  let current = new Int32Array(width + 3);

  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * width, (y + 1) * width);
    let count = 0;
    let previous = WHITE;
    for (let x = 0; x < width; x++) {
      if (row[x] !== previous) {
        current[count++] = x;
        previous = row[x];
      }
    }
    current[count] = current[count + 1] = current[count + 2] = width;

    encodeRow(out, reference, current, width);
    [reference, current] = [current, reference];
  }

  out.write(tables.eol); // end of facsimile block: two EOLs
  out.write(tables.eol);
  return out.finish();
}

/** Codes one row against the reference row (T.6 section 2.2). */
function encodeRow(out: BitWriter, reference: Int32Array, current: Int32Array, width: number): void {
  let a0 = -1; // starts on an imaginary white element just left of the row
  let colour = WHITE; // colour of the pixels just right of a0
  let ai = 0; // index of a1 in `current`
  let ri = 0; // index of the first reference change right of a0

  while (a0 < width) {
    while (current[ai] <= a0) ai++;
    const a1 = current[ai];

    // b1: first change in the reference row right of a0 that turns to the opposite colour.
    // Changes alternate colour, starting with a change to black at index 0, so a change
    // at an even index turns black and one at an odd index turns white.
    while (reference[ri] <= a0) ri++;
    let bi = ri;
    if ((bi & 1) !== colour) bi++; // even index (to black) when a0 is white, odd when black
    const b1 = reference[bi];
    const b2 = reference[bi + 1];

    if (b2 < a1) {
      out.write(tables.pass);
      a0 = b2;
    } else if (Math.abs(a1 - b1) <= 3) {
      out.write(tables.vertical[a1 - b1 + 3]);
      a0 = a1;
      colour = 1 - colour;
    } else {
      const a2 = current[ai + 1];
      out.write(tables.horizontal);
      writeRun(out, colour, a1 - Math.max(a0, 0));
      writeRun(out, 1 - colour, a2 - a1);
      a0 = a2;
    }
  }
}

/** A run length as make-up codes (multiples of 64) followed by one terminating code (0..63). */
function writeRun(out: BitWriter, colour: number, run: number): void {
  while (run >= 2560) {
    out.write(tables.extended[tables.extended.length - 1]);
    run -= 2560;
  }
  if (run >= 64) {
    const sixtyFours = run >> 6;
    out.write(sixtyFours <= 27 ? tables.makeup[colour][sixtyFours - 1] : tables.extended[sixtyFours - 28]);
    run &= 63;
  }
  out.write(tables.terminating[colour][run]);
}

/** Appends codes most significant bit first; pads the last byte with zeros. */
class BitWriter {
  private bytes: Uint8Array;
  private length = 0;
  private buffer = 0; // pending bits, fewer than 8 between writes
  private bufferedBits = 0;

  constructor(initialCapacity: number) {
    this.bytes = new Uint8Array(initialCapacity);
  }

  write([bits, length]: Code): void {
    this.buffer = (this.buffer << length) | bits; // at most 7 + 13 bits: fits in 32
    this.bufferedBits += length;
    while (this.bufferedBits >= 8) {
      this.bufferedBits -= 8;
      this.pushByte((this.buffer >>> this.bufferedBits) & 0xff);
    }
    this.buffer &= (1 << this.bufferedBits) - 1;
  }

  finish(): Uint8Array {
    if (this.bufferedBits > 0) this.pushByte((this.buffer << (8 - this.bufferedBits)) & 0xff);
    return this.bytes.slice(0, this.length);
  }

  private pushByte(byte: number): void {
    if (this.length === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.length++] = byte;
  }
}
