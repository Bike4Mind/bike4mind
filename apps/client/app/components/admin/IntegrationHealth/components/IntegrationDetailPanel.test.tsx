import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IntegrationDetailPanel } from './IntegrationDetailPanel';
import type { IntegrationDashboardEntry, RecentError } from '../types';

vi.mock('../hooks/useIntegrationHistory', () => ({
  useIntegrationHistory: () => ({
    checks: [],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    isRefetching: false,
  }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });

const recentError = (overrides: Partial<RecentError> = {}): RecentError => ({
  source: 'health_check',
  occurredAt: '2026-01-01T00:00:00.000Z',
  message: 'Probe timed out',
  errorCode: 'ETIMEDOUT',
  entityType: null,
  action: null,
  ...overrides,
});

const entry = (recentErrors: RecentError[]): IntegrationDashboardEntry => ({
  name: 'slack',
  status: 'unhealthy',
  latencyMs: 0,
  lastCheckedAt: null,
  successRate: 0,
  consecutiveFailures: 1,
  error: null,
  circuitBreaker: { available: true, reason: null, mode: 'auto', autoTripped: false },
  rateLimit: null,
  recentErrors,
});

function renderPanel(recentErrors: RecentError[], onOverride = vi.fn()) {
  render(
    <CssVarsProvider theme={appTheme}>
      <IntegrationDetailPanel
        entry={entry(recentErrors)}
        isExpanded
        inMemoryBreakers={{}}
        onOverride={onOverride}
        isUpdatingOverride={false}
      />
    </CssVarsProvider>
  );
  return onOverride;
}

describe('IntegrationDetailPanel recent errors', () => {
  it('lists each recent error in the shared table, two with the same time included', () => {
    renderPanel([
      recentError(),
      recentError({ source: 'audit_log', message: 'Token revoked', errorCode: null, action: 'disconnect' }),
    ]);
    const rows = within(screen.getByTestId('integration-recent-errors-table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Probe');
    expect(rows[0]).toHaveTextContent('ETIMEDOUT');
    expect(rows[1]).toHaveTextContent('Audit');
    expect(rows[1]).toHaveTextContent('Token revoked');
    expect(rows[1]).toHaveTextContent('disconnect');
  });

  it('says so when there are no recent errors, and keeps the override buttons working', () => {
    const onOverride = renderPanel([]);
    expect(screen.queryByTestId('integration-recent-errors-table')).not.toBeInTheDocument();
    expect(screen.getByText('No recent errors.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('circuit-breaker-auto-btn-slack'));
    expect(onOverride).toHaveBeenCalledWith('slack', 'auto');
  });
});
