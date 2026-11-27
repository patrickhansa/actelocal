// A tiny helper for building DOM elements. Text always goes in as text nodes, never as
// HTML, so a file name can't inject markup.

type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown>;

/**
 * h('button', { class: 'button', onclick: f, 'aria-label': 'Close' }, 'Text')
 * Keys starting with "on" add event listeners; aria-*, data-*, role and for become
 * attributes; anything else is set as a property.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = String(value);
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value as EventListener);
    else if (/^(aria-|data-)/.test(key) || key === 'role' || key === 'for') element.setAttribute(key, String(value));
    else (element as unknown as Record<string, unknown>)[key] = value;
  }
  element.append(...children.filter((child): child is Node | string => child !== null && child !== undefined && child !== false));
  return element;
}

/** Runs `task` when the browser is idle (soon, at the latest), so it doesn't slow the first paint. */
export function whenIdle(task: () => void): void {
  if ('requestIdleCallback' in window) window.requestIdleCallback(task, { timeout: 2000 });
  else setTimeout(task, 800);
}
