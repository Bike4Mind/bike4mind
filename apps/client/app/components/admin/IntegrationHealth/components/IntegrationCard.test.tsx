import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IntegrationCard } from './IntegrationCard';
import type { IntegrationDashboardEntry } from '../types';

vi.mock('./IntegrationDetailPanel', () => ({ IntegrationDetailPanel: () => null }));

const appTheme = extendTheme({ ...getThemeConfig() });

const entry = (overrides: Partial<IntegrationDashboardEntry> = {}): IntegrationDashboardEntry => ({
  name: 'slack',
  status: 'no_data',
  latencyMs: 0,
  lastCheckedAt: null,
  successRate: 0,
  consecutiveFailures: 0,
  error: null,
  circuitBreaker: { available: true, reason: null, mode: 'auto', autoTripped: false },
  rateLimit: null,
  recentErrors: [],
  ...overrides,
});

function renderCard(e: IntegrationDashboardEntry) {
  return render(
    <CssVarsProvider theme={appTheme}>
      <IntegrationCard
        entry={e}
        isExpanded={false}
        onToggle={vi.fn()}
        inMemoryBreakers={{}}
        onOverride={vi.fn()}
        isUpdatingOverride={false}
      />
    </CssVarsProvider>
  );
}

describe('IntegrationCard', () => {
  it('shows a never-checked integration as not checked, with no latency or success numbers', () => {
    renderCard(entry());

    expect(screen.getByTestId('integration-last-checked-slack')).toHaveTextContent('Never checked');
    const status = screen.getByTestId('integration-status-slack');
    expect(status).toHaveTextContent('Not checked');
    expect(status).toHaveAttribute('data-tone', 'neutral');
    expect(screen.queryByText(/% success/)).not.toBeInTheDocument();
  });

  it('shows a checked integration that is down with the soft bad tone and a relative time', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    renderCard(entry({ status: 'unhealthy', lastCheckedAt: fiveMinutesAgo, consecutiveFailures: 3 }));

    expect(screen.getByTestId('integration-last-checked-slack')).toHaveTextContent('Checked 5m ago');
    const status = screen.getByTestId('integration-status-slack');
    expect(status).toHaveTextContent('Down');
    expect(status).toHaveAttribute('data-tone', 'bad');
  });
});
