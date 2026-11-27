// Page: phone photos of a document into one A4 PDF under a size limit.

import '../styles.css';
import type { PhotoLayout, Rotation } from '../engine';
import { alertBox } from '../ui/alert';
import { h, whenIdle } from '../ui/dom';
import { dropzone } from '../ui/dropzone';
import { count, outputName } from '../ui/format';
import { icon } from '../ui/icons';
import { JobPanel } from '../ui/job-panel';
import { errorMessage } from '../ui/messages';
import { targetPicker } from '../ui/target-picker';

const engine = () => import('../engine');
whenIdle(() => void engine().then((e) => e.warmUp()));

interface Photo {
  file: File;
  rotation: Rotation;
  card: HTMLLIElement;
  thumb: HTMLCanvasElement;
  label: HTMLElement;
  buttons: { move: HTMLButtonElement; rotate: HTMLButtonElement; remove: HTMLButtonElement };
}

let photos: Photo[] = [];

const drop = dropzone({
  accept: 'image/*', // on iPhones this also converts HEIC photos to JPEG
  multiple: true,
  title: 'Trage pozele aici',
  subtitle: 'sau apasă ca să le alegi ori să faci poze',
  hint: 'Poți alege mai multe deodată. Pozele rămân pe dispozitivul tău.',
  onFiles: (files) => void addPhotos(files),
});
const grid = h('ol', { class: 'photo-grid', 'aria-label': 'Pozele, în ordinea din PDF' });
const addMore = h('button', { type: 'button', class: 'button secondary', onclick: () => drop.open() }, icon('plus'), 'Adaugă poze');
const photosSection = h(
  'section',
  { class: 'photos', hidden: true },
  h('p', { class: 'muted' }, 'Trage de mâner ca să schimbi ordinea. Poți roti sau șterge fiecare poză.'),
  grid,
  addMore,
);
const notes = h('div', { class: 'notes', 'aria-live': 'polite' });

const layoutRadio = (value: PhotoLayout, label: string, checked: boolean) => {
  const radio = h('input', { type: 'radio', name: 'layout', value, checked, class: 'visually-hidden', onchange: renumber });
  return { radio, chip: h('label', { class: 'chip' }, radio, h('span', {}, label)) };
};
const onePerPage = layoutRadio('one-per-page', 'O poză pe pagină', true);
const twoPerPage = layoutRadio('two-per-page', 'Două poze pe pagină (buletin față-verso)', false);
const layout = (): PhotoLayout => (twoPerPage.radio.checked ? 'two-per-page' : 'one-per-page');

const grayscale = h('input', { type: 'checkbox' });
const picker = targetPicker();
const start = h('button', { type: 'button', class: 'button primary large', disabled: true }, 'Fă PDF-ul');
const job = new JobPanel('Ia-o de la capăt');

const options = h(
  'div',
  { class: 'options', hidden: true },
  h('fieldset', { class: 'field' }, h('legend', {}, 'Așezare în pagină'), h('div', { class: 'chips' }, onePerPage.chip, twoPerPage.chip)),
  h('label', { class: 'check' }, grayscale, h('span', {}, 'Gri, fără culori (fișier mai mic)')),
  picker.element,
  start,
);

document.getElementById('app')!.replaceChildren(drop.element, photosSection, notes, options, job.element);

picker.onChange(update);
start.addEventListener('click', () => void makePdf());
job.onRestart = () => {
  job.reset();
  photos = [];
  grid.replaceChildren();
  notes.replaceChildren();
  update();
  drop.open();
};

const isImage = (file: File) =>
  file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(file.name);

async function addPhotos(files: File[]) {
  job.reset();
  const images = files.filter(isImage);
  const skipped = files.length - images.length;
  const messages: HTMLElement[] = [];
  if (skipped) {
    messages.push(alertBox('info', `Am sărit peste ${count(skipped, 'fișier', 'fișiere')}`, 'Aici merg doar poze. Pentru PDF-uri folosește „Micșorează PDF”.'));
  }
  notes.replaceChildren(...messages);

  const added = images.map(createPhoto);
  photos.push(...added);
  grid.append(...added.map((photo) => photo.card));
  renumber();
  update();

  // Thumbnails decode in the background, at a small size; a photo the browser can't read is removed.
  for (const photo of added) {
    try {
      await drawThumbnail(photo);
    } catch (error) {
      removePhoto(photo);
      notes.append(alertBox('error', 'O poză nu poate fi citită', errorMessage(error, 0)));
    }
  }
}

