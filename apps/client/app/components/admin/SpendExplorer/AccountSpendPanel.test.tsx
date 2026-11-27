import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import {
  CreditHolderType,
  type SpendAccountRow,
  type SpendTimelineBucket,
  type SpendTimelineResponse,
} from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({ useSpendTimeline: vi.fn(), userFeatures: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock('./useSpendExplorer', () => ({ useSpendTimeline: (...args: unknown[]) => h.useSpendTimeline(...args) }));
vi.mock('./SpendChart', () => ({ SpendChart: () => null }));
vi.mock('./SpendBucketTable', () => ({ SpendBucketTable: () => null }));
vi.mock('./FeatureCostSection', () => ({
  UserFeaturesPanel: (props: unknown) => {
    h.userFeatures(props);
    return null;
  },
}));

import { AccountSpendPanel } from './AccountSpendPanel';

const theme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);

const RANGE = { from: new Date('2026-11-10T00:00:00Z'), to: new Date('2026-11-11T00:00:00Z') };

const ACCOUNT: SpendAccountRow = {
  accountId: 'user-1',
  name: 'User One',
  segment: 'customer',
  costUsd: 40,
  share: 1,
  requests: 4,
  createdAt: null,
  newInTop10: false,
  payers: [
    { ownerId: 'org-alpha', ownerType: CreditHolderType.Organization, name: 'Org Alpha', costUsd: 30 },
    { ownerId: 'user-1', ownerType: CreditHolderType.User, name: 'User One', costUsd: 10 },
  ],
};

const bucket = (start: string, series: Record<string, number>) => ({
  start,
  totalUsd: Object.values(series).reduce((a, b) => a + b, 0),
  series,
  baselineUsd: 0,
  isSpike: false,
  previousUsd: 0,
});
const TIMELINE: SpendTimelineResponse = {
  bucket: 'day',
  splitBy: 'model',
  seriesKeys: ['opus', 'haiku'],
  buckets: [
    bucket('2026-11-10T00:00:00.000Z', { haiku: 5, opus: 15 }),
    bucket('2026-11-11T00:00:00.000Z', { opus: 20 }),
  ],
  markers: [],
};

const renderPanel = (onClose = vi.fn()) => {
  render(<AccountSpendPanel account={ACCOUNT} range={RANGE} onClose={onClose} />, { wrapper: TestWrapper });
  return { onClose };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.useSpendTimeline.mockReturnValue({ data: TIMELINE, isLoading: false, isError: false });
});

describe('AccountSpendPanel', () => {
  it("shows the acting user's feature mix over the same range", () => {
    renderPanel();
    expect(h.userFeatures).toHaveBeenCalledWith({
      range: RANGE,
      userId: 'user-1',
      userName: 'User One',
      showProfileLink: false,
      testId: 'account-spend-features',
    });
  });

  it("requests the user's spend split by model over the drill range", () => {
    renderPanel();

    expect(h.useSpendTimeline).toHaveBeenCalledWith({ range: RANGE, splitBy: 'model', userId: 'user-1' });
  });

  it('sums the model mix across buckets, largest first', () => {
    renderPanel();

    const mix = screen.getByTestId('spend-account-model-mix');
    expect(mix).toHaveTextContent(/opus\s*\$35\.00/);
    expect(mix).toHaveTextContent(/haiku\s*\$5\.00/);
    expect(mix.textContent!.indexOf('opus')).toBeLessThan(mix.textContent!.indexOf('haiku'));
  });

  it('counts a bucket that arrives without a series object as zero', () => {
    const { series: _dropped, ...emptyBucket } = bucket('2026-11-11T00:00:00.000Z', {});
    h.useSpendTimeline.mockReturnValue({
      data: {
        ...TIMELINE,
        buckets: [bucket('2026-11-10T00:00:00.000Z', { haiku: 5, opus: 15 }), emptyBucket as SpendTimelineBucket],
      },
      isLoading: false,
      isError: false,
    });
    renderPanel();

    const mix = screen.getByTestId('spend-account-model-mix');
    expect(mix).toHaveTextContent(/opus\s*\$15\.00/);
    expect(mix).toHaveTextContent(/haiku\s*\$5\.00/);
  });

  it('links only the organizations that were billed', () => {
    renderPanel();

    expect(screen.getByTestId('spend-account-payer-link-org-alpha')).toHaveTextContent('Billed to Org Alpha');
    expect(screen.queryByTestId('spend-account-payer-link-user-1')).not.toBeInTheDocument();
  });

  it('closes back to all accounts', () => {
    const { onClose } = renderPanel();

    fireEvent.click(screen.getByTestId('spend-account-close-btn'));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows a notice when the spend fails to load', () => {
    h.useSpendTimeline.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderPanel();

    expect(screen.getByText('Could not load the spend for this account. Try again.')).toBeInTheDocument();
  });
});
