import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { UndoToastProvider } from './shared';
import SpendMonitorTab from './SpendMonitorTab';

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: getMock, post: postMock } }));
const user = vi.hoisted(() => ({
  currentUser: { isAdmin: true } as { isAdmin: boolean; adminPermissions?: string[] },
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: user.currentUser }) }));

const theme = extendTheme({ ...getThemeConfig() });

const USER_ID = 'a'.repeat(24);
const ORG_ID = 'b'.repeat(24);
const FREEZE_ID = 'f'.repeat(24);

const incident = (over: Record<string, unknown> = {}) => ({
  id: 'inc-1',
  rule: 'account_spike',
  scopeType: 'User',
  scopeId: USER_ID,
  status: 'open',
  severity: 'critical',
  openedAt: '2026-11-17T10:00:00.000Z',
  peakValue: 15_000,
  lastValue: 12_000,
  context: {},
  label: 'burner@example.com',
  frozen: false,
  ...over,
});

const overview = (over: Record<string, unknown> = {}) => ({
  incidents: [
    incident({
      autoPause: {
        mode: 'shadow',
        decidedAt: '2026-11-17T10:05:00.000Z',
        tier: 'standard',
        thresholdCredits: 10_000,
        valueCredits: 12_000,
      },
    }),
    incident({
      id: 'inc-2',
      severity: 'warning',
      scopeType: 'platform',
      scopeId: 'all',
      rule: 'platform_spike',
      label: null,
    }),
  ],
  platform: { lastHourCredits: 1_234, last24hCredits: 56_789, latestBucketStart: '2026-11-17T12:00:00.000Z' },
  autoPause: { mode: 'shadow', minCreditsByTier: { standard: 10_000, paid: 0, trusted: 0 } },
  ...over,
});

const freezeRow = (over: Record<string, unknown> = {}) => ({
  id: FREEZE_ID,
  scopeType: 'Organization',
  scopeId: ORG_ID,
  reason: 'Abnormal spend spike',
  actor: { kind: 'automatic', rule: 'account_spike' },
  frozenAt: '2026-11-17T09:00:00.000Z',
  label: 'Acme',
  ...over,
});

const mockGets = ({
  overviewData = overview(),
  freezes = { items: [freezeRow()], nextCursor: null },
}: { overviewData?: unknown; freezes?: unknown } = {}) =>
  getMock.mockImplementation(async (url: string) => ({
    data: url === '/api/admin/spend-monitor' ? overviewData : freezes,
  }));

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={theme}>
        <UndoToastProvider>
          <SpendMonitorTab />
        </UndoToastProvider>
      </CssVarsProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  user.currentUser = { isAdmin: true };
  getMock.mockReset();
  postMock.mockReset();
  mockGets();
});

