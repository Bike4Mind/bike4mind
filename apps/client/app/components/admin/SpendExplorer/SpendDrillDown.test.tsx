import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import {
  CreditHolderType,
  type SpendAccountRow,
  type SpendAccountsResponse,
  type SpendTimelineBucket,
} from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { formatAccountAge, SpendDrillDown } from './SpendDrillDown';

const theme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);

const SPIKE_BUCKET: SpendTimelineBucket = {
  start: '2026-11-11T00:00:00.000Z',
  totalUsd: 30,
  series: { anthropic: 20, openai: 10 },
  baselineUsd: 10,
  isSpike: true,
  previousUsd: 12,
};

const account = (overrides: Partial<SpendAccountRow>): SpendAccountRow => ({
  accountId: 'acct-1',
  name: 'Account One',
  segment: 'customer',
  costUsd: 20,
  share: 2 / 3,
  requests: 40,
  createdAt: '2026-11-01T00:00:00.000Z',
  newInTop10: false,
  payers: [{ ownerId: 'acct-1', ownerType: CreditHolderType.User, name: 'Account One', costUsd: 20 }],
  ...overrides,
});

const ACCOUNTS: SpendAccountsResponse = {
  totalCostUsd: 30,
  byProvider: [
    { provider: 'anthropic', costUsd: 20 },
    { provider: 'openai', costUsd: 10 },
  ],
  bySegment: [
    { segment: 'customer', costUsd: 25 },
    { segment: 'internal', costUsd: 5 },
  ],
  accounts: [
    account({ accountId: 'acct-1', newInTop10: true }),
    account({
      accountId: 'acct-2',
      name: 'Account Two',
      segment: 'internal',
      costUsd: 10,
      share: 1 / 3,
      payers: [
        { ownerId: 'org-alpha', ownerType: CreditHolderType.Organization, name: 'Org Alpha', costUsd: 8 },
        { ownerId: 'acct-2', ownerType: CreditHolderType.User, name: 'Account Two', costUsd: 2 },
      ],
    }),
  ],
};

function renderDrillDown(props: Partial<Parameters<typeof SpendDrillDown>[0]> = {}) {
  const onSelectAccount = vi.fn();
  const onClear = vi.fn();
  render(
    <SpendDrillDown
      bucket={SPIKE_BUCKET}
      bucketSize="day"
      rangeLabel="Nov 5-18"
      accounts={ACCOUNTS}
      isLoading={false}
      error={undefined}
      onRetry={vi.fn()}
      onSelectAccount={onSelectAccount}
      onClear={onClear}
      {...props}
    />,
    { wrapper: TestWrapper }
  );
  return { onSelectAccount, onClear };
}

describe('SpendDrillDown', () => {
  it('shows a spike bucket with its multiple of the rolling median', () => {
    renderDrillDown();

    expect(screen.getByTestId('spend-drilldown-total')).toHaveTextContent('$30.00');
    expect(screen.getByTestId('spend-drilldown-multiple')).toHaveTextContent('3.0x the rolling median ($10.00)');
    expect(screen.getByTestId('spend-drilldown-status-chip')).toHaveTextContent('Spike');
  });

  it('marks a bucket within the median band as normal', () => {
    renderDrillDown({ bucket: { ...SPIKE_BUCKET, totalUsd: 11, isSpike: false } });

    expect(screen.getByTestId('spend-drilldown-status-chip')).toHaveTextContent('Normal');
  });

  it('breaks the bucket down by provider and account type', () => {
    renderDrillDown();

    expect(screen.getByTestId('spend-drilldown-provider-anthropic')).toHaveTextContent('$20.00');
    expect(screen.getByTestId('spend-drilldown-segment-internal')).toHaveTextContent('$5.00');
  });

  it('shows platform operations without fabricating a user account', () => {
    renderDrillDown({
      accounts: {
        totalCostUsd: 12,
        byProvider: [{ provider: 'anthropic', costUsd: 12 }],
        bySegment: [{ segment: 'platform', costUsd: 12 }],
        accounts: [],
      },
      bucket: null,
    });

    expect(screen.getByTestId('spend-drilldown-segment-platform')).toHaveTextContent('Platform operations');
    expect(screen.getByTestId('spend-drilldown-segment-platform')).toHaveTextContent('$12.00');
    expect(screen.getByText('No user-attributed spend in this window.')).toBeInTheDocument();
    expect(screen.queryByTestId('spend-drilldown-account-row-platform')).not.toBeInTheDocument();
    expect(screen.queryByText('No recorded spend in this window.')).not.toBeInTheDocument();
  });

  it('flags new top-10 accounts and tags non-customer accounts', () => {
    renderDrillDown();

    expect(screen.getByTestId('spend-drilldown-new-chip-acct-1')).toBeInTheDocument();
    expect(screen.queryByTestId('spend-drilldown-new-chip-acct-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('spend-drilldown-segment-chip-acct-2')).toHaveTextContent('Internal');
    expect(screen.queryByTestId('spend-drilldown-segment-chip-acct-1')).not.toBeInTheDocument();
  });

  it('shows who was billed: personal spend, or the org a team member billed to', () => {
    renderDrillDown();

    expect(screen.getByTestId('spend-drilldown-payer-acct-1')).toHaveTextContent('Personal');
    expect(screen.getByTestId('spend-drilldown-payer-acct-2')).toHaveTextContent('Org Alpha +1');
  });

  it('opens an account when its row is activated', () => {
    const { onSelectAccount } = renderDrillDown();

    fireEvent.click(screen.getByTestId('spend-drilldown-account-row-acct-2'));

    expect(onSelectAccount).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-2' }));
  });

  it('clears the bucket back to the whole range', () => {
    const { onClear } = renderDrillDown();

    fireEvent.click(screen.getByTestId('spend-drilldown-clear-btn'));

    expect(onClear).toHaveBeenCalledOnce();
  });

  it('covers the whole range without a status chip when no bucket is selected', () => {
    renderDrillDown({ bucket: null });

    expect(screen.getByTestId('spend-drilldown-total')).toHaveTextContent('$30.00');
    expect(screen.queryByTestId('spend-drilldown-status-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('spend-drilldown-clear-btn')).not.toBeInTheDocument();
  });
});

describe('SpendDrillDown states', () => {
  it('shows the error and retries from it', () => {
    const onRetry = vi.fn();
    renderDrillDown({ accounts: undefined, error: 'Could not load accounts: boom', onRetry });

    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Could not load accounts: boom');
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));

    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('says so when the window has no recorded spend', () => {
    renderDrillDown({ accounts: { ...ACCOUNTS, totalCostUsd: 0, accounts: [] } });

    expect(screen.getByText('No recorded spend in this window.')).toBeInTheDocument();
  });
});

describe('formatAccountAge', () => {
  const now = new Date('2026-11-18T00:00:00.000Z');

  it('uses days, months, then years', () => {
    expect(formatAccountAge('2026-11-13T00:00:00.000Z', now)).toBe('5d');
    expect(formatAccountAge('2026-08-18T00:00:00.000Z', now)).toBe('3mo');
    expect(formatAccountAge('2023-11-18T00:00:00.000Z', now)).toBe('3y');
    expect(formatAccountAge(null, now)).toBeNull();
  });
});
