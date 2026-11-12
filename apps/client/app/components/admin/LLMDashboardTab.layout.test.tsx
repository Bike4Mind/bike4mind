import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ModelBackend, type LLMModelConfig } from '@bike4mind/common';

type BlockerOptions = {
  enableBeforeUnload: boolean;
  shouldBlockFn(args: {
    current: { pathname: string; search: object };
    next: { pathname: string; search: object };
  }): boolean;
};

const h = vi.hoisted(() => ({
  saveMutate: vi.fn(),
  configError: null as Error | null,
  refetchConfigs: vi.fn(),
  refetch: vi.fn(),
  onSaved: undefined as (() => void) | undefined,
  emptyStateTitles: [] as string[],
  useBlocker: vi.fn((_options: BlockerOptions) => ({ status: 'idle' })),
  modelInfo: {
    data: undefined as LLMModelConfig[] | undefined,
    isPending: false,
    isLoading: false,
    isFetching: false,
    error: null as Error | null,
  },
}));

vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ ...h.modelInfo, refetch: h.refetch }),
}));

vi.mock('@client/app/hooks/data/llmModelConfig', () => ({
  // Same contract as the real hook: without a pending flag it infers loading from missing data.
  useLLMModelConfigurationsWithDefaults: (infos?: LLMModelConfig[], pending = !infos) => ({
    data: h.configError ? [] : (infos ?? []).map(model => ({ ...model, accessEntry: null })),
    error: h.configError,
    refetch: h.refetchConfigs,
    isLoading: pending,
  }),
  useSaveLLMModelConfigurations: (onSuccess?: (result: import('@bike4mind/common').ModelAccessSaveResult) => void) => {
    h.onSaved = () => onSuccess?.({ entries: [], changed: 0, revision: null });
    return { mutateAsync: h.saveMutate, isPending: false };
  },
}));

vi.mock('@client/app/hooks/data/user', () => ({
  useGetUsers: () => ({ data: { users: [{ tags: ['Beta'] }] }, isLoading: false }),
}));

vi.mock('@bike4mind/server-utils/lib/entitlements/registry', () => ({ KNOWN_ENTITLEMENT_KEYS: ['pro:plan'] }));

vi.mock('@client/app/components/help/ContextHelpButton', () => ({
  default: ({ helpId }: { helpId: string }) => <button type="button" data-testid={`help-${helpId}`} />,
}));

// Records every EmptyState the tab renders, including one that only lives for a frame.
vi.mock('./shared', async importOriginal => {
  const actual = await importOriginal<typeof import('./shared')>();
  return {
    ...actual,
    EmptyState: (props: React.ComponentProps<typeof actual.EmptyState>) => {
      h.emptyStateTitles.push(props.title);
      return <actual.EmptyState {...props} />;
    },
  };
});

vi.mock('@tanstack/react-router', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useBlocker: h.useBlocker,
  // The store-first tab guard is covered with a real router in LLMDashboardTab.navigation.test.tsx.
  useRouter: () => null,
}));

import LLMDashboardTab from './LLMDashboardTab';

// Fixture ids are not catalog ids, so `id` is taken as a plain string.
const makeModel = (id: string, over: Partial<LLMModelConfig>): LLMModelConfig =>
  ({
    type: 'text',
    backend: ModelBackend.OpenAI,
    contextWindow: 128000,
    max_tokens: 4096,
    enabled: true,
    allowedUserTags: [],
    allowedEntitlements: [],
    supportsImageVariation: false,
    pricing: {},
    ...over,
    id,
  }) as LLMModelConfig;

const models: LLMModelConfig[] = [
  makeModel('gpt-5', { name: 'GPT-5', allowedEntitlements: ['base'] }),
  makeModel('claude-opus', { name: 'Claude Opus', backend: ModelBackend.Anthropic }),
  makeModel('dall-e', { name: 'DALL-E', type: 'image' }),
  makeModel('flux-pro', { name: 'Flux Pro', backend: ModelBackend.BFL, type: 'image', enabled: false }),
  makeModel('whisper', { name: 'Whisper', type: 'speech-to-text' }),
];

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <LLMDashboardTab />
    </CssVarsProvider>
  );

