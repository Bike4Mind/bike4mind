import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    byReason: { attached_files: 5, personal_corpus: 3, no_lake_scope: 2 },
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

const emptyWindow = () =>
  response({
    turnsScanned: 0,
    summary: summary({
      offeredTurns: 0,
      retrievedTurns: 0,
      rate: null,
      forcedSuppressed: {
        turns: 0,
        retrievedTurns: 0,
        rate: null,
        byReason: { attached_files: 0, personal_corpus: 0, no_lake_scope: 0 },
      },
      forcedTurns: 0,
      unclassifiedTurns: 0,
    }),
  });

beforeEach(() => {
  mockGet.mockReset().mockResolvedValue(response());
});

describe('RetrievalRateTab page frame', () => {
  it('opens with the Retrieval page header, then one toolbar row of filters, and no raw cards', async () => {
    const { container } = renderTab();
    await screen.findByText('25.0%');
    const root = screen.getByTestId('admin-retrieval-rate-tab');
    const header = screen.getByTestId('admin-page-header');

    expect(root.firstElementChild).toBe(header);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(/^Retrieval$/);
    expect(within(header).getByTestId('retrieval-rate-refresh-btn')).toBeInTheDocument();

    const filters = screen.getByTestId('retrieval-rate-filter-bar');
    expect(root.children[1]).toBe(filters);
    expect(within(filters).getByLabelText('Start date')).toHaveAttribute('type', 'date');
    expect(within(filters).getByLabelText('End date')).toHaveAttribute('type', 'date');
    expect(within(filters).getByLabelText('Answerable cutoff')).toHaveAttribute('type', 'number');
    expect(container.querySelector('.MuiCard-root')).toBeNull();
  });

  it('puts each group of numbers in one stat strip of tiles', async () => {
    renderTab();
    await screen.findByText('25.0%');
    const strips = screen.getAllByTestId('admin-stat-strip');
    expect(strips.map(strip => strip.getAttribute('aria-label'))).toEqual([
      'Retrieval rate',
      'Answerability split',
      'Guidance arms',
      'Suppression reasons',
    ]);
    const tiles = within(strips[0])
      .getAllByTestId('admin-stat-tile')
      .map(tile => tile.textContent);
    expect(tiles).toEqual([
      'Optional-path retrieval rate25.0%10 of 40 offered turns',
      'After a forced-retrieval skip50.0%4 of 8 suppressed turns',
      'Forced turns12Forced retrieval enabled, nothing suppressed it',
      'Unclassified7No mode recorded - pre-deploy turns, agent-mode runs, or a tool-only write',
    ]);
    // The grouped numbers are titled regions, not cards around a strip.
    const answerability = screen.getByTestId('retrieval-rate-answerability');
    expect(within(answerability).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Could the corpus have answered?'
    );
    expect(answerability.closest('.MuiSheet-variantOutlined')).toBeNull();
  });

  it('swaps a failed first load for an error state with a retry, and a failed refresh for a banner', async () => {
    mockGet.mockRejectedValueOnce(new Error('boom'));
    renderTab();
    const failed = await screen.findByTestId('admin-error-state');
    expect(failed).toHaveTextContent('Could not load the retrieval rate: boom');
    expect(screen.queryByTestId('admin-stat-strip')).toBeNull();

    fireEvent.click(within(failed).getByTestId('admin-error-retry-btn'));
    expect(await screen.findByText('25.0%')).toBeTruthy();
    expect(screen.queryByTestId('retrieval-rate-error')).toBeNull();

    mockGet.mockRejectedValueOnce(new Error('refresh failed'));
    fireEvent.click(screen.getByTestId('retrieval-rate-refresh-btn'));
    const banner = await screen.findByTestId('retrieval-rate-error');
    expect(banner).toHaveClass('MuiAlert-colorDanger');
    expect(banner).toHaveTextContent('refresh failed');
    expect(screen.queryByTestId('admin-error-state')).toBeNull();
    expect(screen.getByText('25.0%')).toBeTruthy();
  });

  it('shows an empty state for a window with no turns, with a way to clear applied dates', async () => {
    mockGet.mockResolvedValue(emptyWindow());
    renderTab();
    const empty = await screen.findByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No turns in this window');
    expect(screen.queryByTestId('retrieval-rate-clear-dates-btn')).toBeNull();
    expect(screen.queryByTestId('admin-stat-strip')).toBeNull();

    const startInput = screen.getByLabelText('Start date');
    const cutoffInput = screen.getByLabelText('Answerable cutoff');
    fireEvent.change(startInput, { target: { value: '2026-08-01' } });
    fireEvent.change(cutoffInput, { target: { value: '0.6' } });
    await waitFor(() =>
      expect(mockGet).toHaveBeenLastCalledWith('/api/admin/retrieval-rate?startDate=2026-08-01&answerableMinScore=0.6')
    );

    // Clearing the dates keeps the cutoff and asks for the default window right away, without the
    // typing pause, so the request is already out when the click returns.
    fireEvent.click(await screen.findByTestId('retrieval-rate-clear-dates-btn'));
    expect(mockGet).toHaveBeenLastCalledWith('/api/admin/retrieval-rate?answerableMinScore=0.6');
    await waitFor(() => expect(screen.queryByTestId('retrieval-rate-clear-dates-btn')).toBeNull());
    expect(startInput).toHaveValue('');
    expect(cutoffInput).toHaveValue(0.6);
  });

  it('applies the dates and the cutoff as they change, with no Apply button', async () => {
    renderTab();
    await screen.findByText('25.0%');
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('retrieval-rate-apply-btn')).toBeNull();
    expect(within(screen.getByTestId('retrieval-rate-filter-bar')).queryByRole('button')).toBeNull();

    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-08-28' } });
    await waitFor(() => expect(mockGet).toHaveBeenLastCalledWith('/api/admin/retrieval-rate?endDate=2026-08-28'));

    // Typing a cutoff runs one fold for the finished number, not one per keystroke.
    const cutoff = screen.getByLabelText('Answerable cutoff');
    for (const value of ['0', '0.', '0.3', '0.35']) fireEvent.change(cutoff, { target: { value } });
    await waitFor(() =>
      expect(mockGet).toHaveBeenLastCalledWith('/api/admin/retrieval-rate?endDate=2026-08-28&answerableMinScore=0.35')
    );
    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  it('spins only the header Refresh while a refresh is in flight', async () => {
    renderTab();
    await screen.findByText('25.0%');
    const refresh = screen.getByTestId('retrieval-rate-refresh-btn');
    expect(refresh).not.toHaveClass('MuiButton-loading');

    mockGet.mockReturnValueOnce(new Promise(() => undefined));
    fireEvent.click(refresh);
    await waitFor(() => expect(refresh).toHaveClass('MuiButton-loading'));
    const spinners = Array.from(document.querySelectorAll('.MuiCircularProgress-root'));
    expect(spinners.length).toBeGreaterThan(0);
    for (const spinner of spinners) expect(refresh).toContainElement(spinner as HTMLElement);
    expect(screen.getByText('25.0%')).toBeTruthy();
  });
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
    expect(screen.getByTestId('retrieval-rate-skip-no-lake-scope').textContent).toContain('2');
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
            byReason: { attached_files: 0, personal_corpus: 0, no_lake_scope: 0 },
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
            byReason: { attached_files: 0, personal_corpus: 0, no_lake_scope: 0 },
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

  it('renders the guidance A/B arms and the lift between them', async () => {
    renderTab();
    // The lift is hand-computed in the component, so this pins the arithmetic and the sign:
    // 35.0% with the section against 20.0% without it. Scoped to the section because the arm
    // denominators overlap other cards in this fixture.
    const section = await screen.findByTestId('retrieval-rate-guidance');
    expect(within(section).getByText('+15.0 pp')).toBeTruthy();
    expect(within(section).getByText('35.0%')).toBeTruthy();
    expect(within(section).getByText('7 of 20 turns carrying the section')).toBeTruthy();
    expect(within(section).getByText('20.0%')).toBeTruthy();
    expect(within(section).getByText('3 of 15 turns with the setting cleared')).toBeTruthy();
    // Pre-flag turns are their own arm, not the control group.
    expect(within(section).getByText('5')).toBeTruthy();
  });

  it('signs a lift that went the wrong way rather than dropping the sign', async () => {
    mockGet.mockResolvedValue(
      response({
        summary: summary({
          guidance: {
            injected: { turns: 20, retrievedTurns: 4, rate: 0.2 },
            notInjected: { turns: 20, retrievedTurns: 7, rate: 0.35 },
            unrecorded: { turns: 5, retrievedTurns: 0, rate: 0 },
          },
        }),
      })
    );
    renderTab();
    const section = await screen.findByTestId('retrieval-rate-guidance');
    expect(within(section).getByText('-15.0 pp')).toBeTruthy();
  });

  it('distinguishes a measured no-effect from an unmeasurable one', async () => {
    // The pair to the empty-control case below: both arms ran, and the section moved nothing. That
    // has to read as a result (+0.0 pp), never as the n/a an absent arm gets.
    mockGet.mockResolvedValue(
      response({
        summary: summary({
          guidance: {
            injected: { turns: 20, retrievedTurns: 4, rate: 0.2 },
            notInjected: { turns: 15, retrievedTurns: 3, rate: 0.2 },
            unrecorded: { turns: 5, retrievedTurns: 0, rate: 0 },
          },
        }),
      })
    );
    renderTab();
    const section = await screen.findByTestId('retrieval-rate-guidance');
    expect(within(section).getByText('+0.0 pp')).toBeTruthy();
    expect(within(section).queryByText('n/a')).toBeNull();
  });

  it('reports an absent control arm instead of a zero lift', async () => {
    // The failure this guards: nobody has cleared the setting, so there is no comparison - which
    // must not render as "the section was tried and moved nothing".
    mockGet.mockResolvedValue(
      response({
        summary: summary({
          guidance: {
            injected: { turns: 35, retrievedTurns: 7, rate: 0.2 },
            notInjected: { turns: 0, retrievedTurns: 0, rate: null },
            unrecorded: { turns: 5, retrievedTurns: 0, rate: 0 },
          },
        }),
      })
    );
    renderTab();
    const alert = await screen.findByTestId('retrieval-rate-guidance-no-control');
    expect(alert.textContent).toContain('KnowledgeBaseRetrievalPrompt');
    const section = screen.getByTestId('retrieval-rate-guidance');
    expect(within(section).queryByText('+0.0 pp')).toBeNull();
    // The treatment arm is the live rate and stays readable without a control to compare it to.
    expect(within(section).getByText('7 of 35 turns carrying the section')).toBeTruthy();
  });

  it('does not ask for a control arm when there is no optional-path traffic at all', async () => {
    // An empty window is not a one-armed experiment, and telling the operator to clear a setting
    // would send them after traffic that does not exist.
    mockGet.mockResolvedValue(
      response({
        summary: summary({
          offeredTurns: 0,
          retrievedTurns: 0,
          rate: null,
          guidance: {
            injected: { turns: 0, retrievedTurns: 0, rate: null },
            notInjected: { turns: 0, retrievedTurns: 0, rate: null },
            unrecorded: { turns: 0, retrievedTurns: 0, rate: null },
          },
        }),
      })
    );
    renderTab();
    await screen.findByTestId('retrieval-rate-guidance');
    expect(screen.queryByTestId('retrieval-rate-guidance-no-control')).toBeNull();
  });

  it('renders the rest of the panel when the response predates the guidance field', async () => {
    // Same shape as the answerability case below: the fold always emits `guidance`, but a response
    // from an API pod behind the client bundle does not have to.
    mockGet.mockResolvedValue(response({ summary: summary({ guidance: undefined }) }));
    renderTab();
    expect(await screen.findByText('25.0%')).toBeTruthy();
    expect(screen.queryByTestId('retrieval-rate-guidance')).toBeNull();
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
