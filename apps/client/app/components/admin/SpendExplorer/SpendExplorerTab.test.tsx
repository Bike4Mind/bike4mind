import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { SpendTimelineResponse } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
  useSpendTimeline: vi.fn(),
  useSpendAccounts: vi.fn(),
  timelineRefetch: vi.fn(),
  featureSection: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => h.search,
  useNavigate: () => h.navigate,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock('./useSpendExplorer', () => ({
  useSpendTimeline: (...args: unknown[]) => h.useSpendTimeline(...args),
  useSpendAccounts: (...args: unknown[]) => h.useSpendAccounts(...args),
}));
vi.mock('./SpendChart', () => ({
  SpendChart: ({ data, onSelectBucket }: { data: SpendTimelineResponse; onSelectBucket: (start: string) => void }) => (
    <button data-testid="stub-chart-bucket" onClick={() => onSelectBucket(data.buckets[0].start)}>
      bucket
    </button>
  ),
}));
vi.mock('./SpendBucketTable', () => ({ SpendBucketTable: () => null }));
vi.mock('./AccountSpendPanel', () => ({ AccountSpendPanel: () => null }));
vi.mock('./FeatureCostSection', () => ({
  FeatureCostSection: (props: unknown) => {
    h.featureSection(props);
    return null;
  },
}));
vi.mock('./SpendDrillDown', () => ({ SpendDrillDown: () => <div data-testid="stub-drilldown" /> }));

import SpendExplorerTab from './SpendExplorerTab';

const theme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);

const BUCKET_START = '2026-11-10T00:00:00.000Z';
const TIMELINE: SpendTimelineResponse = {
  bucket: 'day',
  splitBy: 'provider',
  seriesKeys: ['anthropic'],
  buckets: [
    { start: BUCKET_START, totalUsd: 5, series: { anthropic: 5 }, baselineUsd: 0, isSpike: false, previousUsd: 0 },
  ],
  markers: [],
};

const accountsResult = { data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() };
const iso = (value: unknown) => (value as Date).toISOString();

/** The patch the page writes, recovered from the `search` updater it passed to navigate. */
function lastPatch(previous: Record<string, unknown> = {}) {
  const { search } = h.navigate.mock.calls.at(-1)![0] as {
    search: (p: Record<string, unknown>) => Record<string, unknown>;
  };
  return search(previous);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-18T12:00:00Z') });
  vi.clearAllMocks();
  h.search = {};
  h.useSpendTimeline.mockReturnValue({ data: TIMELINE, isError: false, error: null, refetch: h.timelineRefetch });
  h.useSpendAccounts.mockReturnValue(accountsResult);
});

afterEach(() => {
  vi.useRealTimers();
});

const renderTab = () => render(<SpendExplorerTab />, { wrapper: TestWrapper });

describe('SpendExplorerTab drill window', () => {
  it('compares the whole range with the previous period when no bucket is selected', () => {
    h.search = { spendRange: '7' };
    renderTab();

    const drill = h.useSpendAccounts.mock.calls.find(([params]) => params.compare)![0];
    expect(iso(drill.range.from)).toBe('2026-11-12T00:00:00.000Z');
    expect(iso(drill.range.to)).toBe('2026-11-19T00:00:00.000Z');
    expect(iso(drill.compare.from)).toBe('2026-11-05T00:00:00.000Z');
    expect(iso(drill.compare.to)).toBe('2026-11-12T00:00:00.000Z');
  });

  it('drills into the selected bucket and compares it with its baseline window', () => {
    h.search = { spendRange: '14', spendAt: BUCKET_START };
    renderTab();

    const drill = h.useSpendAccounts.mock.calls.find(([params]) => params.compare)![0];
    expect(iso(drill.range.from)).toBe('2026-11-10T00:00:00.000Z');
    expect(iso(drill.range.to)).toBe('2026-11-11T00:00:00.000Z');
    expect(iso(drill.compare.from)).toBe('2026-11-03T00:00:00.000Z');
    expect(iso(drill.compare.to)).toBe('2026-11-10T00:00:00.000Z');
  });
});

describe('SpendExplorerTab URL writes', () => {
  it('a preset clears the custom dates and the selected bucket', () => {
    h.search = { spendRange: 'custom', spendFrom: '2026-11-01', spendTo: '2026-11-05', spendAt: BUCKET_START };
    renderTab();

    fireEvent.click(screen.getByTestId('spend-explorer-range-30'));

    expect(lastPatch({ spendSplit: 'model' })).toEqual({
      spendSplit: 'model',
      spendRange: '30',
      spendFrom: undefined,
      spendTo: undefined,
      spendAt: undefined,
    });
  });

  it('applying a custom range writes both dates and clears the selected bucket', () => {
    renderTab();

    fireEvent.click(screen.getByTestId('spend-explorer-range-custom'));
    fireEvent.change(screen.getByTestId('spend-explorer-custom-from-input'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByTestId('spend-explorer-custom-to-input'), { target: { value: '2026-11-05' } });
    fireEvent.click(screen.getByTestId('spend-explorer-custom-apply-btn'));

    expect(lastPatch()).toEqual({
      spendRange: 'custom',
      spendFrom: '2026-11-01',
      spendTo: '2026-11-05',
      spendAt: undefined,
    });
  });

  it('selecting a bucket writes its start to the URL', () => {
    renderTab();

    fireEvent.click(screen.getByTestId('stub-chart-bucket'));

    expect(lastPatch()).toEqual({ spendAt: BUCKET_START });
  });
});

describe('SpendExplorerTab error paths', () => {
  it('says the copy failed when the clipboard rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    renderTab();

    fireEvent.click(screen.getByTestId('spend-explorer-copy-summary-btn'));

    await waitFor(() => expect(screen.getByTestId('spend-explorer-copy-summary-btn')).toHaveTextContent('Copy failed'));
    consoleError.mockRestore();
  });

  it('shows the timeline error and refetches on retry', () => {
    h.useSpendTimeline.mockReturnValue({
      data: undefined,
      isError: true,
      error: new Error('boom'),
      refetch: h.timelineRefetch,
    });
    renderTab();

    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Could not load spend: boom');
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));

    expect(h.timelineRefetch).toHaveBeenCalledOnce();
  });
});

describe('SpendExplorerTab feature section', () => {
  type SectionProps = {
    selection: { audience: string; feature: string | null; user: string | null };
    onChange: (patch: Record<string, unknown>) => void;
  };
  const sectionProps = () => h.featureSection.mock.calls.at(-1)![0] as SectionProps;

  it('reads the audience, feature and user from the URL', () => {
    h.search = { spendAudience: 'internal', spendFeature: 'music_generation', spendUser: 'u'.repeat(24) };
    renderTab();
    expect(sectionProps().selection).toEqual({
      audience: 'internal',
      feature: 'music_generation',
      user: 'u'.repeat(24),
    });
  });

  it('falls back to everyone for an unknown audience', () => {
    h.search = { spendAudience: 'staff' };
    renderTab();
    expect(sectionProps().selection).toEqual({ audience: 'all', feature: null, user: null });
  });

  it('writes selection changes to the URL, dropping the default audience', () => {
    renderTab();
    sectionProps().onChange({ audience: 'external' });
    expect(lastPatch()).toMatchObject({ spendAudience: 'external' });
    sectionProps().onChange({ audience: 'all', feature: null });
    expect(lastPatch({ spendAudience: 'external', spendFeature: 'chat' })).toMatchObject({
      spendAudience: undefined,
      spendFeature: undefined,
    });
  });
});
