// @vitest-environment jsdom
/** ComboEditor: the ▾ lists every option whatever the field contains (a native datalist filtered by the typed text). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ComboEditor } from './editors';

function mount(options: readonly string[], initial = options[0] ?? '') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const [value, setValue] = createSignal(initial);
  const commit = vi.fn((v: string) => { setValue(v); return true; });
  const dispose = render(() => <ComboEditor value={value} commit={commit} options={() => options} />, host);
  const input = host.querySelector('input')!;
  const button = host.querySelector('button')!;
  const popup = () => document.querySelector('.wrl-combo-popup');
  const optionTexts = () => [...document.querySelectorAll('.wrl-combo-option')].map((o) => o.textContent);
  return { host, input, button, popup, optionTexts, commit, value, dispose: () => { dispose(); host.remove(); } };
}

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

describe('ComboEditor', () => {
  it('shows every option on ▾ although the field already holds one of them', () => {
    const m = mount(['<Fixed Frame>', 'base_link', 'map', 'odom'], 'base_link');
    cleanup = m.dispose;
    expect(m.input.value).toBe('base_link');
    expect(m.popup()).toBeNull();
    m.button.click();
    expect(m.popup()).not.toBeNull();
    // Portalled under <body> (Solid wraps it in a container div), not inside the editor's own subtree.
    expect(m.host.contains(m.popup()!)).toBe(false);
    expect(m.popup()!.parentElement!.parentElement).toBe(document.body);
    expect(m.optionTexts()).toEqual(['<Fixed Frame>', 'base_link', 'map', 'odom']);
    expect(document.querySelector('.wrl-combo-option-current')?.textContent).toBe('base_link');
  });

  it('clicking an option commits it and closes the popup', () => {
    const m = mount(['/scan', '/scan_filtered'], '/scan');
    cleanup = m.dispose;
    m.button.click();
    (document.querySelectorAll('.wrl-combo-option')[1] as HTMLElement).click();
    expect(m.commit).toHaveBeenCalledWith('/scan_filtered');
    expect(m.value()).toBe('/scan_filtered');
    expect(m.input.value).toBe('/scan_filtered');
    expect(m.popup()).toBeNull();
  });

  it('keyboard: ArrowDown opens, Enter picks the highlighted entry, Escape closes', () => {
    const m = mount(['a', 'b', 'c'], 'a');
    cleanup = m.dispose;
    const key = (k: string) => m.input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    key('ArrowDown');
    expect(m.popup()).not.toBeNull();
    key('ArrowDown');
    expect(document.querySelector('.wrl-combo-option-highlight')?.textContent).toBe('b');
    key('Enter');
    expect(m.commit).toHaveBeenCalledWith('b');
    expect(m.popup()).toBeNull();
    m.button.click();
    key('Escape');
    expect(m.popup()).toBeNull();
  });

  it('an empty option list says so instead of showing nothing', () => {
    const m = mount([], '/initialpose');
    cleanup = m.dispose;
    m.button.click();
    expect(m.optionTexts()).toEqual(['(none)']);
  });

  it('closes when the user clicks elsewhere or scrolls', () => {
    const m = mount(['x', 'y'], 'x');
    cleanup = m.dispose;
    m.button.click();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(m.popup()).toBeNull();
    m.button.click();
    window.dispatchEvent(new Event('scroll'));
    expect(m.popup()).toBeNull();
  });
});
