import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...a: unknown[]) => mockGet(...a), post: (...a: unknown[]) => mockPost(...a) },
}));

import { DiscoveryStatusCard } from './DiscoveryStatusCard';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const STATUS = {
  lastRun: {
    startedAt: '2026-07-26T12:00:00.000Z',
    finishedAt: '2026-07-26T12:03:00.000Z',
    trigger: 'cron',
    host: 'hosted',
    status: 'partial',
    sources: [
      { name: 'openai', ok: true, durationMs: 120 },
      { name: 'anthropic', ok: true, durationMs: 140 },
      { name: 'models.dev', ok: false, durationMs: 900, error: 'ETIMEDOUT' },
    ],
    joinCoverage: [{ aggregator: 'models.dev', matched: 84, total: 113 }],
    changes: { added: 2, promoted: 1, deprecated: 0, repriced: 0, flagged: 0 },
  },
  lastSuccessfulRunAt: '2026-07-26T06:00:00.000Z',
  mode: 'report',
  autoEnable: 'priced',
  selfHost: false,
};

const renderCard = () =>
  render(
    <TestWrapper>
      <DiscoveryStatusCard />
    </TestWrapper>
  );

describe('DiscoveryStatusCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: STATUS });
    mockPost.mockResolvedValue({ data: { dispatched: 'lambda' } });
  });

  it('renders the last run, the source tally and the settings badges', async () => {
    renderCard();

    expect(await screen.findByTestId('discovery-status-run-chip')).toHaveTextContent('partial');
    expect(screen.getByTestId('discovery-status-mode-chip')).toHaveTextContent('report');
    expect(screen.getByTestId('discovery-status-autoenable-chip')).toHaveTextContent('priced');
    expect(screen.getByTestId('discovery-status-last-run')).toHaveTextContent('cron on hosted');
    expect(screen.getByTestId('discovery-status-sources')).toHaveTextContent('2/3 sources ok');
    expect(screen.getByTestId('discovery-status-coverage-models.dev')).toHaveTextContent('84/113');
    expect(screen.getByTestId('discovery-status-changes')).toHaveTextContent('2 added, 1 promoted');
    expect(mockGet).toHaveBeenCalledWith('/api/admin/model-discovery');
  });

  it('names the failed source and its error on demand', async () => {
    renderCard();
    fireEvent.click(await screen.findByTestId('discovery-status-failures-toggle'));

    expect(screen.getByTestId('discovery-status-failure-models.dev')).toHaveTextContent('ETIMEDOUT');
  });

  it('says so when discovery has never run', async () => {
    mockGet.mockResolvedValue({ data: { ...STATUS, lastRun: null, lastSuccessfulRunAt: null } });
    renderCard();

    expect(await screen.findByTestId('discovery-status-never-run')).toBeInTheDocument();
  });

  it('posts on Run now, disables the button while in flight, then reports the dispatch', async () => {
    let dispatch = (_value: { data: { dispatched: string } }) => {};
    mockPost.mockReturnValue(new Promise(resolve => (dispatch = resolve)));
    renderCard();

    const button = await screen.findByTestId('model-lifecycle-run-now-btn');
    fireEvent.click(button);

    await waitFor(() => expect(button).toHaveAttribute('disabled'));
    expect(mockPost).toHaveBeenCalledWith('/api/admin/model-discovery');

    dispatch({ data: { dispatched: 'lambda' } });
    expect(await screen.findByTestId('discovery-status-notice')).toHaveTextContent('Dispatched (lambda)');
    await waitFor(() => expect(button).not.toHaveAttribute('disabled'));
  });

  it('surfaces the server reason when the dispatch is refused', async () => {
    mockPost.mockRejectedValue({
      message: 'Request failed with status code 503',
      response: { data: { message: 'Model discovery function is not linked to this deployment.' } },
    });
    renderCard();

    fireEvent.click(await screen.findByTestId('model-lifecycle-run-now-btn'));

    expect(await screen.findByTestId('discovery-status-error')).toHaveTextContent('is not linked');
    expect(screen.queryByTestId('discovery-status-notice')).not.toBeInTheDocument();
  });
});
