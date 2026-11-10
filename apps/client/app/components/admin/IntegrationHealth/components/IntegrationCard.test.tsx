import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import AppTheme from '@client/app/utils/themes/AppTheme';
import { IntegrationCard } from './IntegrationCard';
import type { IntegrationDashboardEntry } from '../types';

vi.mock('./IntegrationDetailPanel', () => ({ IntegrationDetailPanel: () => null }));

const entry = (overrides: Partial<IntegrationDashboardEntry> = {}): IntegrationDashboardEntry => ({
  name: 'slack',
  status: 'healthy',
  latencyMs: 120,
  lastCheckedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  successRate: 0.98,
  consecutiveFailures: 0,
  error: null,
  circuitBreaker: { available: true, reason: null, mode: 'auto', autoTripped: false },
  rateLimit: null,
  recentErrors: [],
  ...overrides,
});

const renderCard = (value: IntegrationDashboardEntry) =>
  render(
    <AppTheme>
      <IntegrationCard
        entry={value}
        isExpanded={false}
        onToggle={vi.fn()}
        inMemoryBreakers={{}}
        onOverride={vi.fn()}
        isUpdatingOverride={false}
      />
    </AppTheme>
  );

describe('IntegrationCard', () => {
  it('shows a never-checked integration as No data, checked never', () => {
    renderCard(entry({ status: 'no_data', lastCheckedAt: null, latencyMs: 0, successRate: 0 }));

    const card = screen.getByTestId('integration-card-slack');
    expect(card).toHaveTextContent('No data');
    expect(card).not.toHaveTextContent('Down');
    expect(card).not.toHaveTextContent('0ms');
    expect(screen.getByTestId('integration-card-slack-checked')).toHaveTextContent('checked never');
  });

  it('shows latency, success rate and check age for a checked integration', () => {
    renderCard(entry());

    const card = screen.getByTestId('integration-card-slack');
    expect(card).toHaveTextContent('Healthy');
    expect(card).toHaveTextContent('120ms');
    expect(card).toHaveTextContent('98% success');
    expect(screen.getByTestId('integration-card-slack-checked')).toHaveTextContent('checked 5m ago');
  });
});
