// Photos → A4 PageSources (one or two photos per page). See docs/engine-design.md §3.

import { A4, PHOTO_GAP_PT, PHOTO_MARGIN_PT } from './config';
import { EngineError, type PageSource, type PhotoInput, type PhotoLayout, type Rotation } from './types';

interface Size {
  width: number;
  height: number;
}

interface Rect extends Size {
  x: number;
  y: number;
}

/** Where photo `photo` goes on its page: points from the page's top-left corner, after rotation. */
export interface Placement extends Rect {
  photo: number;
}

export interface PageLayout {
  widthPt: number;
  heightPt: number;
  placements: Placement[];
}

/**
 * Lays photos out on A4 pages. `photos` are pixel sizes after EXIF orientation,
 * plus the user's rotation.
 */
export function layoutPhotos(photos: readonly (Size & { rotation: Rotation })[], layout: PhotoLayout): PageLayout[] {
  const sizes = photos.map(({ width, height, rotation }) =>
    rotation % 180 === 0 ? { width, height } : { width: height, height: width },
  );
  const margin = PHOTO_MARGIN_PT;

  if (layout === 'one-per-page') {
    return sizes.map((size, photo) => {
      // The page turns with the photo, so a landscape ID card gets a landscape page.
      const page = size.width > size.height ? { widthPt: A4.heightPt, heightPt: A4.widthPt } : { ...A4 };
      const box = { x: margin, y: margin, width: page.widthPt - 2 * margin, height: page.heightPt - 2 * margin };
      return { ...page, placements: [fit(photo, size, box)] };
    });
  }

  // Two per page: top and bottom halves of a portrait A4 page.
  const width = A4.widthPt - 2 * margin;
  const height = (A4.heightPt - 2 * margin - PHOTO_GAP_PT) / 2;
  const halves = [
    { x: margin, y: margin, width, height },
    { x: margin, y: margin + height + PHOTO_GAP_PT, width, height },
  ];
  const pages: PageLayout[] = [];
  for (let first = 0; first < sizes.length; first += 2) {
    const placements = [fit(first, sizes[first], halves[0])];
    if (first + 1 < sizes.length) placements.push(fit(first + 1, sizes[first + 1], halves[1]));
    pages.push({ widthPt: A4.widthPt, heightPt: A4.heightPt, placements });
  }
  return pages;
}

/** Largest rect with the photo's aspect ratio that fits in `box`, centred. */
function fit(photo: number, size: Size, box: Rect): Placement {
  const scale = Math.min(box.width / size.width, box.height / size.height);
  const width = size.width * scale;
  const height = size.height * scale;
  return { photo, x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
}

/** Builds one PageSource per output page. Fails with unsupported-image for photos the browser can't read. */
export async function photoPages(photos: readonly PhotoInput[], layout: PhotoLayout): Promise<PageSource[]> {
  const sizes = await Promise.all(photos.map(({ file }) => measure(file)));
  const layouts = layoutPhotos(
    sizes.map((size, i) => ({ ...size, rotation: photos[i].rotation })),
    layout,
  );
  return layouts.map((page) => new PhotoPage(page, photos));
}

class PhotoPage implements PageSource {
  readonly widthPt: number;
  readonly heightPt: number;
  private readonly placements: Placement[];
  private readonly photos: readonly PhotoInput[];

  constructor(layout: PageLayout, photos: readonly PhotoInput[]) {
    this.widthPt = layout.widthPt;
    this.heightPt = layout.heightPt;
    this.placements = layout.placements;
    this.photos = photos;
  }

  async draw(ctx: CanvasRenderingContext2D, pxPerPt: number): Promise<void> {
    // Decode both photos of a page in parallel, each at the pixel size it is drawn at.
    const items = await Promise.all(
      this.placements.map(async (placement) => {
        const { file, rotation } = this.photos[placement.photo];
        const quarterTurn = rotation % 180 !== 0;
        // Size of the photo before rotation, as drawn, in points.
        const drawn = quarterTurn
          ? { width: placement.height, height: placement.width }
          : { width: placement.width, height: placement.height };
        const bitmap = await decode(file, drawn.width * pxPerPt, drawn.height * pxPerPt);
        return { placement, rotation, drawn, bitmap };
      }),
    );

    for (const { placement, rotation, drawn, bitmap } of items) {
      ctx.save();
      ctx.setTransform(pxPerPt, 0, 0, pxPerPt, 0, 0); // 1 unit = 1 point
      ctx.translate(placement.x + placement.width / 2, placement.y + placement.height / 2);
      ctx.rotate((rotation * Math.PI) / 180); // clockwise, since the y axis points down
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, -drawn.width / 2, -drawn.height / 2, drawn.width, drawn.height);
      ctx.restore();
      bitmap.close();
    }
  }
}

/** Pixel size after EXIF orientation. Reads only the header where the browser allows it. */
function measure(file: File): Promise<Size> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new EngineError('unsupported-image', { fileName: file.name }));
    };
    image.src = url;
  });
}

/**
 * Decodes `file` with its EXIF orientation applied, scaled down to about width × height
 * pixels while decoding where the browser supports it (faster, and far less memory).
 */
async function decode(file: File, width: number, height: number): Promise<ImageBitmap> {
  const resizeWidth = Math.max(1, Math.round(width));
  const resizeHeight = Math.max(1, Math.round(height));
  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
      resizeWidth,
      resizeHeight,
      resizeQuality: 'high',
    });
    // Guard against a browser that resizes before applying the EXIF orientation, which
    // would come back with the sides swapped: decode again at full size instead.
    if (bitmap.width === resizeWidth && bitmap.height === resizeHeight) return bitmap;
    bitmap.close();
  } catch {
    // Some browsers reject the resize options; fall through to a full-size decode.
  }
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (error) {
    throw new EngineError('unsupported-image', { fileName: file.name }, { cause: error });
  }
}
