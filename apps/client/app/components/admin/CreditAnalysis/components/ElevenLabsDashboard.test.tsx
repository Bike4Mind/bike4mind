import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ElevenLabsPlanUsage, ElevenLabsUsageTotals } from '@bike4mind/common';

const mockUseElevenLabsUsage = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../hooks/useElevenLabsUsage', () => ({
  useElevenLabsUsage: (...args: unknown[]) => mockUseElevenLabsUsage(...args),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }));
vi.mock('recharts', async importOriginal => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { ElevenLabsDashboard, fillCycleDays } from './ElevenLabsDashboard';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderDashboard = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ElevenLabsDashboard />
    </CssVarsProvider>
  );

const totals = (overrides: Partial<ElevenLabsUsageTotals> = {}): ElevenLabsUsageTotals => ({
  requests: 0,
  credits: 0,
  agentMinutes: 0,
  failedRequests: 0,
  possiblyBilledCredits: 0,
  ...overrides,
});

const usage: ElevenLabsPlanUsage = {
  cycle: { from: '2026-03-15T00:00:00.000Z', to: '2026-04-15T00:00:00.000Z', startDay: 15 },
  plan: { monthlyCredits: 1000, agentMinutes: null },
  platform: totals({ requests: 3, credits: 250, agentMinutes: 2, failedRequests: 1, possiblyBilledCredits: 30 }),
  userKeys: totals({ requests: 4, credits: 40 }),
  unknownKeySourceRequests: 2,
  byProduct: [{ product: 'text_to_speech', ...totals({ requests: 2, credits: 250 }) }],
  byModel: [
    {
      product: 'text_to_speech',
      model: 'eleven_multilingual_v2',
      units: 250,
      ...totals({ requests: 2, credits: 250 }),
    },
  ],
  byUser: [{ userId: 'u1', userLabel: 'Ada', ...totals({ requests: 2, credits: 250 }) }],
  byDay: [{ day: '2026-03-16', ...totals({ requests: 2, credits: 250 }) }],
};

const query = (overrides: object = {}) => ({
  data: usage,
  isLoading: false,
  isFetching: false,
  error: null,
  refetch: vi.fn(),
  ...overrides,
});

describe('ElevenLabsDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseElevenLabsUsage.mockReturnValue(query());
  });

  it('shows plan usage against the allowance and the breakdowns', () => {
    renderDashboard();

    expect(mockUseElevenLabsUsage).toHaveBeenCalledWith(0);
    expect(screen.getByText('25% of 1,000')).toBeInTheDocument();
    expect(screen.getByText('No allowance set')).toBeInTheDocument();
    expect(screen.getByText('1 failed request')).toBeInTheDocument();
    expect(screen.getByTestId('elevenlabs-cycle-note')).toHaveTextContent('2026-03-15 to 2026-04-14 (UTC)');
    expect(screen.getByTestId('elevenlabs-cycle-note')).toHaveTextContent('2 requests with no recorded key source');
    expect(within(screen.getByTestId('elevenlabs-products-table')).getByText('Text to speech')).toBeInTheDocument();
    expect(within(screen.getByTestId('elevenlabs-models-table')).getByText('250 characters')).toBeInTheDocument();
    expect(within(screen.getByTestId('elevenlabs-users-table')).getByText('Ada')).toBeInTheDocument();
  });

  it('reads an earlier cycle from the cycle filter', () => {
    renderDashboard();
    fireEvent.click(screen.getByTestId('admin-filter-cycle'));
    fireEvent.click(screen.getByTestId('admin-filter-cycle-1'));
    expect(mockUseElevenLabsUsage).toHaveBeenLastCalledWith(1);
  });

  it('shows the loading state', () => {
    mockUseElevenLabsUsage.mockReturnValue(query({ data: undefined, isLoading: true }));
    renderDashboard();
    expect(screen.getByTestId('elevenlabs-loading')).toBeInTheDocument();
  });

  it('shows the error and retries', () => {
    const refetch = vi.fn();
    mockUseElevenLabsUsage.mockReturnValue(query({ data: undefined, error: new Error('boom'), refetch }));
    renderDashboard();

    expect(screen.getByText('boom')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetch).toHaveBeenCalled();
  });

  it('opens the plan settings in Admin Settings', () => {
    renderDashboard();
    fireEvent.click(screen.getByTestId('elevenlabs-plan-settings-btn'));

    const { to, search } = mockNavigate.mock.calls[0][0];
    expect(to).toBe('/admin');
    expect(search({})).toMatchObject({ section: 'aiConfiguration', q: 'elevenLabsPlan' });
  });
});

describe('fillCycleDays', () => {
  it('fills idle days with zero up to now', () => {
    const filled = fillCycleDays(usage.cycle, usage.byDay, new Date('2026-03-17T12:00:00Z'));
    expect(filled).toEqual([
      { day: '2026-03-15', value: 0 },
      { day: '2026-03-16', value: 250 },
      { day: '2026-03-17', value: 0 },
    ]);
  });
});
