// Runs one engine job and shows it: progress with a cancel button, then the result (sizes,
// download, page 1 at 100% to check it reads well) or what went wrong.

import type { EngineResult, Progress } from '../engine';
import { h } from './dom';
import { formatBytes } from './format';
import { icon } from './icons';
import { errorMessage } from './messages';

export interface JobInput {
  /** Total size of the input files. */
  inputBytes: number;
  targetBytes: number;
  /** Name for the downloaded file. */
  outputName: string;
  /** Extra line for the result, e.g. what happened to photo metadata. */
  resultNote?: string;
}

export type Task = (hooks: { onProgress(progress: Progress): void; signal: AbortSignal }) => Promise<EngineResult>;

export class JobPanel {
  readonly element = h('div', { class: 'job', 'aria-live': 'polite' });
  /** Called when the user asks to start over from a result or an error. */
  onRestart: () => void = () => undefined;
  private controller: AbortController | null = null;
  private objectUrls: string[] = [];
  private readonly restartLabel: string;

  constructor(restartLabel: string) {
    this.restartLabel = restartLabel;
  }

  get busy(): boolean {
    return this.controller !== null;
  }

  /** Clears the panel and frees the previous result. */
  reset(): void {
    this.controller?.abort();
    this.controller = null;
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls = [];
    this.element.replaceChildren();
  }

  async run(task: Task, input: JobInput): Promise<void> {
    this.reset();
    const controller = new AbortController();
    this.controller = controller;

    const status = h('p', { class: 'progress-status' }, 'Se pregătește…');
    const fill = h('div', { class: 'progress-fill' });
    const bar = h('div', { class: 'progress indeterminate', role: 'progressbar', 'aria-label': 'Progres' }, fill);
    const cancel = h('button', { type: 'button', class: 'button secondary', onclick: () => controller.abort() }, 'Anulează');
    this.element.replaceChildren(h('div', { class: 'card progress-card' }, status, bar, cancel));

    const onProgress = ({ attempt, page, pageCount }: Progress) => {
      bar.classList.remove('indeterminate');
      const share = page / pageCount;
      fill.style.transform = `scaleX(${share})`;
      bar.setAttribute('aria-valuenow', String(Math.round(share * 100)));
      status.textContent =
        attempt > 1 ? `Încerc altă rezoluție · pagina ${page} din ${pageCount}` : `Pagina ${page} din ${pageCount}`;
    };

    try {
      const result = await task({ onProgress, signal: controller.signal });
      if (controller.signal.aborted) return;
      this.showResult(result, input);
    } catch (error) {
      if (controller.signal.aborted || (error as { code?: string }).code === 'cancelled') {
        this.element.replaceChildren(h('p', { class: 'muted' }, 'Oprit.'));
      } else {
        console.error(error);
        this.showError(errorMessage(error, input.targetBytes));
      }
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  private showResult(result: EngineResult, input: JobInput): void {
    const restart = h('button', { type: 'button', class: 'button secondary', onclick: () => this.onRestart() }, this.restartLabel);

    if (result.unchanged) {
      this.element.replaceChildren(
        h(
          'div',
          { class: 'card result-card' },
          h('h2', { tabIndex: -1 }, icon('check'), 'Nu e nevoie să-l micșorezi'),
          h(
            'p',
            {},
            `Fișierul are deja ${formatBytes(result.pdf.length)}, sub limita de ${formatBytes(input.targetBytes)}. ` +
              'L-am lăsat exact cum era (inclusiv o eventuală semnătură electronică).',
          ),
          restart,
        ),
      );
      this.focusResult();
      return;
    }

    const url = this.objectUrl(new Blob([result.pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }));
    const details =
      result.encoding === 'bitonal'
        ? `Rezoluție ${result.dpi} dpi. Documentul era alb-negru și a rămas alb-negru, așa că a ieșit mic și clar.`
        : `Rezoluție ${result.dpi} dpi.`;

    const card = h(
      'div',
      { class: 'card result-card' },
      h('h2', { tabIndex: -1 }, icon('check'), 'Gata'),
      h(
        'p',
        { class: 'sizes' },
        h('span', { class: 'size-before' }, formatBytes(input.inputBytes)),
        h('span', { 'aria-hidden': 'true' }, ' → '),
        h('strong', { class: 'size-after' }, formatBytes(result.pdf.length)),
        h('span', { class: 'visually-hidden' }, ` (înainte ${formatBytes(input.inputBytes)})`),
      ),
      h('p', {}, `Sub limita de ${formatBytes(input.targetBytes)}. ${details}`),
      input.resultNote ? h('p', {}, input.resultNote) : null,
      h('p', { class: 'muted' }, 'Paginile au devenit imagini, deci textul nu se mai poate selecta sau căuta.'),
      h('a', { class: 'button primary', href: url, download: input.outputName }, icon('download'), `Descarcă ${input.outputName}`),
      result.preview ? this.preview(result) : null,
      restart,
    );
    this.element.replaceChildren(card);
    this.focusResult();
  }

  /** Page 1 as large as a PDF viewer shows it at 100%, so the user can check it reads well. */
  private preview(result: EngineResult): HTMLElement {
    const image = h('img', {
      src: this.objectUrl(result.preview!),
      alt: 'Pagina 1 a documentului micșorat',
      class: 'preview-image',
      decoding: 'async',
    });
    image.style.width = `${(result.firstPageSize.widthPt * 96) / 72}px`; // 100% zoom: 1 pt = 96/72 CSS px
    const frame = h('div', { class: 'preview-frame', tabIndex: 0, 'aria-label': 'Previzualizarea paginii 1' }, image);

    // 100% shows whether the text reads well; the whole page gives the overview.
    const actual = h('button', { type: 'button', class: 'button secondary', 'aria-pressed': 'true' }, 'Mărime reală (100%)');
    const whole = h('button', { type: 'button', class: 'button secondary', 'aria-pressed': 'false' }, 'Toată pagina');
    const zoom = (fit: boolean) => {
      frame.classList.toggle('fit', fit);
      actual.setAttribute('aria-pressed', String(!fit));
      whole.setAttribute('aria-pressed', String(fit));
    };
    actual.addEventListener('click', () => zoom(false));
    whole.addEventListener('click', () => zoom(true));

    return h(
      'section',
      { class: 'preview' },
      h('h3', {}, 'Verifică dacă se citește'),
      h('p', { class: 'muted' }, 'Pagina 1, la mărimea la care o arată un cititor de PDF la 100%. Derulează în cadru ca s-o vezi toată.'),
      h('div', { class: 'preview-zoom' }, actual, whole),
      frame,
    );
  }

  private showError(message: string): void {
    this.element.replaceChildren(
      h(
        'div',
        { class: 'card alert error', role: 'alert' },
        h('h2', { tabIndex: -1 }, icon('warning'), 'Nu a mers'),
        h('p', {}, message),
        h('button', { type: 'button', class: 'button secondary', onclick: () => this.onRestart() }, this.restartLabel),
      ),
    );
    this.focusResult();
  }

  private focusResult(): void {
    const heading = this.element.querySelector('h2');
    heading?.focus({ preventScroll: true });
    this.element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private objectUrl(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    this.objectUrls.push(url);
    return url;
  }
}
