// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { localModelId, NO_LOCAL_MODEL, type ChatModelOption } from '@shared/chat';
import { OLLAMA_NOT_RUNNING, LOCAL_SERVER_ID } from '@shared/modelServers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupByServer, ModelPicker, rowDetails, sortByRecency } from './ModelPicker';
import type { NoLocalModels } from './noLocalModels';
import type { ModelCatalogController } from './useChat';
import {
  changeFilters,
  effectiveFilters,
  filterOptions,
  matchesFilters,
  matchesQuery,
  needsHostedSwitchConfirm,
  NO_FILTERS,
  readModelPickerFilters,
  writeModelPickerFilters,
} from './modelPickerFilters';
import { mergeRouteVariants, routeVariantKey } from './modelRouteVariants';

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

// Joy's popups (menus, selects, tooltips, modals) read every ancestor's computed style on each update,
// and jsdom resolves that against every emotion sheet with no layout to find; the inline style will do.
window.getComputedStyle = ((element: Element) => (element as HTMLElement).style) as typeof getComputedStyle;

const numbered = (count: number): ChatModelOption[] =>
  Array.from({ length: count }, (_, index) => ({ id: `vendor/model-${index}`, name: `Model ${index}` }));
/** Just past FILTER_THRESHOLD, so the filter box renders and the list is long enough to scroll. */
const MODELS = numbered(9);

let root: Root | null = null;
let host: HTMLElement | null = null;

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

afterEach(() => {
  unmount();
  window.localStorage.clear();
});

function mount(
  models = MODELS,
  modelId = models[0]?.id ?? null,
  switchCredits?: (model: ChatModelOption) => number | null,
  extra: {
    servers?: { id: string; name: string }[];
    hasHistory?: boolean;
    sessionId?: string;
    error?: string;
    local?: boolean;
    noLocal?: NoLocalModels;
    onOpenModels?: () => void;
  } = {}
) {
  const onSelect = vi.fn<(model: string) => void>();
  const reload = vi.fn(async () => {});
  const catalog: ModelCatalogController = { models, loading: false, error: extra.error ?? null, reload };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const render = (props: { modelId: string | null; sessionId?: string }) =>
    act(() => {
      root?.render(
        <CssVarsProvider>
          <ModelPicker
            catalog={catalog}
            modelId={props.modelId}
            onSelect={onSelect}
            switchCredits={switchCredits}
            servers={extra.servers}
            hasHistory={extra.hasHistory}
            sessionId={props.sessionId}
            local={extra.local}
            noLocal={extra.noLocal}
            onOpenModels={extra.onOpenModels}
          />
        </CssVarsProvider>
      );
    });
  render({ modelId, sessionId: extra.sessionId });
  act(() => el('model-picker-btn').click());
  return { onSelect, reload, rerender: render };
}

/** The menu is a portal, so it lands on `document`, not under `host`. */
const el = (testId: string) => {
  const found = document.querySelector(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`no ${testId}`);
  return found as HTMLElement;
};
const options = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="model-picker-option"]'));
const filterBox = () => el('model-picker-filter') as HTMLInputElement;
const groupLabels = () =>
  Array.from(document.querySelectorAll('[data-testid="model-picker-group-label"]')).map(node => node.textContent);

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

/**
 * Replaces the whole query in one input event, as a paste delivers it. For tests about what a
 * query matches; `typeInto` stays for the ones about focus surviving each keystroke.
 */
