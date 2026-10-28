import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IApiKeyScopePreflight, IApiKeyScopePreflightRow } from '@bike4mind/common';

// The hook is mocked rather than the axios client: the component only fetches
// once a scope is chosen from a Joy multi-select, and driving that in jsdom
// tests the Select, not this component's rendering. Mocking here lets the render
// paths be asserted directly - which is the behaviour worth pinning.
const { mockUseApiKeyScopePreflight } = vi.hoisted(() => ({ mockUseApiKeyScopePreflight: vi.fn() }));
vi.mock('@client/app/hooks/data/apiKeyScopePreflight', () => ({
  useApiKeyScopePreflight: mockUseApiKeyScopePreflight,
}));

import ApiKeyScopePreflightTab from './ApiKeyScopePreflightTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ApiKeyScopePreflightTab />
    </CssVarsProvider>
  );

const row = (over: Partial<IApiKeyScopePreflightRow> = {}): IApiKeyScopePreflightRow => ({
  keyId: 'k1',
  userId: 'u1',
  requests: 9,
  lastUsed: new Date('2026-08-01'),
  heldScopes: [],
  outcome: 'deny',
  ...over,
});

const result = (over: Partial<IApiKeyScopePreflight> = {}): IApiKeyScopePreflight => ({
  endpointPrefix: '/api/x',
  requiredScopes: ['admin:*'],
  windowDays: 90,
  stagedScopes: [],
  rows: [],
  truncated: false,
  coverage: { fullWindow: true, unloggedPrefixes: [] },
  ...over,
});

const state = (over: Record<string, unknown> = {}) => ({
  data: undefined,
  isFetching: false,
  error: null,
  refetch: vi.fn(),
  ...over,
});

/**
 * `isAxiosError` keys off the flag alone, so this is the real shape as far as the
 * component's extraction is concerned. A plain `Error` would pass either way -
 * its `.message` *is* the right text - which is why the axios path needs its own
 * fixture to be pinned at all.
 */
const axiosError = (serverMessage: string) => ({
  isAxiosError: true,
  message: 'Request failed with status code 400',
  response: { data: { error: serverMessage } },
});

/** Fill the form enough to enable Run: a rooted prefix plus one scope. */
const fillForm = async (prefix = '/api/x') => {
  const input = screen.getByTestId('scope-preflight-prefix-input').querySelector('input')!;
  await userEvent.clear(input);
  await userEvent.type(input, prefix);
  await userEvent.click(screen.getByTestId('scope-preflight-scopes-select').querySelector('button')!);
  await userEvent.click(screen.getByRole('option', { name: 'admin:*' }));
};

describe('ApiKeyScopePreflightTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseApiKeyScopePreflight.mockReturnValue(state());
  });

  it('focuses the endpoint field from the initial empty state', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('scope-preflight-start-btn'));
    expect(screen.getByTestId('scope-preflight-prefix-input').querySelector('input')).toHaveFocus();
  });

  it('filters and sorts the complete result, resetting pagination when the search changes', () => {
    const rows = Array.from({ length: 51 }, (_, index) => row({ keyId: `key-${index + 1}`, requests: 51 - index }));
    mockUseApiKeyScopePreflight.mockReturnValue(state({ data: result({ rows }) }));
    renderTab();
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(screen.getByTestId('admin-table-row-key-26')).toBeTruthy();

    fireEvent.change(screen.getByTestId('admin-filter-search-input'), { target: { value: 'KEY-' } });
    expect(screen.getByTestId('admin-table-row-key-1')).toBeTruthy();
    expect(screen.getByTestId('admin-table-previous-btn')).toBeDisabled();

    fireEvent.change(screen.getByTestId('admin-filter-search-input'), { target: { value: 'KEY-51' } });
    expect(screen.getByTestId('admin-table-row-key-51')).toBeTruthy();
    expect(screen.getByTestId('admin-table-previous-btn')).toBeDisabled();
    expect(screen.getByTestId('scope-preflight-deny-count')).toHaveTextContent('51');

    fireEvent.change(screen.getByTestId('admin-filter-search-input'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('admin-table-sort-requests-btn'));
    const firstRow = within(screen.getByTestId('scope-preflight-results')).getAllByRole('row')[1];
    expect(firstRow).toHaveAttribute('data-testid', 'admin-table-row-key-51');
  });

  it('keeps Run disabled until a rooted prefix and a scope are both supplied', async () => {
    // The scan is unindexed, so a half-filled form must not be runnable.
    renderTab();
    expect(screen.getByTestId('scope-preflight-run-btn')).toBeDisabled();

    const input = screen.getByTestId('scope-preflight-prefix-input').querySelector('input')!;
    await userEvent.type(input, 'api/x'); // no leading slash
    expect(screen.getByTestId('scope-preflight-run-btn')).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, '/api/x'); // rooted, but still no scope selected
    expect(screen.getByTestId('scope-preflight-run-btn')).toBeDisabled();

    // The other half of the rule: with both inputs supplied it must actually run.
    // Without this, hardcoding `disabled` or dropping the scope check leaves the
    // three assertions above green.
    await userEvent.click(screen.getByTestId('scope-preflight-scopes-select').querySelector('button')!);
    await userEvent.click(screen.getByRole('option', { name: 'admin:*' }));
    expect(screen.getByTestId('scope-preflight-run-btn')).not.toBeDisabled();
  });

  it('re-runs when Run is pressed on unchanged inputs', async () => {
    // Identical params hash to the same react-query key, so the mounted observer
    // serves cache and fires nothing - no request and no spinner, which makes a
    // stale verdict indistinguishable from a fresh one.
    const refetch = vi.fn();
    mockUseApiKeyScopePreflight.mockReturnValue(state({ data: result({ rows: [] }), refetch }));
    renderTab();

    await fillForm();
    await userEvent.click(screen.getByTestId('scope-preflight-run-btn'));
    expect(refetch).not.toHaveBeenCalled(); // first run: the query key is new

    await userEvent.click(screen.getByTestId('scope-preflight-run-btn'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('names the run the results belong to', async () => {
    // The form stays editable while results stay on screen. Without an echo, a
    // green verdict for one prefix reads as answering whatever is in the box now.
    mockUseApiKeyScopePreflight.mockReturnValue(
      state({ data: result({ endpointPrefix: '/api/widgets', requiredScopes: ['ai:chat'], rows: [row()] }) })
    );
    renderTab();

    const echo = screen.getByTestId('scope-preflight-run-echo').textContent!;
    expect(echo).toContain('/api/widgets');
    expect(echo).toContain('ai:chat');
  });

  it('reads a fully-covered empty result as safe-to-enforce, not as missing data', () => {
    // The distinction the tool exists for: nobody calls these routes, so the
    // staging sequence can be skipped entirely. Only licensed when the run saw
    // the whole logged history over a prefix that is actually logged.
    mockUseApiKeyScopePreflight.mockReturnValue(state({ data: result({ rows: [] }) }));
    renderTab();

    const empty = screen.getByTestId('scope-preflight-empty');
    expect(empty.textContent).toMatch(/No API key has called these routes/);
    expect(empty.textContent).toMatch(/enforced in one step/);
    expect(screen.queryByTestId('scope-preflight-results')).toBeNull();
  });

  it('withholds the enforce-in-one-step advice on a short-window empty result', () => {
    // A key that fires monthly leaves no trace in 7 days. Repeating the
    // full-window wording here would license the exact one-shot rollout this
    // tool was built to prevent.
    mockUseApiKeyScopePreflight.mockReturnValue(
      state({ data: result({ rows: [], windowDays: 7, coverage: { fullWindow: false, unloggedPrefixes: [] } }) })
    );
    renderTab();

    expect(screen.queryByTestId('scope-preflight-empty')).toBeNull();
    const inconclusive = screen.getByTestId('scope-preflight-empty-inconclusive');
    expect(inconclusive.textContent).toMatch(/re-run at 90 days/);
    expect(inconclusive.textContent).toMatch(/Do not skip the staging sequence/);
    expect(inconclusive.textContent).not.toMatch(/enforced in one step/);
  });

  it('names the unlogged surfaces a prefix sweeps up, and will not call the result clean', () => {
    // ApiKeyUsageLog is written only by baseApi, so traffic to verifyApiKey
    // routes is invisible here - an unqualified "nobody calls these" would be a
    // false statement of fact, not a coverage caveat.
    mockUseApiKeyScopePreflight.mockReturnValue(
      state({
        data: result({ rows: [], coverage: { fullWindow: true, unloggedPrefixes: ['/api/ai/v1', '/api/embed'] } }),
      })
    );
    renderTab();

    expect(screen.getByTestId('scope-preflight-unlogged').textContent).toMatch(/\/api\/ai\/v1/);
    expect(screen.queryByTestId('scope-preflight-empty')).toBeNull();
    expect(screen.getByTestId('scope-preflight-empty-inconclusive').textContent).toMatch(/Unlogged routes/);
  });

  it('shows the unlogged-surface warning alongside real rows too', () => {
    // The caveat is about what the scan could not see, so it applies whether or
    // not the visible part of the prefix turned up keys.
    mockUseApiKeyScopePreflight.mockReturnValue(
      state({ data: result({ rows: [row()], coverage: { fullWindow: true, unloggedPrefixes: ['/api/embed'] } }) })
    );
    renderTab();

    expect(screen.getByTestId('scope-preflight-unlogged')).toBeTruthy();
    expect(screen.getByTestId('scope-preflight-results')).toBeTruthy();
  });

  it('renders a row per key with its outcome, and counts the breakage', () => {
    mockUseApiKeyScopePreflight.mockReturnValue(
      state({
        data: result({
          rows: [
            row({ keyId: 'breaks', outcome: 'deny' }),
            row({ keyId: 'staged', outcome: 'stagedAllow' }),
            row({ keyId: 'fine', outcome: 'allow', heldScopes: ['admin:*'] }),
          ],
        }),
      })
    );
    renderTab();

    const table = screen.getByTestId('scope-preflight-results');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(table.textContent).toContain('breaks');
    expect(table.textContent).toContain('would 403');
    expect(table.textContent).toContain('staged only');
    expect(table.textContent).toContain('passes');
    expect(screen.getByTestId('scope-preflight-deny-count').textContent).toContain('1');
  });

  it('warns that a truncated list is not the whole population', () => {
    // Silently showing a capped list would read as a complete re-mint list.
    mockUseApiKeyScopePreflight.mockReturnValue(state({ data: result({ truncated: true, rows: [row()] }) }));
    renderTab();

    const banner = screen.getByTestId('scope-preflight-truncated').textContent!;
    expect(banner).toMatch(/partial/);
    // Narrowing the window clears the cap by shrinking coverage, dropping the
    // low-traffic keys for good rather than paging past them.
    expect(banner).toMatch(/Do not\s+narrow the window/);
  });

  it('surfaces a failed preflight instead of showing an empty result', () => {
    // A failed scan must never look like "nobody breaks".
    mockUseApiKeyScopePreflight.mockReturnValue(state({ error: new Error('scan exploded') }));
    renderTab();

    expect(screen.getByTestId('scope-preflight-error').textContent).toContain('scan exploded');
    expect(screen.queryByTestId('scope-preflight-empty')).toBeNull();
    expect(screen.queryByTestId('scope-preflight-results')).toBeNull();
  });

  it('does not show a cached verdict after a failed refetch', () => {
    mockUseApiKeyScopePreflight.mockReturnValue(state({ data: result(), error: new Error('Refresh failed') }));
    renderTab();
    expect(screen.getByTestId('scope-preflight-error')).toHaveTextContent('Refresh failed');
    expect(screen.queryByTestId('scope-preflight-empty')).toBeNull();
    expect(screen.queryByTestId('scope-preflight-run-echo')).toBeNull();
  });

  it('does not count cached rows in the header after a failed refetch or during a new run', () => {
    mockUseApiKeyScopePreflight.mockReturnValue(state({ data: result({ rows: [row()] }), error: new Error('nope') }));
    const { rerender } = renderTab();
    expect(screen.getByTestId('admin-page-header')).not.toHaveTextContent('(1)');

    mockUseApiKeyScopePreflight.mockReturnValue(state({ data: result({ rows: [row()] }), isFetching: true }));
    rerender(
      <CssVarsProvider theme={appTheme}>
        <ApiKeyScopePreflightTab />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('admin-page-header')).not.toHaveTextContent('(1)');
  });

  it('offers Clear search, not a re-run, when a search matches no returned keys', async () => {
    const refetch = vi.fn();
    mockUseApiKeyScopePreflight.mockReturnValue(state({ data: result({ rows: [row()], truncated: true }), refetch }));
    renderTab();

    const search = screen.getByTestId('admin-filter-search-input');
    await userEvent.type(search, 'nomatch');
    expect(screen.getByText('No returned keys match')).toBeInTheDocument();
    expect(screen.getByTestId('scope-preflight-truncated')).toBeTruthy();
    expect(screen.queryByTestId('scope-preflight-empty')).toBeNull();
    expect(screen.queryByTestId('admin-table-refresh-btn')).toBeNull();

    await userEvent.click(screen.getByTestId('scope-preflight-clear-search-btn'));
    expect(search).toHaveValue('');
    expect(screen.getByTestId('scope-preflight-results').querySelectorAll('tbody tr')).toHaveLength(1);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("shows the handler's refusal, not axios's generic status string", () => {
    // The refusals are the remedy: an unlogged prefix explains why the answer
    // would have been false, and an unknown scope explains a caught typo.
    // `errorHandler` puts that text at `response.data.error`; `error.message` is
    // only "Request failed with status code 400", which reads as a broken tool.
    mockUseApiKeyScopePreflight.mockReturnValue(
      state({ error: axiosError('/api/ai/v1 is served by verifyApiKey, not baseApi') })
    );
    renderTab();

    const alert = screen.getByTestId('scope-preflight-error').textContent!;
    expect(alert).toContain('served by verifyApiKey');
    expect(alert).not.toContain('Request failed with status code');
  });
});
