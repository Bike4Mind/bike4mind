// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatModelOption } from '@shared/chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupByServer, ModelPicker, rowDetails, sortByRecency } from './ModelPicker';
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

    typeInto(input, 'model 11');
    // Joy re-focuses its highlighted item on every narrowing; the box has to win each time.
    hover(options()[0]!);

    expect(input.value).toBe('model 11');
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

describe('ModelPicker server groups', () => {
  const gpu = { id: 'abc123', name: 'gpu box' };
  const lab = { id: 'def456', name: 'lab' };
  const grouped: ChatModelOption[] = [
    { id: 'local:ollama:qwen3:8b', name: 'qwen3:8b' },
    { id: 'local:srv-abc123:qwen3:8b', name: 'qwen3:8b', server: gpu },
    { id: 'local:srv-def456:llama3', name: 'llama3', server: lab, unavailable: 'lab is unreachable' },
    { id: 'claude-sonnet', name: 'Claude Sonnet' },
  ];

  it('orders hosted, this computer, then each server, and stays flat without servers', () => {
    expect(groupByServer(grouped).map(group => [group.label, group.models.map(model => model.id)])).toEqual([
      ['Hosted', ['claude-sonnet']],
      ['This computer', ['local:ollama:qwen3:8b']],
      ['gpu box', ['local:srv-abc123:qwen3:8b']],
      ['lab', ['local:srv-def456:llama3']],
    ]);
    expect(groupByServer(grouped.filter(model => !model.server)).map(group => group.label)).toEqual([null]);
  });

  it("lists an unreachable server's models disabled, saying why", () => {
    const { onSelect } = mount(grouped);
    expect(
      Array.from(document.querySelectorAll('[data-testid="model-picker-group-label"]')).map(node => node.textContent)
    ).toEqual(['Hosted', 'This computer', 'gpu box', 'lab']);
    const down = options().find(option => option.dataset.unavailable === 'true')!;
    expect(down.textContent).toContain('lab is unreachable');
    expect(down.getAttribute('aria-disabled')).toBe('true');
    act(() => down.click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each([
    ['unreachable', 1],
    ['local-srv-def456', 0],
  ])('filters unavailable rows by their visible reason (%s)', (query, count) => {
    mount([
      ...grouped.map(model => (model.unavailable ? { ...model, backend: 'local-srv-def456' } : model)),
      ...MODELS,
    ]);

    typeInto(filterBox(), query);

    expect(options()).toHaveLength(count);
    if (count) expect(options()[0]?.textContent?.toLowerCase()).toContain(query);
  });
});

describe('ModelPicker recency order', () => {
  const dated: ChatModelOption[] = [
    { id: 'undated-a', name: 'Undated A' },
    { id: 'old', name: 'Old', releaseDate: '2024-01-15', backend: 'openai' },
    { id: 'new', name: 'New', releaseDate: '2025-06-01', backend: 'anthropic' },
    { id: 'undated-b', name: 'Undated B' },
    { id: 'tie-1', name: 'Tie 1', releaseDate: '2025-01-01' },
    { id: 'tie-2', name: 'Tie 2', releaseDate: '2025-01-01' },
  ];

  it('puts the newest first, undated last, and keeps ties and undated in incoming order', () => {
    const input = [...dated];
    expect(sortByRecency(dated).map(model => model.id)).toEqual([
      'new',
      'tie-1',
      'tie-2',
      'old',
      'undated-a',
      'undated-b',
    ]);
    expect(dated).toEqual(input);
  });

  it('lists rows newest first and hides the model id, showing the provider instead', () => {
    mount(dated);
    expect(options().map(option => option.textContent?.replace('\u2022 ', ''))).toEqual([
      'New' + 'anthropic',
      'Tie 1',
      'Tie 2',
      'Old' + 'openai',
      'Undated A',
      'Undated B',
    ]);
    expect(options().some(option => option.textContent?.includes('undated-a'))).toBe(false);
  });

  it('selects the newest filtered match on Enter without changing catalog order', async () => {
    const models = [
      { id: 'older', name: 'Matching old', releaseDate: '2024-01-01' },
      { id: 'newer', name: 'Matching new', releaseDate: '2025-01-01' },
      ...MODELS,
    ];
    const { onSelect } = mount(models);

    typeInto(filterBox(), 'matching');
    await act(async () => key(filterBox(), 'Enter'));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('newer');
    expect(models[0]?.id).toBe('older');
  });

  it('renders no secondary line for a row with nothing to say', () => {
    mount([...dated, ...MODELS]);
    expect(
      options()
        .find(option => option.textContent?.includes('Undated A'))
        ?.querySelector('[data-testid="model-picker-option-detail"]')
    ).toBeNull();
  });

  it('filters on what a row shows - the name and provider - not the hidden id', () => {
    mount([...dated, ...MODELS]);
    const rows = () => options().map(option => option.textContent?.replace('\u2022 ', ''));

    typeInto(filterBox(), 'undated a');
    expect(rows()).toEqual(['Undated A']);

    act(() => el('model-picker-btn').click());
    act(() => el('model-picker-btn').click());
    typeInto(filterBox(), 'anthropic');
    expect(rows()).toEqual(['New' + 'anthropic']);

    act(() => el('model-picker-btn').click());
    act(() => el('model-picker-btn').click());
    typeInto(filterBox(), 'vendor/');
    expect(options()).toHaveLength(0);
  });
});

describe('ModelPicker twin rows', () => {
  const twins: ChatModelOption[] = [
    { id: 'gpt-4.1-2025-04-14', name: 'GPT-4.1', backend: 'openai' },
    { id: 'gpt-4.1', name: 'GPT-4.1', backend: 'openai' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', backend: 'openai' },
    { id: 'local:srv-a:llama3', name: 'llama3', server: { id: 'a', name: 'a' } },
    { id: 'local:srv-b:llama3', name: 'llama3', server: { id: 'b', name: 'b' } },
  ];

  it('adds the id only where name and provider collide within a group', () => {
    expect(Object.fromEntries(rowDetails(twins))).toEqual({
      'gpt-4.1-2025-04-14': 'openai - gpt-4.1-2025-04-14',
      'gpt-4.1': 'openai - gpt-4.1',
      'gpt-4.1-mini': 'openai',
      'local:srv-a:llama3': undefined,
      'local:srv-b:llama3': undefined,
    });
  });

  it("names a LoRA adapter's base on its row", () => {
    const server = { id: 'v', name: 'gpu vllm' };
    expect(
      Object.fromEntries(
        rowDetails([
          { id: 'local:srv-v:qwen-small', name: 'qwen-small', server },
          { id: 'local:srv-v:sql-lora', name: 'sql-lora', server, baseModel: 'qwen-small' },
        ])
      )
    ).toEqual({ 'local:srv-v:qwen-small': undefined, 'local:srv-v:sql-lora': 'LoRA on qwen-small' });
  });

  it('shows the ids that tell twins apart, and filters on them', () => {
    mount([...twins, ...MODELS]);
    const details = () =>
      Array.from(document.querySelectorAll('[data-testid="model-picker-option-detail"]')).map(node => node.textContent);
    expect(details()).toContain('openai - gpt-4.1-2025-04-14');
    expect(details()).toContain('openai');

    typeInto(filterBox(), '2025-04');
    expect(options()).toHaveLength(1);
  });

  it.each([
    ['needs credentials', 2],
    ['2025-04', 0],
  ])('filters unavailable twins by the reason replacing their ids (%s)', (query, count) => {
    mount([...twins.slice(0, 2).map(model => ({ ...model, unavailable: 'Provider needs credentials' })), ...MODELS]);

    typeInto(filterBox(), query);

    expect(options()).toHaveLength(count);
    expect(options().every(option => option.textContent?.toLowerCase().includes(query))).toBe(true);
  });
});
