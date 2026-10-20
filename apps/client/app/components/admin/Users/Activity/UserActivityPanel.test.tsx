import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { UserCreditHistory } from '@bike4mind/common';
import { makeAuditEntry } from '@client/app/components/admin/AuditLog/shared/auditTestFixtures';
import { UserActivityPanel } from './UserActivityPanel';
import { buildChartPoints } from './UserCreditBalanceChart';

const USER_ID = 'user-1';

const mocks = vi.hoisted(() => ({
  activityCalls: [] as Array<{ direction: string; includeSecurity: boolean; enabled?: boolean }>,
  actorViewAvailable: false,
  targetEntries: [] as unknown[],
  actorEntries: [] as unknown[],
  history: undefined as unknown,
}));

vi.mock('@client/app/hooks/data/adminUserActivity', () => ({
  useUserActivity: (
    _userId: string,
    options: { direction: 'target' | 'actor'; includeSecurity: boolean; enabled?: boolean }
  ) => {
    mocks.activityCalls.push(options);
    const entries = options.direction === 'target' ? mocks.targetEntries : mocks.actorEntries;
    return {
      data: { pages: [{ entries, nextCursor: null, actorViewAvailable: mocks.actorViewAvailable }] },
      isLoading: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    };
  },
  useUserCreditHistory: () => ({ data: mocks.history, isLoading: false, isError: false }),
}));

const history = (overrides: Partial<UserCreditHistory> = {}): UserCreditHistory => ({
  windowDays: 90,
  currentBalance: 125,
  points: [
    { day: '2026-10-19', balance: 100 },
    { day: '2026-10-20', balance: 125 },
  ],
  adjustments: [],
  adjustmentsTruncated: false,
  unreliableBefore: null,
  ...overrides,
});

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPanel = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <UserActivityPanel userId={USER_ID} />
    </CssVarsProvider>
  );

const lastCallFor = (direction: string) => mocks.activityCalls.filter(call => call.direction === direction).at(-1);

beforeEach(() => {
  mocks.activityCalls.length = 0;
  mocks.actorViewAvailable = false;
  mocks.targetEntries = [makeAuditEntry({ id: 'a'.repeat(24), summary: 'Granted 100 credits' })];
  mocks.actorEntries = [makeAuditEntry({ id: 'b'.repeat(24), summary: 'Changed a role' })];
  mocks.history = history();
});

describe('UserActivityPanel', () => {
  it('shows only changes to the account when the user has no admin history', () => {
    renderPanel();

    expect(screen.queryByTestId('user-activity-direction')).toBeNull();
    expect(screen.getByText('Changes to this account')).toBeTruthy();
    expect(screen.getByText('Granted 100 credits')).toBeTruthy();
    expect(screen.queryByText('Changed a role')).toBeNull();
    expect(lastCallFor('actor')?.enabled).toBe(false);
  });

  it('switches to the actions-by-this-user list without mixing in the other direction', () => {
    mocks.actorViewAvailable = true;
    renderPanel();

    fireEvent.click(screen.getByTestId('user-activity-direction-actor-btn'));

    expect(screen.getByText('Changed a role')).toBeTruthy();
    expect(screen.queryByText('Granted 100 credits')).toBeNull();
    expect(lastCallFor('actor')?.enabled).toBe(true);
    // Security events only belong to the target direction.
    expect(screen.queryByTestId('user-activity-security-switch')).toBeNull();
  });

  it('requests security events only once the toggle is switched on', () => {
    renderPanel();
    expect(lastCallFor('target')?.includeSecurity).toBe(false);

    const toggle = within(screen.getByTestId('user-activity-security-switch')).getByRole('switch');
    fireEvent.click(toggle);

    expect(lastCallFor('target')?.includeSecurity).toBe(true);
  });

  it('links to the Audit Log with the current direction carried over as a filter', () => {
    mocks.actorViewAvailable = true;
    renderPanel();

    const link = () => screen.getByTestId('user-activity-open-in-log-link').getAttribute('href') ?? '';
    expect(link()).toContain('targetKind=user');
    expect(link()).toContain(`targetId=${USER_ID}`);

    fireEvent.click(screen.getByTestId('user-activity-direction-actor-btn'));
    expect(link()).toContain(`actorUserId=${USER_ID}`);
    expect(link()).not.toContain('targetId=');
  });

  it('offers Open in Audit Log in the drawer for admin entries but not for security events', () => {
    mocks.targetEntries = [
      makeAuditEntry({ id: 'a'.repeat(24), summary: 'Granted 100 credits' }),
      makeAuditEntry({ id: 'c'.repeat(24), source: 'auth', summary: 'Login success' }),
    ];
    renderPanel();

    fireEvent.click(screen.getByTestId(`audit-table-row-${'a'.repeat(24)}`));
    expect(screen.getByTestId('audit-drawer-open-in-log-link').getAttribute('href')).toContain(
      `entryId=${'a'.repeat(24)}`
    );

    fireEvent.click(screen.getByTestId(`audit-table-row-${'c'.repeat(24)}`));
    expect(screen.queryByTestId('audit-drawer-open-in-log-link')).toBeNull();
  });

  it('says on the chart when the ledger may be incomplete', () => {
    mocks.history = history({ unreliableBefore: '2026-10-20T12:00:00.000Z' });
    renderPanel();

    expect(screen.getByTestId('user-credit-chart-unreliable-note').textContent).toMatch(/may be incomplete/);
  });

  it('omits the ledger note when the whole window is reliable', () => {
    renderPanel();
    expect(screen.queryByTestId('user-credit-chart-unreliable-note')).toBeNull();
  });
});

describe('buildChartPoints', () => {
  it('places a marker on the day of each admin adjustment and nowhere else', () => {
    const adjustment = {
      transactionId: 'tx-1',
      occurredAt: '2026-10-20T08:00:00.000Z',
      credits: 25,
      actorName: 'Root',
    };
    const points = buildChartPoints(history({ adjustments: [adjustment] }));

    expect(points[0]).toMatchObject({ day: '2026-10-19', markerBalance: undefined, adjustments: [] });
    expect(points[1]).toMatchObject({ day: '2026-10-20', markerBalance: 125, adjustments: [adjustment] });
  });
});
