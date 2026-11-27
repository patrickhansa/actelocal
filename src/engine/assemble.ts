// Packs one image per page into a new PDF. See docs/engine-design.md §6.

import {
  PDFDocument,
  PDFRawStream,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  type PDFDict,
} from 'pdf-lib';
import type { PageSource } from './types';

type PageSize = Pick<PageSource, 'widthPt' | 'heightPt'>;

/** An encoded page image: a Blob in the browser, a stub in tests. */
export interface PageImage {
  format: 'jpeg' | 'g4';
  /** Pixel size; needed for G4, whose data doesn't carry it. */
  width: number;
  height: number;
  blob: { arrayBuffer(): Promise<ArrayBuffer> };
}

/**
 * Builds a fresh PDF: page i has size pages[i] and shows images[i] across the whole page.
 * Image data is embedded unchanged: JPEG as DCTDecode, black-and-white as CCITTFaxDecode.
 * Nothing from any input file's metadata is copied.
 */
export async function assemblePdf(pages: readonly PageSize[], images: readonly PageImage[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setProducer('ActeLocal');
  doc.setCreator('ActeLocal');

  for (const [i, image] of images.entries()) {
    const { widthPt, heightPt } = pages[i];
    const bytes = new Uint8Array(await image.blob.arrayBuffer());
    const page = doc.addPage([widthPt, heightPt]);
    if (image.format === 'jpeg') {
      page.drawImage(await doc.embedJpg(bytes), { x: 0, y: 0, width: widthPt, height: heightPt });
    } else {
      // pdf-lib has no CCITT embedder, so write the image object and the drawing operators directly.
      const dict = doc.context.obj({
        Type: 'XObject',
        Subtype: 'Image',
        Width: image.width,
        Height: image.height,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 1,
        Filter: 'CCITTFaxDecode',
        DecodeParms: { K: -1, Columns: image.width, Rows: image.height },
      }) as PDFDict;
      const name = page.node.newXObject('Im', doc.context.register(PDFRawStream.of(dict, bytes)));
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(widthPt, 0, 0, heightPt, 0, 0), // the image fills the unit square
        drawObject(name),
        popGraphicsState(),
      );
    }
  }

  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}
