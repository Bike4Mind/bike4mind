import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ModelBackend, type LLMModelConfig } from '@bike4mind/common';

const h = vi.hoisted(() => ({ saveMutate: vi.fn() }));

const makeModel = (over: Partial<LLMModelConfig>): LLMModelConfig =>
  ({
    type: 'text',
    backend: ModelBackend.OpenAI,
    contextWindow: 128000,
    max_tokens: 4096,
    enabled: true,
    allowedUserTags: [],
    supportsImageVariation: false,
    pricing: {},
    ...over,
  }) as LLMModelConfig;

const models: LLMModelConfig[] = [
  makeModel({ id: 'gpt-5-preview', name: 'GPT-5 Preview' }),
  makeModel({ id: 'claude-opus-preview', name: 'Claude Opus Preview', backend: ModelBackend.Anthropic }),
  makeModel({ id: 'gpt-5', name: 'GPT-5' }),
  makeModel({ id: 'flux-pro', name: 'Flux Pro', backend: ModelBackend.BFL, type: 'image', enabled: false }),
];

vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: models, isLoading: false, error: null }),
}));

vi.mock('@client/app/hooks/data/llmModelConfig', () => ({
  useLLMModelConfigurationsWithDefaults: () => ({ data: models, isLoading: false }),
  useSaveLLMModelConfigurations: () => ({ mutate: h.saveMutate, isPending: false }),
}));

vi.mock('@client/app/hooks/data/user', () => ({
  useGetUsers: () => ({ data: { users: [] }, isLoading: false }),
}));

vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));

// The SaveBar's leave-page guards need a router; these tests never navigate.
vi.mock('@tanstack/react-router', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useBlocker: () => ({ status: 'idle' }),
  useRouter: () => null,
}));

import LLMDashboardTab from './LLMDashboardTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <LLMDashboardTab />
    </CssVarsProvider>
  );

// Joy puts the real <input> inside the data-testid'd root span - interact with it directly.
const inputIn = (testId: string) => {
  const input = screen.getByTestId(testId).querySelector('input');
  if (!input) throw new Error(`No <input> found inside "${testId}"`);
  return input;
};

/** Longer than the tab's search debounce, so the filter has settled on return. */
const SEARCH_SETTLE_MS = 500;

const typeSearch = (value: string) =>
  fireEvent.change(screen.getByTestId('llm-dashboard-search-input'), { target: { value } });

const settle = () => act(() => void vi.advanceTimersByTime(SEARCH_SETTLE_MS));

const search = (value: string) => {
  typeSearch(value);
  settle();
};

const setStatusFilter = (value: string) => {
  fireEvent.click(within(screen.getByTestId('llm-dashboard-status-filter')).getByTestId('admin-filter-status'));
  fireEvent.click(screen.getByTestId(`admin-filter-status-${value}`));
};

const visibleModelIds = () =>
  screen
    .getAllByTestId(/^llm-dashboard-row-/)
    .map(node => node.getAttribute('data-testid')?.replace('llm-dashboard-row-', ''));

// The search filter is debounced, so every test drives the clock rather than
// waiting on it.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('LLMDashboardTab search', () => {
  beforeEach(() => vi.clearAllMocks());

  it('leaves the table alone until the search debounce settles', () => {
    renderTab();

    typeSearch('preview');
    expect(visibleModelIds()).toHaveLength(4);

    settle();
    expect(visibleModelIds()).toEqual(['gpt-5-preview', 'claude-opus-preview']);
  });

  it('narrows the table to models whose id or name matches, case-insensitively', () => {
    renderTab();
    expect(visibleModelIds()).toHaveLength(4);

    search('PREVIEW');

    expect(visibleModelIds()).toEqual(['gpt-5-preview', 'claude-opus-preview']);
  });

  it('matches on backend and composes with the status filter', () => {
    renderTab();

    search('anthropic');
    expect(visibleModelIds()).toEqual(['claude-opus-preview']);

    search('  ');
    expect(visibleModelIds()).toHaveLength(4);
  });
});

