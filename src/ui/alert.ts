// A coloured message box with an icon, a title and one sentence or two.

import { h } from './dom';
import { icon } from './icons';

export type AlertKind = 'warning' | 'info' | 'success' | 'error';

export function alertBox(kind: AlertKind, title: string, text: string): HTMLElement {
  return h(
    'div',
    { class: `alert ${kind}`, role: kind === 'error' ? 'alert' : undefined },
    icon(kind === 'success' ? 'check' : 'warning'),
    h('div', {}, h('strong', {}, title), h('p', {}, text)),
  );
}
