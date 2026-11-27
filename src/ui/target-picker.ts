// Choosing the size limit: preset chips plus a custom size. Remembers the last choice.

import { h } from './dom';
import { formatBytes } from './format';

const PRESETS = [500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000];
const DEFAULT = 1_000_000;
const STORAGE_KEY = 'actelocal.target';
/** Below this, even an empty page doesn't fit. */
const MINIMUM = 20_000;

export interface TargetPicker {
  element: HTMLElement;
  /** The chosen limit in bytes, or null while the custom size is invalid. */
  value(): number | null;
  onChange(listener: () => void): void;
}

export function targetPicker(): TargetPicker {
  const listeners: (() => void)[] = [];
  const changed = () => {
    customRow.hidden = !customRadio.checked;
    const value = picker.value();
    if (value) save(value);
    listeners.forEach((listener) => listener());
  };

  const radios = PRESETS.map((bytes) =>
    h('input', { type: 'radio', name: 'target', value: String(bytes), class: 'visually-hidden', onchange: changed }),
  );
  const customRadio = h('input', { type: 'radio', name: 'target', value: 'custom', class: 'visually-hidden', onchange: changed });
  const customSize = h('input', {
    type: 'text',
    inputMode: 'decimal',
    autocomplete: 'off',
    class: 'custom-size',
    'aria-label': 'Limita, ca număr',
    oninput: changed,
  });
  const customUnit = h(
    'select',
    { class: 'custom-unit', 'aria-label': 'Unitatea', onchange: changed },
    h('option', { value: '1000000' }, 'MB'),
    h('option', { value: '1000' }, 'KB'),
  );
  const customRow = h('div', { class: 'custom-target', hidden: true }, customSize, customUnit);

  const chip = (radio: HTMLInputElement, label: string) => h('label', { class: 'chip' }, radio, h('span', {}, label));
  const element = h(
    'fieldset',
    { class: 'field target-picker' },
    h('legend', {}, 'Limita portalului'),
    h(
      'div',
      { class: 'chips' },
      ...radios.map((radio, i) => chip(radio, formatBytes(PRESETS[i]))),
      chip(customRadio, 'Altă limită'),
    ),
    customRow,
  );

  // Restore the last choice.
  const saved = load();
  const presetIndex = PRESETS.indexOf(saved ?? DEFAULT);
  if (presetIndex >= 0) {
    radios[presetIndex].checked = true;
  } else if (saved) {
    customRadio.checked = true;
    customRow.hidden = false;
    const inMb = saved >= 1_000_000;
    customSize.value = String(inMb ? saved / 1_000_000 : saved / 1000).replace('.', ',');
    customUnit.value = inMb ? '1000000' : '1000';
  }

  const picker: TargetPicker = {
    element,
    value() {
      if (!customRadio.checked) return Number(radios.find((radio) => radio.checked)?.value ?? DEFAULT);
      const number = Number(customSize.value.trim().replace(',', '.'));
      const bytes = Math.round(number * Number(customUnit.value));
      return Number.isFinite(bytes) && bytes >= MINIMUM ? bytes : null;
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
  return picker;
}

// Browser storage can be unavailable (private windows, blocked site data): never fail on it.
function load(): number | null {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return value >= MINIMUM ? value : null;
  } catch {
    return null;
  }
}

function save(bytes: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(bytes));
  } catch {
    // ignore
  }
}