function createPhoto(file: File): Photo {
  const thumb = h('canvas', { class: 'rot-0', width: 1, height: 1 });
  const label = h('span', { class: 'photo-label' });
  const move = h('button', { type: 'button', class: 'icon-button grip' }, icon('grip'));
  const rotate = h('button', { type: 'button', class: 'icon-button' }, icon('rotate'));
  const remove = h('button', { type: 'button', class: 'icon-button' }, icon('remove'));
  const card = h('li', { class: 'photo-card' }, h('div', { class: 'photo-thumb' }, thumb, label), h('div', { class: 'photo-bar' }, move, rotate, remove));
  const photo: Photo = { file, rotation: 0, card, thumb, label, buttons: { move, rotate, remove } };

  rotate.addEventListener('click', () => {
    photo.rotation = ((photo.rotation + 90) % 360) as Rotation;
    thumb.className = `rot-${photo.rotation}`;
  });
  remove.addEventListener('click', () => {
    removePhoto(photo);
    (grid.querySelector<HTMLButtonElement>('.grip') ?? addMore).focus();
  });
  enableReordering(photo);
  return photo;
}

async function drawThumbnail(photo: Photo) {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(photo.file, { imageOrientation: 'from-image', resizeHeight: 360, resizeQuality: 'medium' });
  } catch {
    try {
      bitmap = await createImageBitmap(photo.file, { imageOrientation: 'from-image' });
    } catch (error) {
      throw Object.assign(new Error('unsupported image'), { code: 'unsupported-image', detail: { fileName: photo.file.name }, cause: error });
    }
  }
  const scale = Math.min(1, 360 / bitmap.height);
  photo.thumb.width = Math.round(bitmap.width * scale);
  photo.thumb.height = Math.round(bitmap.height * scale);
  photo.thumb.getContext('2d')!.drawImage(bitmap, 0, 0, photo.thumb.width, photo.thumb.height);
  bitmap.close();
}

function removePhoto(photo: Photo) {
  photos = photos.filter((p) => p !== photo);
  photo.card.remove();
  renumber();
  update();
}

/** Reordering: drag the handle (mouse or touch), or focus it and use the arrow keys. */
function enableReordering(photo: Photo) {
  const { card, buttons } = photo;
  const grip = buttons.move;

  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    card.classList.add('dragging');
    const onMove = (e: PointerEvent) => {
      // Scroll when dragging near the top or bottom edge (touch screens can't scroll meanwhile).
      if (e.clientY < 60) window.scrollBy(0, -12);
      else if (e.clientY > window.innerHeight - 60) window.scrollBy(0, 12);
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLLIElement>('.photo-card');
      if (!over || over === card || over.parentElement !== grid) return;
      const cards = [...grid.children];
      grid.insertBefore(card, cards.indexOf(card) < cards.indexOf(over) ? over.nextSibling : over);
      syncOrder();
    };
    const onEnd = () => {
      card.classList.remove('dragging');
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onEnd);
      grip.removeEventListener('pointercancel', onEnd);
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onEnd);
    grip.addEventListener('pointercancel', onEnd);
  });

  grip.addEventListener('keydown', (event) => {
    const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    if (!back && !forward) return;
    event.preventDefault();
    if (back && card.previousElementSibling) grid.insertBefore(card, card.previousElementSibling);
    if (forward && card.nextElementSibling) grid.insertBefore(card.nextElementSibling, card);
    syncOrder();
    grip.focus();
  });
}

function syncOrder() {
  const byCard = new Map(photos.map((photo) => [photo.card as Element, photo]));
  photos = [...grid.children].map((card) => byCard.get(card)!);
  renumber();
}

/** Labels each photo with where it lands: "2", or "Pag. 1, jos" with two photos per page. */
function renumber() {
  const two = layout() === 'two-per-page';
  photos.forEach((photo, i) => {
    const place = two ? `Pag. ${Math.floor(i / 2) + 1}, ${i % 2 ? 'jos' : 'sus'}` : `${i + 1}`;
    photo.label.textContent = place;
    photo.buttons.move.setAttribute('aria-label', `Mută poza ${i + 1} (trage sau folosește săgețile)`);
    photo.buttons.rotate.setAttribute('aria-label', `Rotește poza ${i + 1}`);
    photo.buttons.remove.setAttribute('aria-label', `Șterge poza ${i + 1}`);
  });
}

function update() {
  const has = photos.length > 0;
  drop.element.hidden = has;
  photosSection.hidden = !has;
  options.hidden = !has;
  start.textContent = has ? `Fă PDF-ul din ${count(photos.length, 'poză', 'poze')}` : 'Fă PDF-ul';
  start.disabled = !has || job.busy || picker.value() === null;
}

async function makePdf() {
  const target = picker.value();
  if (!photos.length || target === null) return;
  const inputs = photos.map(({ file, rotation }) => ({ file, rotation }));
  start.disabled = true;
  await job.run(
    async ({ onProgress, signal }) =>
      (await engine()).photosToPdf(inputs, { layout: layout(), targetBytes: target, grayscale: grayscale.checked, onProgress, signal }),
    {
      inputBytes: inputs.reduce((sum, { file }) => sum + file.size, 0),
      targetBytes: target,
      outputName: outputName(null, target),
      resultNote: 'Locația GPS și celelalte date ascunse din poze nu au ajuns în PDF.',
    },
  );
  update();
}