function setQuery(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
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
    mount(numbered(12));
    const input = filterBox();

    // '1' narrows to three rows and '11' to one; Joy re-focuses its highlighted item on every
    // narrowing, and the box has to win each time.
    typeInto(input, '11');
    hover(options()[0]!);

    expect(input.value).toBe('11');
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

describe('ModelPicker switch cost', () => {
  it('prices every other priced model and says nothing for the current or an unpriced one', () => {
    mount(MODELS.slice(0, 3), undefined, model => (model.id === MODELS[2]!.id ? null : 1234));
    const costs = options().map(
      row => row.querySelector('[data-testid="model-picker-switch-cost"]')?.textContent ?? null
    );
    expect(costs).toEqual([null, '~1,234 cr', null]);
    expect(el('model-picker-switch-cost').title).toBe('About 1,234 credits to re-read this chat');
    expect(el('model-picker-switch-cost').getAttribute('aria-label')).toBe('About 1,234 credits to re-read this chat');
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

  it('orders this computer, each server, then hosted, and heads them whenever more than one is listed', () => {
    expect(groupByServer(grouped).map(group => [group.label, group.models.map(model => model.id)])).toEqual([
      ['This computer', ['local:ollama:qwen3:8b']],
      ['gpu box', ['local:srv-abc123:qwen3:8b']],
      ['lab', ['local:srv-def456:llama3']],
      ['Hosted', ['claude-sonnet']],
    ]);
    // No saved server contributes, and hosted and local are still told apart.
    expect(groupByServer(grouped.filter(model => !model.server)).map(group => group.label)).toEqual([
      'This computer',
      'Hosted',
    ]);
    expect(groupByServer(grouped.filter(model => model.id === 'claude-sonnet')).map(group => group.label)).toEqual([
      null,
    ]);
    expect(groupByServer([])).toEqual([]);
  });

  it("lists local groups first on a hosted conversation, and an unreachable server's models disabled", () => {
    const { onSelect } = mount(grouped, 'claude-sonnet');
    expect(groupLabels()).toEqual(['This computer', 'gpu box', 'lab', 'Hosted']);
    const down = options().find(option => option.dataset.unavailable === 'true')!;
    expect(down.textContent).toContain('lab is unreachable');
    expect(down.getAttribute('aria-disabled')).toBe('true');
    act(() => down.click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('warns about a down server for the current model, but not about one still listing', () => {
    const current = 'local:srv-def456:llama3';
    mount(grouped, current);
    expect(document.querySelector('[data-testid="model-picker-server-down"]')?.textContent).toContain(
      'lab is unreachable'
    );
    unmount();

    const listing = grouped.map(model =>
      model.id === current ? { ...model, unavailable: 'lab is still listing its models', pending: true } : model
    );
    const { onSelect } = mount(listing, current);
    expect(document.querySelector('[data-testid="model-picker-server-down"]')).toBeNull();
    const row = options().find(option => option.dataset.unavailable === 'true')!;
    expect(row.textContent).toContain('lab is still listing its models');
    act(() => row.click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('selects the first available match on Enter when a disabled row is listed above it', async () => {
    const { onSelect } = mount([
      { id: 'local:srv-def456:sonnet-local', name: 'Sonnet local', server: lab, unavailable: 'lab is unreachable' },
      { id: 'claude-sonnet', name: 'Sonnet hosted' },
      ...MODELS,
    ]);

    setQuery(filterBox(), 'sonnet');
    expect(options()[0]?.dataset.unavailable).toBe('true');
    await act(async () => key(filterBox(), 'Enter'));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('claude-sonnet');
  });

  it('selects nothing on Enter when only disabled rows match', async () => {
    const { onSelect } = mount([
      { id: 'local:srv-def456:llama3', name: 'llama3', server: lab, unavailable: 'lab is unreachable' },
      ...MODELS,
    ]);

    setQuery(filterBox(), 'llama3');
    await act(async () => key(filterBox(), 'Enter'));

    expect(options()).toHaveLength(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('filters unavailable rows by their visible reason, not the backend it replaces', () => {
    mount([
      ...grouped.map(model => (model.unavailable ? { ...model, backend: 'local-srv-def456' } : model)),
      ...MODELS,
    ]);

    setQuery(filterBox(), 'unreachable');
    expect(options()).toHaveLength(1);
    expect(options()[0]?.textContent?.toLowerCase()).toContain('unreachable');

    setQuery(filterBox(), 'local-srv-def456');
    expect(options()).toHaveLength(0);
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

  it('keeps a model listed under several providers together, each row naming its provider', () => {
    const twins: ChatModelOption[] = [
      { id: 'haiku', name: 'Claude Haiku 5.5', backend: 'anthropic', releaseDate: '2026-05-01' },
      { id: 'other', name: 'Other', backend: 'openai', releaseDate: '2026-05-01' },
      { id: 'bedrock-haiku', name: 'Claude Haiku 5.5', backend: 'bedrock', releaseDate: '2026-05-01' },
    ];
    expect(sortByRecency(twins).map(model => model.id)).toEqual(['haiku', 'bedrock-haiku', 'other']);
    expect(Object.fromEntries(rowDetails(twins))).toEqual({
      haiku: 'anthropic',
      other: 'openai',
      'bedrock-haiku': 'bedrock',
    });
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
    // A row with nothing to say renders no empty secondary line.
    expect(
      options()
        .find(option => option.textContent?.includes('Undated A'))
        ?.querySelector('[data-testid="model-picker-option-detail"]')
    ).toBeNull();
  });

  it('filters on what a row shows - the name and provider - not the hidden id', () => {
    mount([...dated, ...MODELS]);
    const rows = () => options().map(option => option.textContent?.replace('\u2022 ', ''));

    setQuery(filterBox(), 'undated a');
    expect(rows()).toEqual(['Undated A']);

    setQuery(filterBox(), 'anthropic');
    expect(rows()).toEqual(['New' + 'anthropic']);

    setQuery(filterBox(), 'vendor/');
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
      'local:srv-a:llama3': 'a',
      'local:srv-b:llama3': 'b',
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
    ).toEqual({ 'local:srv-v:qwen-small': 'gpu vllm', 'local:srv-v:sql-lora': 'gpu vllm - LoRA on qwen-small' });
  });

  it('says No tools on the row of a local model without tool support, and only there', () => {
    expect(
      Object.fromEntries(
        rowDetails([
          { id: 'local:ollama:gemma3:270m', name: 'gemma3:270m', backend: 'local-ollama', supportsTools: false },
          { id: 'local:ollama:qwen3:8b', name: 'qwen3:8b', backend: 'local-ollama', supportsTools: true },
          { id: 'local:ollama:fresh', name: 'fresh', backend: 'local-ollama' },
        ])
      )
    ).toEqual({
      'local:ollama:gemma3:270m': 'This computer - No tools',
      'local:ollama:qwen3:8b': 'This computer',
      'local:ollama:fresh': 'This computer',
    });
  });

  it('selects the primary row for a conversation saved on one of its served-name aliases', () => {
    const server = { id: 'v', name: 'gpu vllm' };
    mount(
      [
        { id: 'local:srv-v:qwen-small', name: 'qwen-small', server, aliasIds: ['local:srv-v:qwen'] },
        { id: 'local:srv-v:sql-lora', name: 'sql-lora', server, baseModel: 'qwen-small' },
      ],
      'local:srv-v:qwen'
    );
    expect(el('model-picker-btn').textContent).toBe('qwen-small');
    expect(document.querySelector('[data-testid="model-picker-unavailable"]')).toBeNull();
    const bullet = String.fromCharCode(0x2022);
    expect(options()[0].textContent?.startsWith(`${bullet} qwen-small`)).toBe(true);
    expect(options()[1].textContent?.startsWith(bullet)).toBe(false);
  });
});

describe('ModelPicker Bedrock route variants', () => {
  const fable: ChatModelOption[] = [
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', backend: 'anthropic', releaseDate: '2026-10-01' },
    { id: 'anthropic.claude-fable-5-1', name: 'Claude Fable 5.1', backend: 'bedrock', releaseDate: '2026-10-01' },
    { id: 'claude-fable-5', name: 'Claude Fable 5', backend: 'anthropic', releaseDate: '2026-06-01' },
    { id: 'anthropic.claude-fable-5', name: 'Claude Fable 5', backend: 'bedrock', releaseDate: '2026-06-01' },
    { id: 'global.anthropic.claude-fable-5', name: 'Claude Fable 5', backend: 'bedrock' },
    { id: 'global.anthropic.claude-fable-5-1', name: 'Claude Fable 5.1', backend: 'bedrock' },
  ];
  const credits = (model: ChatModelOption) =>
    model.backend === 'anthropic' ? 265 : model.id.startsWith('global.') ? 212 : 234;
  const bullet = String.fromCharCode(0x2022);
  const rows = () => options().map(option => option.textContent);

  it('shows one row per model and provider, newest first, priced for the variant it picks', () => {
    const { onSelect } = mount(fable, 'claude-fable-5-1', credits);

    expect(rows()).toEqual([
      `${bullet} Claude Fable 5.1anthropic`,
      'Claude Fable 5.1bedrock~212 cr',
      'Claude Fable 5anthropic~265 cr',
      'Claude Fable 5bedrock~212 cr',
    ]);
    act(() => options()[1]!.click());
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('global.anthropic.claude-fable-5-1');
  });

  it('keeps a conversation on a hidden variant selected on its own row, without switching it', () => {
    const { onSelect } = mount(fable, 'anthropic.claude-fable-5-1', credits);

    expect(el('model-picker-btn').textContent).toBe('Fable 5.1');
    expect(document.querySelector('[data-testid="model-picker-unavailable"]')).toBeNull();
    expect(rows()).toEqual([
      'Claude Fable 5.1anthropic~265 cr',
      `${bullet} Claude Fable 5.1bedrock`,
      'Claude Fable 5anthropic~265 cr',
      'Claude Fable 5bedrock~212 cr',
    ]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('narrows the merged rows by provider and query, and Enter picks the shown variant', async () => {
    const { onSelect } = mount([...fable, ...MODELS], 'claude-fable-5-1');

    act(() => el('model-picker-provider-bedrock').click());
    expect(rows()).toEqual(['Claude Fable 5.1bedrock', 'Claude Fable 5bedrock']);

    setQuery(filterBox(), 'fable 5.1');
    expect(rows()).toEqual(['Claude Fable 5.1bedrock']);
    await act(async () => key(filterBox(), 'Enter'));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('global.anthropic.claude-fable-5-1');
  });

  it('confirms the shown variant when a local conversation moves to a merged row', async () => {
    const qwen: ChatModelOption = { id: 'local:ollama:qwen3:8b', name: 'qwen3:8b' };
    const { onSelect } = mount([qwen, ...fable, ...MODELS], qwen.id, undefined, { hasHistory: true });

    setQuery(filterBox(), 'fable bedrock');
    await act(async () => key(filterBox(), 'Enter'));
    expect(onSelect).not.toHaveBeenCalled();
    expect(el('model-picker-hosted-dialog').textContent).toContain('Claude Fable 5.1 (bedrock)');

    act(() => el('model-picker-hosted-confirm-btn').click());
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('global.anthropic.claude-fable-5-1');
  });
});

// Which remembered filter survives which catalog, what each chip clears and what each query
// matches are decided by effectiveFilters, changeFilters and matchesQuery, covered case by case below.
describe('ModelPicker filters', () => {
  const gpu = { id: 'abc123', name: 'gpu box' };
  const mixed: ChatModelOption[] = [
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', backend: 'anthropic', releaseDate: '2026-05-01' },
    { id: 'gpt-6', name: 'GPT-6', backend: 'openai', releaseDate: '2026-06-01' },
    { id: 'bedrock-claude-haiku-5-5', name: 'Claude Haiku 5.5', backend: 'bedrock', releaseDate: '2026-05-01' },
    { id: 'local:ollama:qwen3:8b', name: 'qwen3:8b', backend: 'local-ollama' },
    { id: 'local:srv-abc123:llama3', name: 'llama3', server: gpu, backend: 'local-srv-abc123' },
    ...MODELS,
  ];
  const servers = [gpu, { id: 'mcsv', name: 'mcsv' }];
  const names = () => options().map(option => option.textContent?.replace(`${String.fromCharCode(0x2022)} `, ''));
  const click = (testId: string) => act(() => el(testId).click());

  it('narrows to local models, then to one server, and remembers the choice', () => {
    mount(mixed, 'gpt-6', undefined, { servers });

    // Each filter row is a labelled group, and each row marks where it runs.
    expect(
      Array.from(document.querySelectorAll('[data-testid="model-picker-filters"] [role="group"]')).map(node =>
        node.getAttribute('aria-label')
      )
    ).toEqual(['Location', 'Provider', 'Server']);
    const marks = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="model-picker-option-location"]'));
    expect(
      marks.filter(mark => mark.dataset.location === 'local').map(mark => mark.getAttribute('aria-label'))
    ).toEqual(['Runs on this computer', 'Runs on gpu box']);
    expect(marks.every(mark => mark.getAttribute('role') === 'img')).toBe(true);
    expect(marks.filter(mark => mark.dataset.location === 'hosted')).toHaveLength(mixed.length - 2);

    click('model-picker-location-local');
    expect(names()).toEqual(['qwen3:8bThis computer', 'llama3gpu box']);
    expect(document.querySelector('[data-testid="model-picker-provider-any"]')).toBeNull();

    click('model-picker-server-abc123');
    expect(names()).toEqual(['llama3gpu box']);

    unmount();
    mount(mixed, 'gpt-6', undefined, { servers });
    expect(names()).toEqual(['llama3gpu box']);
    expect(el('model-picker-server-abc123').getAttribute('aria-pressed')).toBe('true');
  });

  it('filters hosted models by provider, and keeps per-provider twins together', () => {
    mount(mixed, 'gpt-6', undefined, { servers });

    click('model-picker-location-hosted');
    expect(names().slice(0, 3)).toEqual(['GPT-6openai', 'Claude Haiku 5.5anthropic', 'Claude Haiku 5.5bedrock']);
    expect(document.querySelector('[data-testid="model-picker-server-any"]')).toBeNull();

    click('model-picker-provider-bedrock');
    expect(names()).toEqual(['Claude Haiku 5.5bedrock']);
  });

  it('says so when a saved server lists no chat models, and offers Clear filters only while one is set', () => {
    mount(mixed, 'gpt-6', undefined, { servers });
    click('model-picker-server-mcsv');
    expect(options()).toHaveLength(0);
    expect(el('model-picker-no-match').textContent).toBe('mcsv lists no chat models.');

    click('model-picker-clear-filters-btn');
    expect(options()).toHaveLength(mixed.length);
    expect(el('model-picker-location-all').getAttribute('aria-pressed')).toBe('true');

    setQuery(filterBox(), 'zzz');
    expect(el('model-picker-no-match').textContent).toBe('Nothing matches "zzz".');
    expect(document.querySelector('[data-testid="model-picker-clear-filters-btn"]')).toBeNull();
  });

  it('narrows on a typed query and clears it when the menu reopens', () => {
    mount(mixed, 'gpt-6', undefined, { servers });
    setQuery(filterBox(), 'local');
    expect(names()).toEqual(['qwen3:8bThis computer', 'llama3gpu box']);
    act(() => el('model-picker-btn').click());
    act(() => el('model-picker-btn').click());
    expect(options()).toHaveLength(mixed.length);
  });
});

// The decision of when to ask is needsHostedSwitchConfirm, covered case by case below.
describe('ModelPicker hosted switch warning', () => {
  const models: ChatModelOption[] = [
    { id: 'local:ollama:qwen3:8b', name: 'qwen3:8b' },
    { id: 'local:ollama:llama3', name: 'llama3' },
    { id: 'claude-sonnet', name: 'Claude Sonnet', backend: 'anthropic' },
  ];
  const row = (name: string) => options().find(option => option.textContent?.includes(name))!;
  const dialog = () => document.querySelector('[data-testid="model-picker-hosted-dialog"]');

  it('asks before a local conversation with messages moves to a hosted model', () => {
    const { onSelect } = mount(models, 'local:ollama:qwen3:8b', undefined, { hasHistory: true });
    expect(el('model-picker-group-label').textContent).toBe('This computer');
    expect(document.body.textContent).toContain('Hosted - sends this conversation to Bike4Mind');

    act(() => row('Claude Sonnet').click());
    expect(onSelect).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain('this computer');
    expect(dialog()?.textContent).toContain('Claude Sonnet (anthropic)');

    act(() => el('model-picker-hosted-confirm-btn').click());
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('claude-sonnet');
    expect(dialog()).toBeNull();
  });

  it('drops the question when the conversation or its model changes', () => {
    const { onSelect, rerender } = mount(models, 'local:ollama:qwen3:8b', undefined, {
      hasHistory: true,
      sessionId: 'a',
    });
    act(() => row('Claude Sonnet').click());
    expect(dialog()).not.toBeNull();

    rerender({ modelId: 'local:ollama:qwen3:8b', sessionId: 'b' });
    expect(dialog()).toBeNull();
    rerender({ modelId: 'local:ollama:qwen3:8b', sessionId: 'a' });
    expect(dialog()).toBeNull();

    act(() => el('model-picker-btn').click());
    act(() => row('Claude Sonnet').click());
    expect(dialog()).not.toBeNull();
    rerender({ modelId: 'local:ollama:llama3', sessionId: 'a' });
    expect(dialog()).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('names a saved server from the model id, stays local on cancel, and moves between local models unasked', () => {
    const { onSelect } = mount(models, 'local:srv-abc123:gone', undefined, {
      hasHistory: true,
      servers: [{ id: 'abc123', name: 'gpu box' }],
    });
    act(() => row('Claude Sonnet').click());
    expect(dialog()?.textContent).toContain('This conversation is on gpu box.');

    act(() => el('model-picker-hosted-cancel-btn').click());
    expect(onSelect).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();

    act(() => el('model-picker-btn').click());
    act(() => row('llama3').click());
    expect(dialog()).toBeNull();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('local:ollama:llama3');
  });
});

describe('ModelPicker with no local model', () => {
  const qwen: ChatModelOption = { id: localModelId('ollama', 'qwen2.5:0.5b'), name: 'qwen2.5:0.5b' };
  const stopped: NoLocalModels = { reason: OLLAMA_NOT_RUNNING, fix: 'start-ollama' };
  const signedOut = (noLocal?: NoLocalModels, onOpenModels = vi.fn()) => ({
    error: 'Sign in to see models.',
    local: true,
    noLocal,
    onOpenModels,
  });

  it('names the empty state as a menu item that rechecks Ollama, not the saved hosted model or a sign-in error', () => {
    const { reload } = mount([], 'claude-opus-5', undefined, signedOut(stopped));
    expect(el('model-picker-btn').textContent).toBe('No local model');
    expect(el('model-picker-no-local').textContent).toBe(OLLAMA_NOT_RUNNING);
    expect(document.body.textContent).not.toContain('claude-opus-5');
    expect(document.body.textContent).not.toContain('Sign in');
    expect(document.querySelector('[data-testid="model-picker-open-models-item"]')).toBeNull();

    expect(el('model-picker-no-local').getAttribute('role')).toBe('menuitem');
    act(() => el('model-picker-no-local').click());
    expect(reload).toHaveBeenCalledOnce();
  });

  it('offers the Models screen when Ollama runs with no models', () => {
    const onOpenModels = vi.fn();
    mount(
      [],
      'claude-opus-5',
      undefined,
      signedOut({ reason: 'Ollama is running but has no models that can chat.', fix: 'open-models' }, onOpenModels)
    );
    act(() => el('model-picker-open-models-item').click());
    expect(onOpenModels).toHaveBeenCalledOnce();
  });

  it('keeps the model label while models are listed but Ollama stopped', () => {
    mount([qwen], qwen.id, undefined, signedOut(stopped));
    expect(el('model-picker-btn').textContent).toBe('qwen2.5:0.5b');
    expect(el('model-picker-no-local').textContent).toBe(OLLAMA_NOT_RUNNING);
  });

  it('shows a transitional label, not a raw id, for a hosted or placeholder model before main moves it', () => {
    mount([qwen], NO_LOCAL_MODEL, undefined, signedOut());
    expect(el('model-picker-btn').textContent).toBe('Selecting model...');
    expect(document.querySelector('[data-testid="model-picker-unavailable"]')).toBeNull();
  });

  it('says a removed local model is not installed on this device, not missing from a server', () => {
    mount([qwen], localModelId('ollama', 'gone'), undefined, signedOut());
    expect(el('model-picker-unavailable').textContent).toContain('not installed on this device');
  });
});

const gpu = { id: 'abc123', name: 'gpu box' };
const haiku: ChatModelOption = { id: 'claude-haiku', name: 'Claude Haiku 5.5', backend: 'anthropic' };
const bedrockHaiku: ChatModelOption = { id: 'bedrock-haiku', name: 'Claude Haiku 5.5', backend: 'bedrock' };
const qwen: ChatModelOption = { id: 'local:ollama:qwen3:8b', name: 'qwen3:8b', backend: 'local-ollama' };
const llama: ChatModelOption = {
  id: 'local:srv-abc123:llama3',
  name: 'llama3',
  backend: 'local-srv-abc123',
  server: gpu,
};
const models = [haiku, bedrockHaiku, qwen, llama];

afterEach(() => window.localStorage.clear());

describe('filterOptions', () => {
  it('lists hosted providers and every server, this computer first, saved ones even without chat models', () => {
    expect(filterOptions(models, [{ id: 'mcsv', name: 'mcsv' }, gpu])).toEqual({
      providers: ['anthropic', 'bedrock'],
      servers: [{ id: LOCAL_SERVER_ID, name: 'This computer' }, { id: 'mcsv', name: 'mcsv' }, gpu],
      hasHosted: true,
      hasLocal: true,
    });
  });

  it('never offers a local runtime as a provider', () => {
    expect(filterOptions([qwen, llama]).providers).toEqual([]);
  });
});

describe('matchesFilters', () => {
  const pick = (filters: Partial<typeof NO_FILTERS>) =>
    models.filter(model => matchesFilters(model, { ...NO_FILTERS, ...filters })).map(model => model.id);

  it('narrows by location, provider and server', () => {
    expect(pick({})).toEqual(models.map(model => model.id));
    expect(pick({ location: 'hosted' })).toEqual(['claude-haiku', 'bedrock-haiku']);
    expect(pick({ location: 'local' })).toEqual([qwen.id, llama.id]);
    expect(pick({ provider: 'bedrock' })).toEqual(['bedrock-haiku']);
    expect(pick({ server: LOCAL_SERVER_ID })).toEqual([qwen.id]);
    expect(pick({ server: 'abc123' })).toEqual([llama.id]);
  });
});

describe('changeFilters', () => {
  it('clears the side a choice rules out', () => {
    expect(changeFilters({ ...NO_FILTERS, server: 'abc123' }, { provider: 'anthropic' })).toEqual({
      location: 'all',
      provider: 'anthropic',
      server: null,
    });
    expect(changeFilters({ ...NO_FILTERS, provider: 'anthropic' }, { location: 'local' })).toEqual({
      location: 'local',
      provider: null,
      server: null,
    });
    expect(changeFilters({ ...NO_FILTERS, server: 'abc123' }, { location: 'hosted' }).server).toBeNull();
  });

  it('clears the provider and server when All is picked', () => {
    expect(changeFilters({ location: 'all', provider: 'anthropic', server: null }, { location: 'all' })).toEqual(
      NO_FILTERS
    );
    expect(changeFilters({ location: 'local', provider: null, server: 'abc123' }, { location: 'all' })).toEqual(
      NO_FILTERS
    );
  });
});

describe('effectiveFilters', () => {
  it('drops a provider or server this list no longer offers', () => {
    const options = filterOptions(models);
    expect(effectiveFilters({ location: 'all', provider: 'gone', server: null }, options).provider).toBeNull();
    expect(effectiveFilters({ location: 'local', provider: null, server: 'gone' }, options)).toEqual({
      location: 'local',
      provider: null,
      server: null,
    });
    expect(effectiveFilters({ location: 'all', provider: 'bedrock', server: null }, options).provider).toBe('bedrock');
  });

  it('never applies a filter whose control is not drawn', () => {
    // Signed out: no hosted models, so no location row.
    expect(
      effectiveFilters({ location: 'hosted', provider: 'anthropic', server: null }, filterOptions([qwen, llama]))
    ).toEqual(NO_FILTERS);
    // Ollama stopped and no saved server: no local side, no location row.
    expect(
      effectiveFilters({ location: 'local', provider: null, server: null }, filterOptions([haiku, bedrockHaiku]))
    ).toEqual(NO_FILTERS);
    // Only one server left.
    expect(
      effectiveFilters({ location: 'all', provider: null, server: LOCAL_SERVER_ID }, filterOptions([haiku, qwen]))
    ).toEqual(NO_FILTERS);
    // Only one provider left.
    expect(
      effectiveFilters({ location: 'all', provider: 'anthropic', server: null }, filterOptions([haiku, qwen]))
    ).toEqual(NO_FILTERS);
  });

  it('drops Local when the location row is drawn only for a saved server with no chat models', () => {
    const options = filterOptions([haiku, bedrockHaiku], [{ id: 'mcsv', name: 'mcsv' }]);
    expect(effectiveFilters({ location: 'local', provider: null, server: null }, options)).toEqual(NO_FILTERS);
    expect(effectiveFilters({ location: 'all', provider: null, server: 'mcsv' }, options).server).toBe('mcsv');
  });

  it('applies nothing to an empty list', () => {
    expect(effectiveFilters({ location: 'local', provider: null, server: 'abc123' }, filterOptions([]))).toEqual(
      NO_FILTERS
    );
  });
});

describe('matchesQuery', () => {
  it.each([
    [haiku, 'haiku', true],
    [haiku, 'anthropic', true],
    [haiku, 'hosted', true],
    [haiku, 'local', false],
    [haiku, 'haiku bed', false],
    [bedrockHaiku, 'haiku bed', true],
    [qwen, 'local', true],
    [qwen, 'this computer', true],
    [qwen, 'hosted', false],
    [llama, 'gpu', true],
    [llama, 'llama gpu', true],
    [llama, 'srv-abc', false],
    [haiku, 'claude-haiku', false],
  ])('%#: %o matches %s: %s', (model, query, expected) => {
    expect(matchesQuery(model, query)).toBe(expected);
  });

  it('matches the visible detail as a phrase', () => {
    expect(matchesQuery(haiku, '2025-04', 'anthropic - claude-haiku-2025-04')).toBe(true);
  });
});

describe('needsHostedSwitchConfirm', () => {
  it('asks only when a local conversation with messages moves to a hosted model', () => {
    expect(needsHostedSwitchConfirm(qwen.id, haiku, true)).toBe(true);
    expect(needsHostedSwitchConfirm(llama.id, haiku, true)).toBe(true);
    expect(needsHostedSwitchConfirm(qwen.id, haiku, false)).toBe(false);
    expect(needsHostedSwitchConfirm(qwen.id, llama, true)).toBe(false);
    expect(needsHostedSwitchConfirm(haiku.id, bedrockHaiku, true)).toBe(false);
    expect(needsHostedSwitchConfirm(null, haiku, true)).toBe(false);
    expect(needsHostedSwitchConfirm('local:', haiku, true)).toBe(false);
  });
});

describe('stored filters', () => {
  it('round-trips and survives junk', () => {
    expect(readModelPickerFilters()).toEqual(NO_FILTERS);
    writeModelPickerFilters({ location: 'local', provider: null, server: 'abc123' });
    expect(readModelPickerFilters()).toEqual({ location: 'local', provider: null, server: 'abc123' });

    window.localStorage.setItem('b4m.modelPicker.filters', '{not json');
    expect(readModelPickerFilters()).toEqual(NO_FILTERS);
    window.localStorage.setItem('b4m.modelPicker.filters', JSON.stringify({ location: 'cloud', provider: 7 }));
    expect(readModelPickerFilters()).toEqual(NO_FILTERS);
  });
});

/** The order the server listed them in, with the dates only some routes carry. */
const FABLE: ChatModelOption[] = [
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', backend: 'anthropic', releaseDate: '2026-10-01' },
  { id: 'anthropic.claude-fable-5-1', name: 'Claude Fable 5.1', backend: 'bedrock', releaseDate: '2026-10-01' },
  { id: 'claude-fable-5', name: 'Claude Fable 5', backend: 'anthropic', releaseDate: '2026-06-01' },
  { id: 'anthropic.claude-fable-5', name: 'Claude Fable 5', backend: 'bedrock', releaseDate: '2026-06-01' },
  { id: 'global.anthropic.claude-fable-5', name: 'Claude Fable 5', backend: 'bedrock' },
  { id: 'global.anthropic.claude-fable-5-1', name: 'Claude Fable 5.1', backend: 'bedrock' },
];

const ids = (models: readonly ChatModelOption[]) => models.map(model => model.id);

describe('routeVariantKey', () => {
  it('joins a Bedrock foundation id with its inference profiles, and nothing else', () => {
    expect(routeVariantKey({ id: 'anthropic.claude-fable-5', backend: 'bedrock' })).toBe(
      routeVariantKey({ id: 'global.anthropic.claude-fable-5', backend: 'bedrock' })
    );
    expect(routeVariantKey({ id: 'us.anthropic.claude-fable-5', backend: 'bedrock' })).toBe(
      routeVariantKey({ id: 'apac.anthropic.claude-fable-5', backend: 'bedrock' })
    );
    expect(routeVariantKey({ id: 'anthropic.claude-fable-5', backend: 'bedrock' })).not.toBe(
      routeVariantKey({ id: 'anthropic.claude-fable-5-1', backend: 'bedrock' })
    );
    expect(routeVariantKey({ id: 'Global.Anthropic.Claude-Fable-5', backend: 'bedrock' })).toBe(
      routeVariantKey({ id: 'anthropic.claude-fable-5', backend: 'bedrock' })
    );
    expect(routeVariantKey({ id: 'global.claude-x', backend: 'anthropic' })).not.toBe(
      routeVariantKey({ id: 'claude-x', backend: 'anthropic' })
    );
  });

  it('keys real versioned Bedrock ids by their version suffix, across every geography', () => {
    const key = (id: string) => routeVariantKey({ id, backend: 'bedrock' });
    const foundation = key('anthropic.claude-3-5-sonnet-20241022-v2:0');
    expect(key('us.anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe(foundation);
    expect(key('us-gov.anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe(foundation);
    expect(key('anthropic.claude-3-5-sonnet-20241022-v1:0')).not.toBe(foundation);
  });
});

describe('mergeRouteVariants', () => {
  it('lists each model once per provider, preferring the global profile, in incoming order', () => {
    expect(ids(mergeRouteVariants(FABLE, null))).toEqual([
      'claude-fable-5-1',
      'claude-fable-5',
      'global.anthropic.claude-fable-5',
      'global.anthropic.claude-fable-5-1',
    ]);
  });

  it("keeps the conversation's own variant as its model's row, even a hidden one", () => {
    expect(ids(mergeRouteVariants(FABLE, 'anthropic.claude-fable-5-1'))).toEqual([
      'claude-fable-5-1',
      'anthropic.claude-fable-5-1',
      'claude-fable-5',
      'global.anthropic.claude-fable-5',
    ]);
  });

  it('prefers an enabled variant over a disabled or unavailable one', () => {
    const disabledGlobal = FABLE.map(model => (model.id.startsWith('global.') ? { ...model, disabled: true } : model));
    expect(ids(mergeRouteVariants(disabledGlobal, null))).toEqual([
      'claude-fable-5-1',
      'anthropic.claude-fable-5-1',
      'claude-fable-5',
      'anthropic.claude-fable-5',
    ]);
    const unavailableGlobal = FABLE.map(model =>
      model.id.startsWith('global.') ? { ...model, unavailable: 'not now' } : model
    );
    expect(ids(mergeRouteVariants(unavailableGlobal, null))).toEqual(ids(mergeRouteVariants(disabledGlobal, null)));
  });

  it('ranks global, then a geography, then the bare id, then the lower id, whatever the input order', () => {
    const variant = (id: string): ChatModelOption => ({ id, name: 'Claude Opus 5', backend: 'bedrock' });
    const all = ['anthropic.claude-opus-5', 'us.anthropic.claude-opus-5', 'eu.anthropic.claude-opus-5'].map(variant);
    expect(ids(mergeRouteVariants(all, null))).toEqual(['eu.anthropic.claude-opus-5']);
    expect(ids(mergeRouteVariants([...all].reverse(), null))).toEqual(['eu.anthropic.claude-opus-5']);
    expect(ids(mergeRouteVariants([...all, variant('global.anthropic.claude-opus-5')], null))).toEqual([
      'global.anthropic.claude-opus-5',
    ]);
    expect(ids(mergeRouteVariants([variant('anthropic.claude-opus-5')], null))).toEqual(['anthropic.claude-opus-5']);
    expect(
      ids(mergeRouteVariants([variant('anthropic.claude-opus-5'), variant('GLOBAL.anthropic.claude-opus-5')], null))
    ).toEqual(['GLOBAL.anthropic.claude-opus-5']);
  });

  it('leaves other providers, snapshots and local models as they are', () => {
    const others: ChatModelOption[] = [
      { id: 'gpt-4.1-2025-04-14', name: 'GPT-4.1', backend: 'openai' },
      { id: 'gpt-4.1', name: 'GPT-4.1', backend: 'openai' },
      { id: 'local:ollama:us.qwen', name: 'us.qwen', backend: 'local-ollama' },
      { id: 'local:ollama:qwen', name: 'qwen', backend: 'local-ollama' },
    ];
    expect(mergeRouteVariants(others, null)).toEqual(others);
  });
});

describe('merged rows', () => {
  const rows = mergeRouteVariants(FABLE, null);

  it('order newest model first, its providers together, though only one route carries a date', () => {
    expect(ids(sortByRecency(rows))).toEqual([
      'claude-fable-5-1',
      'global.anthropic.claude-fable-5-1',
      'claude-fable-5',
      'global.anthropic.claude-fable-5',
    ]);
  });

  it('answer the provider filter and a typed query like any other row', () => {
    expect(ids(rows.filter(model => matchesFilters(model, { ...NO_FILTERS, provider: 'bedrock' })))).toEqual([
      'global.anthropic.claude-fable-5',
      'global.anthropic.claude-fable-5-1',
    ]);
    expect(ids(rows.filter(model => matchesQuery(model, 'fable 5.1', model.backend)))).toEqual([
      'claude-fable-5-1',
      'global.anthropic.claude-fable-5-1',
    ]);
    expect(ids(rows.filter(model => matchesQuery(model, 'fable bedrock', model.backend)))).toEqual([
      'global.anthropic.claude-fable-5',
      'global.anthropic.claude-fable-5-1',
    ]);
    expect(ids(rows.filter(model => matchesQuery(model, 'fable', model.backend)))).toHaveLength(4);
  });
});
