import { PDFDocument, PDFName, PDFRawStream, PDFNumber, PDFDict } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { assemblePdf, type PageImage } from './assemble';
import { A4, pdfOverhead } from './config';

/** Bytes pdf-lib accepts as a JPEG: a start marker, a frame header with the size, filler, an end marker. */
function fakeJpeg(size: number, width = 1240, height = 1754): PageImage {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8]); // start of image
  // Baseline frame header: precision 8, height, width, 3 components.
  bytes.set([0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3], 2);
  bytes.set([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 12);
  bytes.set([0xff, 0xd9], size - 2); // end of image
  return { format: 'jpeg', width, height, blob: new Blob([bytes]) };
}

const fakeG4 = (size: number, width = 2480, height = 3508): PageImage => ({
  format: 'g4',
  width,
  height,
  blob: new Blob([new Uint8Array(size)]),
});

describe('assemblePdf', () => {
  for (const pageCount of [1, 10, 60]) {
    for (const [format, make] of [['JPEG', fakeJpeg], ['G4', fakeG4]] as const) {
      it(`stays within pdfOverhead() for ${pageCount} ${format} page(s)`, async () => {
        const imageSize = 80_000;
        const pages = Array.from({ length: pageCount }, () => A4);
        const pdf = await assemblePdf(pages, pages.map(() => make(imageSize)));
        expect(pdf.length - pageCount * imageSize).toBeLessThanOrEqual(pdfOverhead(pageCount));
      });
    }
  }

  it('keeps each page size and sets only our own metadata', async () => {
    const pages = [A4, { widthPt: A4.heightPt, heightPt: A4.widthPt }];
    const bytes = await assemblePdf(pages, [fakeJpeg(5_000), fakeG4(5_000)]);
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false }); // or pdf-lib rewrites Producer
    expect(pdf.getPages().map((p) => p.getSize())).toEqual([
      { width: A4.widthPt, height: A4.heightPt },
      { width: A4.heightPt, height: A4.widthPt },
    ]);
    expect(pdf.getProducer()).toBe('ActeLocal');
    expect(pdf.getAuthor()).toBeUndefined();
    expect(pdf.getTitle()).toBeUndefined();
  });

  it('writes a black-and-white page as a CCITT G4 image', async () => {
    const bytes = await assemblePdf([A4], [fakeG4(1_000, 2480, 3508)]);
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const images = pdf.context
      .enumerateIndirectObjects()
      .map(([, object]) => object)
      .filter((o): o is PDFRawStream => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
    expect(images).toHaveLength(1);
    const { dict } = images[0];
    const num = (d: PDFDict, key: string) => (d.get(PDFName.of(key)) as PDFNumber).asNumber();
    expect(dict.get(PDFName.of('Filter'))).toBe(PDFName.of('CCITTFaxDecode'));
    expect(num(dict, 'BitsPerComponent')).toBe(1);
    expect([num(dict, 'Width'), num(dict, 'Height')]).toEqual([2480, 3508]);
    const parms = dict.get(PDFName.of('DecodeParms')) as PDFDict;
    expect([num(parms, 'K'), num(parms, 'Columns'), num(parms, 'Rows')]).toEqual([-1, 2480, 3508]);
  });
});
