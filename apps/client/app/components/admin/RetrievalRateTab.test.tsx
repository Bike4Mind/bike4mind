import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { OptionalPathRetrievalRate } from '@bike4mind/common';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mockGet } }));

import RetrievalRateTab from './RetrievalRateTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderTab = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <RetrievalRateTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

const summary = (over: Partial<OptionalPathRetrievalRate> = {}): OptionalPathRetrievalRate => ({
  offeredTurns: 40,
  retrievedTurns: 10,
  rate: 0.25,
  guidance: {
    injected: { turns: 20, retrievedTurns: 7, rate: 0.35 },
    notInjected: { turns: 15, retrievedTurns: 3, rate: 0.2 },
    unrecorded: { turns: 5, retrievedTurns: 0, rate: 0 },
  },
  forcedSuppressed: {
    turns: 8,
    retrievedTurns: 4,
    rate: 0.5,
    byReason: { attached_files: 5, personal_corpus: 3 },
  },
  forcedTurns: 12,
  unclassifiedTurns: 7,
  answerability: {
    cutoff: 0.75,
    answerable: { turns: 18, retrievedTurns: 10, rate: 0.556 },
    notAnswerable: { turns: 15, retrievedTurns: 2, rate: 0.133 },
    unknown: { turns: 7, retrievedTurns: 0, rate: 0 },
    inconclusiveTurns: 0,
  },
  ...over,
});

const response = (over: Record<string, unknown> = {}) => ({
  data: {
    summary: summary(),
    window: {
      startDate: null,
      endDate: null,
      newestTurnAt: '2026-08-28T10:00:00.000Z',
      oldestTurnAt: '2026-08-01T10:00:00.000Z',
    },
    turnsScanned: 67,
    truncated: false,
    maxTurnsScanned: 50000,
    ...over,
  },
});

beforeEach(() => {
  mockGet.mockReset().mockResolvedValue(response());
});

describe('RetrievalRateTab', () => {
  it('renders the optional-path rate as a percentage over its denominator', async () => {
    renderTab();
    expect(await screen.findByText('25.0%')).toBeTruthy();
    expect(screen.getByText('10 of 40 offered turns')).toBeTruthy();
    // The suppressed bucket keeps its own rate rather than being folded into the headline.
    expect(screen.getByText('50.0%')).toBeTruthy();
    expect(screen.getByText('4 of 8 suppressed turns')).toBeTruthy();
  });

  it('breaks out why forced retrieval was suppressed', async () => {
    renderTab();
    expect((await screen.findByTestId('retrieval-rate-skip-attached-files')).textContent).toContain('5');
    expect(screen.getByTestId('retrieval-rate-skip-personal-corpus').textContent).toContain('3');
  });

  it('shows an empty state rather than a 0% rate when nothing is classifiable', async () => {
    // The distinction that matters: no population is not the same as nobody retrieving, and a
    // 0% headline would read as the latter.
    mockGet.mockResolvedValue(
      response({
        summary: summary({
          offeredTurns: 0,
          retrievedTurns: 0,
          rate: null,
          forcedSuppressed: {
            turns: 0,
            retrievedTurns: 0,
            rate: null,
            byReason: { attached_files: 0, personal_corpus: 0 },
          },
        }),
      })
    );
    renderTab();
    expect(await screen.findByTestId('retrieval-rate-empty')).toBeTruthy();
    expect(screen.queryByText('0.0%')).toBeNull();
    expect(screen.getAllByText('n/a').length).toBeGreaterThan(0);
  });

  it('does not claim the window is empty when only the rate populations are', async () => {
    // The banner is about the optional path, not the window. Forced turns can be plentiful while
    // there is still nothing that measures a declinable offer.
    mockGet.mockResolvedValue(
      response({
        summary: summary({
          offeredTurns: 0,
          retrievedTurns: 0,
          rate: null,
          forcedSuppressed: {
            turns: 0,
            retrievedTurns: 0,
            rate: null,
            byReason: { attached_files: 0, personal_corpus: 0 },
          },
          forcedTurns: 120,
        }),
      })
    );
    renderTab();
    const banner = await screen.findByTestId('retrieval-rate-empty');
    expect(banner.textContent).toContain('optional path');
    expect(banner.textContent).not.toContain('No classifiable turns');
    expect(screen.getByText('120')).toBeTruthy();
  });

  it('warns when the response only covers part of the requested window', async () => {
    mockGet.mockResolvedValue(response({ truncated: true, turnsScanned: 50000 }));
    renderTab();
    const banner = await screen.findByTestId('retrieval-rate-truncated');
    expect(banner.textContent).toContain('50,000');
  });

  it('surfaces a failed load instead of rendering an empty panel', async () => {
    mockGet.mockRejectedValue(new Error('boom'));
    renderTab();
    await waitFor(() => expect(screen.getByTestId('retrieval-rate-error').textContent).toContain('boom'));
  });

  it('renders the answerability split with the miss/waste figures the routing decision needs', async () => {
    renderTab();
    // Miss rate is hand-computed in the component (not read off the fold), so this pins the
    // arithmetic directly: 8 of 18 answerable turns went unsearched. Scoped to the section since
    // a bare '7' also matches the unrelated Unclassified card in this fixture.
    const section = await screen.findByTestId('retrieval-rate-answerability');
    expect(within(section).getByText('44.4%')).toBeTruthy();
    expect(within(section).getByText('8 of 18 answerable turns where the model did not search')).toBeTruthy();
    expect(within(section).getByText('13.3%')).toBeTruthy();
    expect(within(section).getByText('2 of 15 turns with nothing to find where it searched anyway')).toBeTruthy();
    expect(within(section).getByText('7')).toBeTruthy();
  });

  it('renders the rest of the panel when the response predates the answerability field', async () => {
    // A real shape, not a hypothetical: an API pod one deploy behind the client bundle returns
    // exactly this - the fold gained the field, but the response this request actually got did
    // not. The panel must degrade by omitting the section, not by crashing the whole tab.
    mockGet.mockResolvedValue(response({ summary: summary({ answerability: undefined }) }));
    renderTab();
    expect(await screen.findByText('25.0%')).toBeTruthy();
    expect(screen.queryByTestId('retrieval-rate-answerability')).toBeNull();
  });
});
