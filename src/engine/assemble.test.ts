import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { assemblePdf } from './assemble';
import { A4, pdfOverhead } from './config';

/** Bytes pdf-lib accepts as a JPEG: a start marker, a frame header with the size, filler, an end marker. */
function fakeJpeg(size: number, width = 1240, height = 1754): Blob {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8]); // start of image
  // Baseline frame header: precision 8, height, width, 3 components.
  bytes.set([0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3], 2);
  bytes.set([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 12);
  bytes.set([0xff, 0xd9], size - 2); // end of image
  return new Blob([bytes]);
}

describe('assemblePdf', () => {
  for (const pageCount of [1, 10, 60]) {
    it(`stays within pdfOverhead() for ${pageCount} page(s)`, async () => {
      const jpegSize = 80_000;
      const pages = Array.from({ length: pageCount }, () => A4);
      const pdf = await assemblePdf(pages, pages.map(() => fakeJpeg(jpegSize)));
      const overhead = pdf.length - pageCount * jpegSize;
      expect(overhead).toBeLessThanOrEqual(pdfOverhead(pageCount));
    });
  }

  it('keeps each page size and sets only our own metadata', async () => {
    const pages = [A4, { widthPt: A4.heightPt, heightPt: A4.widthPt }];
    const bytes = await assemblePdf(pages, [fakeJpeg(5_000), fakeJpeg(5_000)]);
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false }); // or pdf-lib rewrites Producer
    expect(pdf.getPages().map((p) => p.getSize())).toEqual([
      { width: A4.widthPt, height: A4.heightPt },
      { width: A4.heightPt, height: A4.widthPt },
    ]);
    expect(pdf.getProducer()).toBe('ActeLocal');
    expect(pdf.getAuthor()).toBeUndefined();
    expect(pdf.getTitle()).toBeUndefined();
  });
});