const inputIn = (testId: string) => {
  const input = screen.getByTestId(testId).querySelector('input');
  if (!input) throw new Error(`No <input> found inside "${testId}"`);
  return input;
};

const visibleModelIds = () =>
  screen
    .queryAllByTestId(/^llm-dashboard-row-/)
    .map(node => node.getAttribute('data-testid')?.replace('llm-dashboard-row-', ''));

const pickFilter = (id: string, value: string) => {
  fireEvent.click(screen.getByTestId(`admin-filter-${id}`));
  fireEvent.click(screen.getByTestId(`admin-filter-${id}-${value}`));
};

const search = (value: string) => {
  fireEvent.change(screen.getByTestId('llm-dashboard-search-input'), { target: { value } });
  act(() => void vi.advanceTimersByTime(500));
};

const saveBarText = () => screen.queryByTestId('admin-save-bar')?.textContent ?? null;
const lastBlocker = () => h.useBlocker.mock.lastCall?.[0];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.onSaved = undefined;
  h.configError = null;
  h.emptyStateTitles = [];
  h.modelInfo = { data: models, isPending: false, isLoading: false, isFetching: false, error: null };
});
afterEach(() => vi.useRealTimers());

describe('LLMDashboardTab page frame', () => {
  it('opens with the Models page header, then a neutral access banner, and no raw cards', () => {
    const { container } = renderTab();
    const root = screen.getByTestId('llm-dashboard-root');
    const header = screen.getByTestId('admin-page-header');

    expect(root.firstElementChild).toBe(header);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(/^Models$/);
    expect(header).toHaveTextContent('Turn models on or off');
    expect(within(header).getByTestId('help-admin/llm-dashboard')).toBeInTheDocument();

    const banner = screen.getByTestId('llm-dashboard-access-banner');
    expect(root.children[1]).toBe(banner);
    expect(banner).toHaveTextContent('Model access control:');
    expect(banner).toHaveClass('MuiAlert-colorNeutral');
    expect(container.querySelector('.MuiCard-root')).toBeNull();
  });

  it('shows the four counts in one stat strip that follows the edits', () => {
    renderTab();
    const tiles = () =>
      within(screen.getByTestId('admin-stat-strip'))
        .getAllByTestId('admin-stat-tile')
        .map(tile => tile.textContent);

    expect(tiles()).toEqual(['Enabled3', 'Disabled1', 'Text models2', 'Image models1']);

    fireEvent.click(inputIn('llm-dashboard-toggle-flux-pro'));
    expect(tiles()).toEqual(['Enabled4', 'Disabled0', 'Text models2', 'Image models2']);
  });

  it('puts the models in a DataTable as wide as its columns, scrolling inside its own frame', () => {
    renderTab();
    const table = screen.getByTestId('llm-dashboard-table');
    const headers = within(table).getAllByRole('columnheader');

    expect(headers.map(th => th.textContent)).toEqual(
      expect.arrayContaining(['Model', 'Developer users', 'Customer users', 'Beta users', 'base', 'pro:plan'])
    );
    // minWidth covers every column, the checkbox column DataTable adds included, so none is squeezed.
    const widths = headers.map(th => th.style.width);
    expect(widths.every(width => width.endsWith('rem'))).toBe(true);
    const totalRem = widths.reduce((sum, width) => sum + parseFloat(width), 0);
    expect(table).toHaveStyle({ minWidth: `${totalRem}rem` });
    // A header label never wraps, so an access column is sized from it: 15 characters at half a rem, plus padding.
    expect(headers.find(th => th.textContent === 'Developer users')).toHaveStyle({ width: '9rem' });
    expect(table.closest('[role="region"]')).toHaveStyle({ overflowX: 'auto' });
    expect(screen.getByTestId('llm-dashboard-root')).toHaveStyle({ minWidth: '0' });
    // Type and backend are categories, so they read as plain text rather than colored chips.
    expect(screen.getByTestId('llm-dashboard-row-claude-opus').querySelector('.MuiChip-root')).toBeNull();
    expect(screen.getByTestId('llm-dashboard-row-claude-opus')).toHaveTextContent('anthropic');
  });

  it('filters with chips and offers to clear filters that match nothing', () => {
    renderTab();
    expect(visibleModelIds()).toEqual(['gpt-5', 'claude-opus', 'dall-e', 'flux-pro']);

    pickFilter('type', 'image');
    expect(visibleModelIds()).toEqual(['dall-e', 'flux-pro']);

    pickFilter('backend', 'bfl');
    expect(visibleModelIds()).toEqual(['flux-pro']);

    search('nothing-matches');
    const empty = screen.getByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No models match these filters');

    fireEvent.click(within(empty).getByTestId('llm-dashboard-clear-filters-btn'));
    expect(visibleModelIds()).toEqual(['gpt-5', 'claude-opus', 'dall-e', 'flux-pro']);
    expect(screen.getByTestId('llm-dashboard-search-input')).toHaveValue('');
    expect(screen.getByTestId('admin-filter-type')).toHaveTextContent(/^Type$/);
  });
});