describe('SpendMonitorTab', () => {
  it('renders the stats and both tables from the loaded data', async () => {
    renderTab();

    expect(await screen.findByTestId('spend-monitor-incident-row-inc-1')).toBeInTheDocument();
    const tiles = screen.getAllByTestId('admin-stat-tile').map(tile => tile.textContent ?? '');
    expect(tiles[0]).toContain('1,234');
    expect(tiles[1]).toContain('56,789');
    expect(tiles[2]).toContain('2');
    expect(tiles[2]).toContain('1 critical');
    expect(tiles[3]).toContain('1');
    expect(tiles[4]).toContain('Shadow');
    expect(tiles[4]).toContain('Standard 10,000 - Paid off - Trusted off');

    const incidentRow = screen.getByTestId('spend-monitor-incident-row-inc-1');
    expect(incidentRow).toHaveTextContent('burner@example.com');
    expect(incidentRow).toHaveTextContent('Spike');
    expect(incidentRow).toHaveTextContent('Critical');
    expect(incidentRow).toHaveTextContent('12,000');
    expect(screen.getByTestId('spend-monitor-incident-row-inc-2')).toHaveTextContent('Platform spike');

    const frozenRow = await screen.findByTestId(`spend-monitor-freeze-row-${FREEZE_ID}`);
    expect(frozenRow).toHaveTextContent('Acme');
    expect(frozenRow).toHaveTextContent('Organization');
    expect(frozenRow).toHaveTextContent('Automatic');
    expect(frozenRow).toHaveTextContent('Abnormal spend spike');
  });

  it('shows 200+ when more freezes exist than the page holds', async () => {
    mockGets({ freezes: { items: [freezeRow()], nextCursor: 'next' } });
    renderTab();

    await screen.findByTestId(`spend-monitor-freeze-row-${FREEZE_ID}`);
    expect(screen.getAllByTestId('admin-stat-tile')[3]).toHaveTextContent('1+');
  });

  it('labels each incident with its payer freeze state and the automatic decision', async () => {
    mockGets({
      overviewData: overview({
        incidents: [
          incident({
            id: 'shadow',
            autoPause: {
              mode: 'shadow',
              decidedAt: '2026-11-17T10:05:00.000Z',
              tier: 'standard',
              thresholdCredits: 1,
              valueCredits: 2,
            },
          }),
          incident({
            id: 'paused',
            frozen: true,
            autoPause: {
              mode: 'enforce',
              decidedAt: '2026-11-17T10:05:00.000Z',
              tier: 'standard',
              thresholdCredits: 1,
              valueCredits: 2,
              freezeId: FREEZE_ID,
            },
          }),
          incident({
            id: 'already',
            frozen: true,
            autoPause: {
              mode: 'enforce',
              decidedAt: '2026-11-17T10:05:00.000Z',
              tier: 'standard',
              thresholdCredits: 1,
              valueCredits: 2,
            },
          }),
          incident({
            id: 'lifted',
            autoPause: {
              mode: 'enforce',
              decidedAt: '2026-11-17T10:05:00.000Z',
              tier: 'standard',
              thresholdCredits: 1,
              valueCredits: 2,
              freezeId: FREEZE_ID,
            },
          }),
          incident({ id: 'manual', frozen: true }),
          incident({ id: 'none' }),
        ],
        autoPause: { mode: 'enforce', minCreditsByTier: { standard: 10_000, paid: 5_000, trusted: 0 } },
      }),
    });
    renderTab();

    expect(await screen.findByTestId('spend-monitor-autopause-shadow')).toHaveTextContent('Would pause');
    expect(screen.getByTestId('spend-monitor-autopause-paused')).toHaveTextContent('Paused');
    expect(screen.getByTestId('spend-monitor-autopause-already')).toHaveTextContent('Frozen');
    expect(screen.getByTestId('spend-monitor-autopause-lifted')).toHaveTextContent('Lifted');
    expect(screen.getByTestId('spend-monitor-autopause-manual')).toHaveTextContent('Frozen');
    expect(screen.queryByTestId('spend-monitor-autopause-none')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('admin-stat-tile')[4]).toHaveTextContent('Enforce');
    expect(screen.getAllByTestId('admin-stat-tile')[4]).toHaveTextContent('Paid 5,000');
  });

  it('freezes the typed scope with the chosen reason and offers undo', async () => {
    postMock.mockResolvedValue({ data: { freeze: freezeRow(), created: true } });
    renderTab();

    fireEvent.click(await screen.findByTestId('spend-monitor-freeze-btn'));
    const dialog = await screen.findByTestId('spend-monitor-freeze-dialog');
    expect(dialog).toHaveTextContent('Allowed');
    expect(dialog).toHaveTextContent('Paused');
    expect(screen.getByTestId('spend-monitor-freeze-dialog-confirm-btn')).toBeDisabled();

    fireEvent.click(screen.getByTestId('spend-monitor-freeze-scope-type-Organization'));
    fireEvent.change(screen.getByTestId('spend-monitor-freeze-scope-id'), { target: { value: 'not-an-id' } });
    expect(screen.getByTestId('spend-monitor-freeze-scope-id-error')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('spend-monitor-freeze-scope-id'), { target: { value: ORG_ID } });
    fireEvent.click(screen.getByTestId('spend-monitor-freeze-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('spend-monitor-freeze-dialog-confirm-btn'));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/admin/spend-freezes', {
        scopeType: 'Organization',
        scopeId: ORG_ID,
        reason: expect.stringContaining('Abnormal spend spike'),
      })
    );
    expect(await screen.findByTestId('undo-toast')).toBeInTheDocument();

    postMock.mockResolvedValue({ data: { freeze: freezeRow(), lifted: true } });
    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/admin/spend-freezes/lift', {
        scopeType: 'Organization',
        scopeId: ORG_ID,
        reason: 'Undo: freeze applied by mistake',
      })
    );
  });

  it('prefills the freeze dialog from an incident row', async () => {
    renderTab();

    fireEvent.click(await screen.findByTestId('spend-monitor-incident-actions-inc-1'));
    fireEvent.click(await screen.findByTestId('spend-monitor-incident-freeze-inc-1'));

    expect(await screen.findByTestId('spend-monitor-freeze-scope-id')).toHaveValue(USER_ID);
    expect(screen.getByTestId('spend-monitor-freeze-scope-type-User')).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers no row action on a platform incident', async () => {
    renderTab();

    await screen.findByTestId('spend-monitor-incident-row-inc-2');
    expect(screen.queryByTestId('spend-monitor-incident-actions-inc-2')).not.toBeInTheDocument();
  });

  it('says so, without an undo, when the account was already frozen', async () => {
    postMock.mockResolvedValue({ data: { freeze: freezeRow(), created: false } });
    renderTab();

    fireEvent.click(await screen.findByTestId('spend-monitor-incident-actions-inc-1'));
    fireEvent.click(await screen.findByTestId('spend-monitor-incident-freeze-inc-1'));
    fireEvent.click(await screen.findByTestId('spend-monitor-freeze-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('spend-monitor-freeze-dialog-confirm-btn'));

    expect(await screen.findByTestId('spend-monitor-notice')).toHaveTextContent('already frozen');
    expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument();
  });

  it('lifts a freeze and offers to freeze it again', async () => {
    postMock.mockResolvedValue({ data: { freeze: freezeRow(), lifted: true } });
    renderTab();

    fireEvent.click(await screen.findByTestId(`spend-monitor-freeze-actions-${FREEZE_ID}`));
    fireEvent.click(await screen.findByTestId(`spend-monitor-lift-${FREEZE_ID}`));
    const dialog = await screen.findByTestId('spend-monitor-lift-dialog');
    expect(within(dialog).getByTestId('spend-monitor-lift-preview')).toHaveTextContent('Paused');
    fireEvent.click(screen.getByTestId('spend-monitor-lift-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('spend-monitor-lift-dialog-confirm-btn'));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/admin/spend-freezes/lift', {
        scopeType: 'Organization',
        scopeId: ORG_ID,
        reason: expect.stringContaining('Reviewed: spend is legitimate'),
      })
    );

    postMock.mockResolvedValue({ data: { freeze: freezeRow(), created: true } });
    fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/admin/spend-freezes', {
        scopeType: 'Organization',
        scopeId: ORG_ID,
        reason: 'Undo: freeze lifted by mistake',
      })
    );
  });

  it('keeps freezing and lifting disabled for a delegate without credits:adjust', async () => {
    user.currentUser = { isAdmin: false, adminPermissions: ['support:read'] };
    renderTab();

    expect(await screen.findByTestId('spend-monitor-freeze-btn')).toBeDisabled();
    expect(await screen.findByTestId(`spend-monitor-freeze-actions-${FREEZE_ID}`)).toBeDisabled();
  });

  it('lets a credits:adjust delegate freeze', async () => {
    user.currentUser = { isAdmin: false, adminPermissions: ['credits:adjust'] };
    renderTab();

    expect(await screen.findByTestId('spend-monitor-freeze-btn')).toBeEnabled();
  });

  it('shows the empty states', async () => {
    mockGets({
      overviewData: overview({ incidents: [] }),
      freezes: { items: [], nextCursor: null },
    });
    renderTab();

    expect(await screen.findByText('No open incidents')).toBeInTheDocument();
    expect(await screen.findByText('No frozen accounts')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('spend-monitor-frozen-empty-btn'));
    expect(await screen.findByTestId('spend-monitor-freeze-dialog')).toBeInTheDocument();
  });

  it('shows an error state with retry when the overview fails', async () => {
    getMock.mockImplementation(async (url: string) => {
      if (url === '/api/admin/spend-monitor') throw new Error('boom');
      return { data: { items: [], nextCursor: null } };
    });
    renderTab();

    expect(await screen.findByText("Couldn't load spend incidents.")).toBeInTheDocument();
  });
});