describe('LLMDashboardTab bulk selection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('select-all selects exactly the currently filtered rows', () => {
    renderTab();
    search('preview');

    fireEvent.click(inputIn('admin-table-select-page'));

    expect(screen.getByTestId('llm-dashboard-bulk-bar')).toHaveTextContent('2 selected');

    search('');
    expect(inputIn('admin-table-select-gpt-5-preview')).toBeChecked();
    expect(inputIn('admin-table-select-claude-opus-preview')).toBeChecked();
    expect(inputIn('admin-table-select-gpt-5')).not.toBeChecked();
    expect(inputIn('admin-table-select-page')).not.toBeChecked();
  });

  it('bulk disable flips only the selected rows and marks the dashboard dirty', () => {
    renderTab();

    fireEvent.click(inputIn('admin-table-select-gpt-5-preview'));
    fireEvent.click(inputIn('admin-table-select-claude-opus-preview'));
    fireEvent.click(screen.getByTestId('llm-dashboard-bulk-disable-btn'));

    expect(inputIn('llm-dashboard-toggle-gpt-5-preview')).not.toBeChecked();
    expect(inputIn('llm-dashboard-toggle-claude-opus-preview')).not.toBeChecked();
    expect(inputIn('llm-dashboard-toggle-gpt-5')).toBeChecked();
    expect(screen.getByTestId('admin-save-confirm-btn')).toBeInTheDocument();
  });

  it('bulk enable flips the selected rows back on', () => {
    renderTab();

    fireEvent.click(inputIn('admin-table-select-flux-pro'));
    fireEvent.click(screen.getByTestId('llm-dashboard-bulk-enable-btn'));

    expect(inputIn('llm-dashboard-toggle-flux-pro')).toBeChecked();
  });

  it('sends the bulk-changed models in the existing single save request', () => {
    renderTab();
    search('preview');

    fireEvent.click(inputIn('admin-table-select-page'));
    fireEvent.click(screen.getByTestId('llm-dashboard-bulk-disable-btn'));
    search('');
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

    expect(h.saveMutate).toHaveBeenCalledTimes(1);
    const saved = h.saveMutate.mock.calls[0][0] as LLMModelConfig[];
    expect(saved.map(model => [model.id, model.enabled])).toEqual([
      ['gpt-5-preview', false],
      ['claude-opus-preview', false],
      ['gpt-5', true],
      ['flux-pro', false],
    ]);
  });

  it('keeps the selection across a search change and says how much of it the filter shows', () => {
    renderTab();

    fireEvent.click(inputIn('admin-table-select-page'));
    expect(screen.getByTestId('llm-dashboard-bulk-bar')).toHaveTextContent('4 selected');

    search('preview');
    expect(screen.getByTestId('llm-dashboard-bulk-count')).toHaveTextContent(
      '2 of 4 selected models match this filter'
    );

    // Nothing was thrown away, so the hidden rows come back still selected.
    search('');
    expect(screen.getByTestId('llm-dashboard-bulk-bar')).toHaveTextContent('4 selected');
    expect(inputIn('admin-table-select-gpt-5')).toBeChecked();
  });

  it('a bulk action under a filter only touches the visible half of the selection', () => {
    renderTab();

    fireEvent.click(inputIn('admin-table-select-page'));
    search('preview');
    fireEvent.click(screen.getByTestId('llm-dashboard-bulk-disable-btn'));
    search('');

    expect(inputIn('llm-dashboard-toggle-gpt-5-preview')).not.toBeChecked();
    expect(inputIn('llm-dashboard-toggle-claude-opus-preview')).not.toBeChecked();
    expect(inputIn('llm-dashboard-toggle-gpt-5')).toBeChecked();
  });

  it('unchecking select-all under a filter releases only the visible rows', () => {
    renderTab();

    fireEvent.click(inputIn('admin-table-select-page'));
    search('preview');
    fireEvent.click(inputIn('admin-table-select-page'));

    expect(screen.queryByTestId('llm-dashboard-bulk-count')).toHaveTextContent(
      '0 of 2 selected models match this filter'
    );
    search('');
    expect(inputIn('admin-table-select-gpt-5')).toBeChecked();
    expect(inputIn('admin-table-select-gpt-5-preview')).not.toBeChecked();
  });

  it('reports how many rows a bulk action moved out of the current status filter', () => {
    renderTab();

    fireEvent.click(inputIn('admin-table-select-gpt-5-preview'));
    fireEvent.click(inputIn('admin-table-select-gpt-5'));
    // Status "Enabled": disabling the selection empties those rows out of the table.
    setStatusFilter('enabled');
    fireEvent.click(screen.getByTestId('llm-dashboard-bulk-disable-btn'));

    expect(screen.getByTestId('llm-dashboard-bulk-notice')).toHaveTextContent(
      'Disabled 2 models. 2 no longer match the current filter.'
    );
    expect(visibleModelIds()).toEqual(['claude-opus-preview']);
  });

  it('hides the bulk bar until something is selected', () => {
    renderTab();
    expect(screen.queryByTestId('llm-dashboard-bulk-bar')).not.toBeInTheDocument();

    fireEvent.click(inputIn('admin-table-select-gpt-5'));
    expect(screen.getByTestId('llm-dashboard-bulk-bar')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('admin-clear-selection-btn'));
    expect(screen.queryByTestId('llm-dashboard-bulk-bar')).not.toBeInTheDocument();
  });
});
