import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  endpoints: ['/api/x/a'],
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
  ...over,
});

const state = (over: Record<string, unknown> = {}) => ({
  data: undefined,
  isFetching: false,
  error: null,
  ...over,
});

describe('ApiKeyScopePreflightTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseApiKeyScopePreflight.mockReturnValue(state());
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
  });

  it('reads an empty result as safe-to-enforce, not as missing data', () => {
    // The distinction the tool exists for: nobody calls these routes, so the
    // staging sequence can be skipped entirely.
    mockUseApiKeyScopePreflight.mockReturnValue(state({ data: result({ rows: [] }) }));
    renderTab();

    const empty = screen.getByTestId('scope-preflight-empty');
    expect(empty.textContent).toMatch(/No API key has called these routes/);
    expect(empty.textContent).toMatch(/enforced in one step/);
    expect(screen.queryByTestId('scope-preflight-results')).toBeNull();
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

    expect(screen.getByTestId('scope-preflight-truncated').textContent).toMatch(/partial/);
  });

  it('surfaces a failed preflight instead of showing an empty result', () => {
    // A failed scan must never look like "nobody breaks".
    mockUseApiKeyScopePreflight.mockReturnValue(state({ error: new Error('scan exploded') }));
    renderTab();

    expect(screen.getByTestId('scope-preflight-error').textContent).toContain('scan exploded');
    expect(screen.queryByTestId('scope-preflight-empty')).toBeNull();
    expect(screen.queryByTestId('scope-preflight-results')).toBeNull();
  });
});