describe('LLMDashboardTab pager and selection', () => {
  const many = Array.from({ length: 30 }, (_, index) =>
    makeModel(`model-${String(index + 1).padStart(2, '0')}`, { name: `Model ${index + 1}` })
  );

  it('pages 25 rows at a time in the table footer and returns to page one when a filter changes', () => {
    h.modelInfo.data = many;
    renderTab();

    expect(visibleModelIds()).toHaveLength(25);
    expect(screen.getByTestId('admin-table-range')).toHaveTextContent('1 to 25 of 30');

    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(visibleModelIds()).toEqual(['model-26', 'model-27', 'model-28', 'model-29', 'model-30']);

    search('model');
    expect(screen.getByTestId('admin-table-range')).toHaveTextContent('1 to 25 of 30');
  });

  it('selects the page from the header, then every matching model from the bulk bar', () => {
    h.modelInfo.data = many;
    renderTab();

    fireEvent.click(inputIn('admin-table-select-page'));
    const bar = screen.getByTestId('llm-dashboard-bulk-bar');
    expect(bar).toHaveTextContent('25 selected');

    fireEvent.click(within(bar).getByTestId('admin-select-all-matching-btn'));
    expect(screen.getByTestId('llm-dashboard-bulk-bar')).toHaveTextContent('30 selected');

    fireEvent.click(screen.getByTestId('llm-dashboard-bulk-disable-btn'));
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    fireEvent.click(screen.getByTestId('llm-dashboard-save-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('llm-dashboard-save-dialog-confirm-btn'));
    const saved = h.saveMutate.mock.calls[0][0] as import('@bike4mind/common').ModelAccessSaveRequest;
    expect(saved.changes).toHaveLength(30);
    expect(saved.changes.every(model => model.change.enabled === false)).toBe(true);
  });

  it('adds every matching model to a selection made under another filter', () => {
    h.modelInfo.data = many;
    renderTab();

    fireEvent.click(inputIn('admin-table-select-model-01'));
    search('model 2');
    expect(visibleModelIds()).toHaveLength(11);
    expect(screen.getByTestId('llm-dashboard-bulk-count')).toHaveTextContent(
      '0 of 1 selected models match this filter'
    );

    fireEvent.click(screen.getByTestId('admin-select-all-matching-btn'));
    expect(screen.getByTestId('llm-dashboard-bulk-bar')).toHaveTextContent('12 selected');
    expect(screen.getByTestId('llm-dashboard-bulk-count')).toHaveTextContent(
      '11 of 12 selected models match this filter'
    );
  });
});

describe('LLMDashboardTab save bar', () => {
  it('counts changed models, so a value toggled back is not a change', () => {
    renderTab();
    expect(saveBarText()).toBeNull();

    fireEvent.click(inputIn('llm-dashboard-toggle-gpt-5'));
    expect(saveBarText()).toContain('1 unsaved change');

    fireEvent.click(inputIn('llm-dashboard-tag-claude-opus-developer'));
    fireEvent.click(inputIn('llm-dashboard-tag-claude-opus-customer'));
    expect(saveBarText()).toContain('2 unsaved changes');

    fireEvent.click(inputIn('llm-dashboard-toggle-gpt-5'));
    expect(saveBarText()).toContain('1 unsaved change');
  });

  it('discards back to the loaded configuration without a request', () => {
    renderTab();
    fireEvent.click(inputIn('llm-dashboard-toggle-gpt-5'));
    fireEvent.click(inputIn('llm-dashboard-tag-claude-opus-developer'));
    fireEvent.click(inputIn('llm-dashboard-entitlement-gpt-5-base'));
    fireEvent.click(inputIn('admin-table-select-dall-e'));
    fireEvent.click(screen.getByTestId('llm-dashboard-bulk-disable-btn'));
    expect(screen.getByTestId('llm-dashboard-bulk-notice')).toHaveTextContent('Disabled 1 model.');

    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));

    expect(saveBarText()).toBeNull();
    expect(inputIn('llm-dashboard-toggle-gpt-5')).toBeChecked();
    expect(inputIn('llm-dashboard-toggle-dall-e')).toBeChecked();
    expect(inputIn('llm-dashboard-tag-claude-opus-developer')).not.toBeChecked();
    expect(inputIn('llm-dashboard-entitlement-gpt-5-base')).toBeChecked();
    // The receipt for a discarded bulk change would describe models that are back as they were.
    expect(screen.queryByTestId('llm-dashboard-bulk-notice')).toBeNull();
    expect(h.saveMutate).not.toHaveBeenCalled();
  });

  it('saves every model with the tag and entitlement edits in one request, then measures from the save', () => {
    renderTab();
    fireEvent.click(inputIn('llm-dashboard-toggle-flux-pro'));
    fireEvent.click(inputIn('llm-dashboard-tag-gpt-5-developer'));
    fireEvent.click(inputIn('llm-dashboard-tag-claude-opus-beta'));
    fireEvent.click(inputIn('llm-dashboard-entitlement-gpt-5-base'));
    fireEvent.click(inputIn('llm-dashboard-entitlement-claude-opus-pro:plan'));

    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    fireEvent.click(screen.getByTestId('llm-dashboard-save-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('llm-dashboard-save-dialog-confirm-btn'));

    expect(h.saveMutate).toHaveBeenCalledTimes(1);
    const saved = h.saveMutate.mock.calls[0][0] as import('@bike4mind/common').ModelAccessSaveRequest;
    expect(saved.reason).toBe('Update model availability');
    expect(
      saved.changes.map(model => [
        model.id,
        model.change.enabled,
        model.change.allowedUserTags,
        model.change.allowedEntitlements,
      ])
    ).toEqual([
      ['gpt-5', true, ['developer'], []],
      ['claude-opus', true, ['beta'], ['pro:plan']],
      ['flux-pro', true, [], []],
    ]);

    act(() => h.onSaved?.());
    expect(saveBarText()).toBeNull();

    fireEvent.click(inputIn('llm-dashboard-toggle-flux-pro'));
    expect(saveBarText()).toContain('1 unsaved change');
  });

  it('discards back to the last saved copy once a save succeeds, not to the first load', () => {
    renderTab();
    fireEvent.click(inputIn('llm-dashboard-toggle-flux-pro'));
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    fireEvent.click(screen.getByTestId('llm-dashboard-save-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('llm-dashboard-save-dialog-confirm-btn'));
    act(() => h.onSaved?.());

    fireEvent.click(inputIn('llm-dashboard-toggle-flux-pro'));
    expect(saveBarText()).toContain('1 unsaved change');
    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));

    expect(saveBarText()).toBeNull();
    expect(inputIn('llm-dashboard-toggle-flux-pro')).toBeChecked();
  });

  it('keeps an edit made while the save is in flight as unsaved', () => {
    renderTab();
    fireEvent.click(inputIn('llm-dashboard-toggle-gpt-5'));
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    fireEvent.click(screen.getByTestId('llm-dashboard-save-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('llm-dashboard-save-dialog-confirm-btn'));
    fireEvent.click(inputIn('llm-dashboard-toggle-claude-opus'));
    act(() => h.onSaved?.());

    const sent = h.saveMutate.mock.calls[0][0] as import('@bike4mind/common').ModelAccessSaveRequest;
    expect(sent.changes.some(model => model.id === 'claude-opus')).toBe(false);
    expect(saveBarText()).toContain('1 unsaved change');
    expect(inputIn('llm-dashboard-toggle-claude-opus')).not.toBeChecked();
  });

  it('guards leaving the tab only while there are unsaved changes', () => {
    renderTab();
    const admin = (tab: string) => ({ pathname: '/admin', search: { tab } });
    expect(lastBlocker()?.enableBeforeUnload).toBe(false);
    expect(lastBlocker()?.shouldBlockFn({ current: admin('llm-dashboard'), next: admin('users') })).toBe(false);

    fireEvent.click(inputIn('llm-dashboard-toggle-gpt-5'));
    expect(lastBlocker()?.enableBeforeUnload).toBe(true);
    expect(lastBlocker()?.shouldBlockFn({ current: admin('llm-dashboard'), next: admin('users') })).toBe(true);
    expect(lastBlocker()?.shouldBlockFn({ current: admin('llm-dashboard'), next: admin('llm-dashboard') })).toBe(false);
  });
});

describe('LLMDashboardTab states', () => {
  it('shows a labelled loading state under the header on first load', () => {
    h.modelInfo = { data: undefined, isPending: true, isLoading: true, isFetching: true, error: null };
    renderTab();

    expect(screen.getByTestId('llm-dashboard-root').firstElementChild).toBe(screen.getByTestId('admin-page-header'));
    expect(screen.getByTestId('llm-dashboard-loading')).toHaveTextContent('Loading models');
    expect(screen.queryByTestId('llm-dashboard-table')).toBeNull();
  });

  it('stays on the loading state until the models are copied in, so no empty table paints first', () => {
    renderTab();

    expect(visibleModelIds()).toEqual(['gpt-5', 'claude-opus', 'dall-e', 'flux-pro']);
    expect(h.emptyStateTitles).toEqual([]);
  });

  it('shows the error with a retry when the model list fails to load', () => {
    h.modelInfo = {
      data: undefined,
      isPending: false,
      isLoading: false,
      isFetching: false,
      error: new Error('Network Error'),
    };
    renderTab();

    const errorState = screen.getByTestId('admin-error-state');
    expect(errorState).toHaveTextContent('Could not load models: Network Error');
    fireEvent.click(within(errorState).getByTestId('admin-error-retry-btn'));
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the loaded models on screen when a later refetch fails', () => {
    h.modelInfo = {
      data: models,
      isPending: false,
      isLoading: false,
      isFetching: false,
      error: new Error('Network Error'),
    };
    renderTab();

    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('loaded editor and unsaved changes are retained');
    expect(visibleModelIds()).toEqual(['gpt-5', 'claude-opus', 'dall-e', 'flux-pro']);
  });

  it('says so when the catalog has no models, with a way to refresh', () => {
    h.modelInfo = { data: [], isPending: false, isLoading: false, isFetching: false, error: null };
    renderTab();

    const empty = screen.getByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No models available');
    fireEvent.click(within(empty).getByTestId('llm-dashboard-refresh-btn'));
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });
});

describe('model access read recovery', () => {
  it('shows a useful retry when the catalog loaded but the initial access read failed', () => {
    h.configError = new Error('Access read failed');
    renderTab();
    expect(screen.getByText('Could not load models: Access read failed')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(h.refetch).toHaveBeenCalled();
    expect(h.refetchConfigs).toHaveBeenCalled();
    expect(screen.queryByTestId('llm-dashboard-table')).not.toBeInTheDocument();
  });
});
