// Page: shrink a PDF under a size limit.

import '../styles.css';
import type { PdfInfo } from '../engine';
import { alertBox } from '../ui/alert';
import { h, whenIdle } from '../ui/dom';
import { dropzone } from '../ui/dropzone';
import { count, formatBytes, outputName } from '../ui/format';
import { JobPanel } from '../ui/job-panel';
import { errorMessage } from '../ui/messages';
import { targetPicker } from '../ui/target-picker';

/** The engine (with pdf.js) loads on demand; warming up on idle makes the first job instant. */
const engine = () => import('../engine');
whenIdle(() => void engine().then((e) => e.warmUp({ pdf: true })));

let file: File | null = null;
let info: PdfInfo | null = null;
let blocked = false; // the file can't be compressed (not a PDF, password)
let inspection = 0; // ignores results of an inspection that a newer file replaced

const drop = dropzone({
  accept: 'application/pdf,.pdf',
  multiple: false,
  title: 'Trage PDF-ul aici',
  subtitle: 'sau apasă ca să-l alegi',
  hint: 'Fișierul rămâne pe dispozitivul tău.',
  onFiles: ([chosen]) => void choose(chosen),
});
const summary = h('div', { class: 'card file-summary', hidden: true });
const notes = h('div', { class: 'notes', 'aria-live': 'polite' });
const picker = targetPicker();
const grayscale = h('input', { type: 'checkbox' });
const start = h('button', { type: 'button', class: 'button primary large', disabled: true }, 'Micșorează PDF-ul');
const job = new JobPanel('Alt fișier');

const options = h(
  'div',
  { class: 'options', hidden: true },
  picker.element,
  h('label', { class: 'check' }, grayscale, h('span', {}, 'Gri, fără culori (fișier mai mic)')),
  start,
);

document.getElementById('app')!.replaceChildren(drop.element, summary, notes, options, job.element);

picker.onChange(update);
start.addEventListener('click', () => void compress());
job.onRestart = () => {
  job.reset();
  file = null;
  info = null;
  summary.hidden = true;
  options.hidden = true;
  notes.replaceChildren();
  drop.element.hidden = false;
  drop.open();
};

async function choose(chosen: File) {
  job.reset();
  file = chosen;
  info = null;
  blocked = false;
  const id = ++inspection;
  drop.element.hidden = true;
  summary.hidden = false;
  options.hidden = false;

  if (!/\.pdf$/i.test(chosen.name) && chosen.type !== 'application/pdf') {
    blocked = true;
    renderSummary('');
    notes.replaceChildren(alert('error', 'Acesta nu este un PDF', 'Alege un fișier PDF. Pentru poze folosește „Poze → un singur PDF”.'));
    update();
    return;
  }

  renderSummary('Se analizează…');
  update();
  try {
    const result = await (await engine()).inspectPdf(chosen);
    if (id !== inspection) return;
    info = result;
    renderSummary(count(result.pageCount, 'pagină', 'pagini'));
  } catch (error) {
    if (id !== inspection) return;
    blocked = true;
    renderSummary('');
    notes.replaceChildren(alert('error', 'Nu se poate deschide', errorMessage(error, picker.value() ?? 0)));
  }
  update();
}

function renderSummary(pages: string) {
  if (!file) return;
  const change = h('button', { type: 'button', class: 'button link', onclick: () => drop.open() }, 'Schimbă fișierul');
  summary.replaceChildren(
    h('div', { class: 'file-name' }, file.name),
    h('div', { class: 'muted' }, [formatBytes(file.size), pages].filter(Boolean).join(' · ')),
    change,
  );
}

/** Refreshes the warnings and the button after any change. */
function update() {
  const target = picker.value();
  start.disabled = !file || blocked || job.busy || target === null;
  if (!file || blocked) return;

  const items: HTMLElement[] = [];
  if (info?.signed) {
    items.push(
      alert(
        'warning',
        'Are semnătură electronică',
        'Fișierul micșorat nu va mai fi semnat. Dacă portalul verifică semnătura, încarcă documentul original.',
      ),
    );
  }
  if (info?.xfa) {
    items.push(
      alert(
        'warning',
        'Este un formular ANAF (XFA)',
        'Câmpurile completabile se pierd la micșorare. Dacă trebuie depus ca formular, trimite originalul.',
      ),
    );
  }
  if (info?.kind === 'digital') {
    items.push(
      alert(
        'info',
        'Pare creat pe calculator, nu scanat',
        'Textul unui astfel de PDF ocupă puțin. Transformat în imagini, de obicei iese mai mare, așa că s-ar putea să nu se poată micșora mult.',
      ),
    );
  }
  if (target !== null && file.size <= target) {
    items.push(
      alert('success', 'E deja sub limită', `Fișierul are ${formatBytes(file.size)}, mai puțin de ${formatBytes(target)}. Nu trebuie micșorat.`),
    );
  }
  if (target === null) {
    items.push(alert('info', 'Limită nevalidă', 'Scrie o limită de cel puțin 20 KB, de exemplu 1,5 MB sau 800 KB.'));
  }
  notes.replaceChildren(...items);
}

async function compress() {
  const target = picker.value();
  if (!file || target === null) return;
  const chosen = file;
  start.disabled = true;
  await job.run(
    async ({ onProgress, signal }) =>
      (await engine()).compressPdf(chosen, { targetBytes: target, grayscale: grayscale.checked, onProgress, signal }),
    { inputBytes: chosen.size, targetBytes: target, outputName: outputName(chosen.name, target) },
  );
  update();
}

const alert = alertBox;
