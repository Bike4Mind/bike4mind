// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatModelOption } from '@shared/chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelPicker } from './ModelPicker';
import type { ModelCatalogController } from './useChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

/** Past FILTER_THRESHOLD, so the filter box renders and the list is long enough to scroll. */
const MODELS: ChatModelOption[] = Array.from({ length: 12 }, (_, index) => ({
  id: `vendor/model-${index}`,
  name: `Model ${index}`,
}));

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(models = MODELS) {
  const onSelect = vi.fn<(model: string) => void>();
  const catalog: ModelCatalogController = { models, loading: false, error: null, reload: vi.fn() };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <CssVarsProvider>
        <ModelPicker catalog={catalog} modelId={models[0]?.id ?? null} onSelect={onSelect} />
      </CssVarsProvider>
    );
  });
  act(() => el('model-picker-btn').click());
  return { onSelect };
}

/** The menu is a portal, so it lands on `document`, not under `host`. */
const el = (testId: string) => {
  const found = document.querySelector(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`no ${testId}`);
  return found as HTMLElement;
};
const options = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="model-picker-option"]'));
const filterBox = () => el('model-picker-filter') as HTMLInputElement;

const key = (node: HTMLElement, value: string) =>
  act(() => {
    node.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
  });

function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  for (const char of text) {
    key(input, char);
    act(() => {
      setter?.call(input, input.value + char);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}

/** What a wheel scroll produces: rows passing under a stationary pointer, which Joy focuses. */
const hover = (row: HTMLElement) =>
  act(() => {
    row.dispatchEvent(new Event('pointerover', { bubbles: true }));
  });

describe('ModelPicker filter box', () => {
  it('takes focus when the menu opens, without scrolling the list to reach it', () => {
    const focus = vi.spyOn(HTMLInputElement.prototype, 'focus');
    mount();
    expect(document.activeElement).toBe(filterBox());
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    focus.mockRestore();
  });

  it('takes focus back from a hovered row without scrolling the list to reach it', () => {
    mount();
    const input = filterBox();
    const focus = vi.spyOn(input, 'focus');

    hover(options()[6]!);

    // The restore has to happen - Joy focuses the hovered row, and a focus lost mid-query loses
    // the rest of it - but reaching the box must not drag the menu back to the top.
    expect(focus).toHaveBeenCalled();
    expect(focus.mock.calls.every(([options]) => options?.preventScroll === true)).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it('keeps focus for a whole multi-character query as the list narrows', () => {
    mount();
    const input = filterBox();

    typeInto(input, 'model-11');
    // Joy re-focuses its highlighted item on every narrowing; the box has to win each time.
    hover(options()[0]!);

    expect(input.value).toBe('model-11');
    expect(document.activeElement).toBe(input);
    expect(options()).toHaveLength(1);
  });

  it('lets an arrow key hand the list its focus back', () => {
    mount();
    const input = filterBox();

    key(input, 'ArrowDown');
    const row = options()[3]!;
    hover(row);
    act(() => row.focus());

    expect(document.activeElement).toBe(row);
  });
});
