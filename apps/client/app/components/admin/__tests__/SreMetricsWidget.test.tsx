import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SreMetrics } from '@bike4mind/common';

const { mockGet, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mockGet, post: mockPost },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}));

vi.mock('@client/app/utils/react-query', () => ({
  replaceQueryData: vi.fn(),
  setOptimisticQueryData: vi.fn(),
  updateSingleQueryDataFast: vi.fn(),
}));

import { SreMetricsWidget } from '../SreAgentTab';

// resolved (fixed 4 + already_fixed 0) vs failed (failed 2 + dispatch_failed 1 +
// low_confidence 1) => 4 / 8 => 50% success rate.
const METRICS: SreMetrics = {
  windowMs: 7 * 24 * 60 * 60 * 1000,
  total: 12,
  bySource: { CLOUDWATCH: 5, GITHUB_ISSUE: 7 },
  byStatus: { fixed: 4, detected: 3, failed: 2, dispatch_failed: 1, low_confidence: 1, analyzing: 1 },
  analysesRun: 9,
  fixesDispatched: 6,
  prsCreated: 5,
  prsMerged: 4,
  tokens: { input: 1_234_567, output: 89_012 },
};

const EMPTY_METRICS: SreMetrics = {
  windowMs: 24 * 60 * 60 * 1000,
  total: 0,
  bySource: { CLOUDWATCH: 0, GITHUB_ISSUE: 0 },
  byStatus: {},
  analysesRun: 0,
  fixesDispatched: 0,
  prsCreated: 0,
  prsMerged: 0,
  tokens: { input: 0, output: 0 },
};

function renderWidget(repoSlug = '') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const theme = extendTheme({ ...getThemeConfig() });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={theme}>
        <SreMetricsWidget repoSlug={repoSlug} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
}

describe('SreMetricsWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: METRICS });
  });

  it('renders headline tiles from the fetched metrics', async () => {
    renderWidget();

    const total = await screen.findByTestId('sre-metric-total');
    expect(total).toHaveTextContent('12');
    expect(screen.getByTestId('sre-metric-analyses')).toHaveTextContent('9');
    expect(screen.getByTestId('sre-metric-dispatched')).toHaveTextContent('6');
    expect(screen.getByTestId('sre-metric-prs-created')).toHaveTextContent('5');
    expect(screen.getByTestId('sre-metric-prs-merged')).toHaveTextContent('4');
  });

  it('renders compact token totals and derived success rate', async () => {
    renderWidget();

    const tokens = await screen.findByTestId('sre-metric-tokens');
    expect(tokens).toHaveTextContent('1.2M');
    expect(tokens).toHaveTextContent('89.0K');

    // 4 resolved / (4 + 4 failed) = 50%
    expect(screen.getByTestId('sre-metric-success-rate')).toHaveTextContent('50%');
  });

  it('renders source and status breakdowns', async () => {
    renderWidget();

    expect(await screen.findByTestId('sre-metric-source-cloudwatch')).toHaveTextContent('CloudWatch 5');
    expect(screen.getByTestId('sre-metric-source-github')).toHaveTextContent('GitHub 7');

    expect(screen.getByTestId('sre-metric-status-fixed')).toHaveTextContent('fixed 4');
    expect(screen.getByTestId('sre-metric-status-failed')).toHaveTextContent('failed 2');
    expect(screen.getByTestId('sre-metric-status-detected')).toHaveTextContent('detected 3');
  });

  it('defaults to the 7d window and refetches when a different window is selected', async () => {
    renderWidget();
    await screen.findByTestId('sre-metric-total');

    // Initial fetch uses the default 7d window.
    expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('window=7d'));

    fireEvent.click(screen.getByTestId('sre-metrics-window-24h'));

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('window=24h')));
  });

  it('includes the repoSlug filter in the request when one is set', async () => {
    renderWidget('owner/repo');
    await screen.findByTestId('sre-metric-total');

    expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('repoSlug=owner%2Frepo'));
  });

  it('omits the repoSlug filter when viewing all repos', async () => {
    renderWidget('');
    await screen.findByTestId('sre-metric-total');

    expect(mockGet).toHaveBeenCalledWith(expect.not.stringContaining('repoSlug='));
  });

  it('shows the empty state when the window has no activity', async () => {
    mockGet.mockResolvedValue({ data: EMPTY_METRICS });
    renderWidget();

    expect(await screen.findByTestId('sre-metrics-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('sre-metric-total')).not.toBeInTheDocument();
  });

  it('shows an error state when the request fails', async () => {
    mockGet.mockRejectedValue(new Error('boom'));
    renderWidget();

    const err = await screen.findByTestId('sre-metrics-error');
    expect(within(err).getByText(/Failed to load metrics/)).toBeInTheDocument();
  });
});
