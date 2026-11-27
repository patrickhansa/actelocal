// A file drop zone that is also a button for the file picker. Files dropped anywhere on the
// page count too (and the browser doesn't navigate away to show them).

import { h } from './dom';
import { icon } from './icons';

export interface DropzoneOptions {
  accept: string;
  multiple: boolean;
  title: string;
  subtitle: string;
  hint: string;
  onFiles(files: File[]): void;
}

export interface Dropzone {
  element: HTMLElement;
  /** Opens the file picker. */
  open(): void;
}

export function dropzone(options: DropzoneOptions): Dropzone {
  const input = h('input', {
    type: 'file',
    class: 'visually-hidden',
    accept: options.accept,
    multiple: options.multiple,
    onchange: () => {
      const files = [...(input.files ?? [])];
      input.value = ''; // so choosing the same file again still counts as a change
      if (files.length) options.onFiles(files);
    },
  });
  const element = h(
    'label',
    { class: 'dropzone' },
    input,
    icon('upload'),
    h('span', { class: 'dropzone-title' }, options.title),
    h('span', { class: 'dropzone-subtitle' }, options.subtitle),
    h('span', { class: 'dropzone-hint' }, options.hint),
  );

  let depth = 0; // dragenter/dragleave fire for every child element
  const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    depth++;
    document.body.classList.add('dragging-files');
  });
  window.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      document.body.classList.remove('dragging-files');
    }
  });
  window.addEventListener('dragover', (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging-files');
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) options.onFiles(options.multiple ? files : files.slice(0, 1));
  });

  return { element, open: () => input.click() };
}
