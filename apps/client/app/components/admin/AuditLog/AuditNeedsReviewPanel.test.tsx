import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { UndoToastProvider } from '../shared';
import { AuditNeedsReviewPanel } from './AuditNeedsReviewPanel';
import { makeAuditReview, makeReviewQueueEntry } from './shared/auditTestFixtures';

const mocks = vi.hoisted(() => ({
  currentUser: { id: 'me', isAdmin: true, adminPermissions: [] } as {
    id: string;
    isAdmin: boolean;
    adminPermissions: string[];
  },
  toReview: [] as unknown[],
  toReviewTotal: 0,
  all: [] as unknown[],
  markAsync: vi.fn(),
  unmarkAsync: vi.fn(),
  queueCalls: [] as Array<{ status: string; options: { from?: string; enabled?: boolean } }>,
}));

vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: mocks.currentUser }) }));
vi.mock('@client/app/hooks/data/adminAuditLog', () => ({
  useAuditSummary: () => ({ isError: false, data: { windowDays: 30, since: '2026-09-19T00:00:00.000Z' } }),
  useAuditReviewQueue: (status: string, options: { from?: string; enabled?: boolean }) => {
    mocks.queueCalls.push({ status, options });
    const unreviewed = status === 'unreviewed';
    return {
      data: {
        pages: [
          {
            entries: unreviewed ? mocks.toReview : mocks.all,
            nextCursor: null,
            total: unreviewed ? mocks.toReviewTotal : 0,
          },
        ],
      },
      isLoading: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: vi.fn(),
    };
  },
  useMarkAuditReviewed: () => ({ mutateAsync: mocks.markAsync, isPending: false }),
  useUnmarkAuditReviewed: () => ({ mutateAsync: mocks.unmarkAsync, isPending: false }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>
    <UndoToastProvider>{children}</UndoToastProvider>
  </CssVarsProvider>
);

const renderPanel = (onSelectEntry = vi.fn()) => {
  render(
    <AuditNeedsReviewPanel
      windowDays={30}
      alertStatus={{ alertsEnabled: true, singleGrantCredits: 50000, dailyGrantCredits: 200000 }}
      onSelectEntry={onSelectEntry}
    />,
    { wrapper: TestWrapper }
  );
  return { onSelectEntry };
};

const setQueue = (entries: ReturnType<typeof makeReviewQueueEntry>[], total = entries.length) => {
  mocks.toReview = entries;
  mocks.toReviewTotal = total;
};

describe('AuditNeedsReviewPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser = { id: 'me', isAdmin: true, adminPermissions: [] };
    mocks.all = [];
    mocks.queueCalls = [];
    setQueue([makeReviewQueueEntry({ id: 'c1' }), makeReviewQueueEntry({ id: 'c2' })]);
    mocks.markAsync.mockImplementation(async ({ entryIds }: { entryIds: string[] }) => ({
      reviewed: entryIds,
      skipped: [],
    }));
    mocks.unmarkAsync.mockResolvedValue({ unreviewed: [], skipped: [] });
  });

  it('shows how many entries wait for review, with the hint', () => {
    setQueue([makeReviewQueueEntry({ id: 'c1' }), makeReviewQueueEntry({ id: 'c2' })], 57);
    renderPanel();
    expect(screen.getByTestId('audit-needs-review-count').textContent).toBe('57 to review');
    expect(screen.getByTestId('audit-needs-review-hint').textContent).toContain('second pair of eyes');
    expect(screen.getByTestId('audit-needs-review-panel').textContent).toContain('above 50,000 credits');
  });

  it('collapses and says nothing to review when the queue is empty, and offers all critical', () => {
    setQueue([]);
    renderPanel();
    expect(screen.getByTestId('audit-needs-review-count').textContent).toBe('Nothing to review');
    expect(screen.queryByTestId('audit-needs-review-table-empty')).toBeNull();

    fireEvent.click(screen.getByTestId('audit-needs-review-toggle-btn'));
    expect(screen.getByTestId('audit-needs-review-table-empty').textContent).toContain('Nothing waiting for review');
    fireEvent.click(screen.getByTestId('audit-needs-review-show-all-btn'));
    expect(screen.getByTestId('audit-needs-review-view-all').getAttribute('aria-pressed')).toBe('true');
  });

  it('marks one entry from its row action without opening the drawer', async () => {
    const { onSelectEntry } = renderPanel();
    const row = screen.getByTestId('audit-needs-review-table-row-c1');
    fireEvent.click(within(row).getByTestId('audit-needs-review-row-mark-btn'));

    await waitFor(() => expect(mocks.markAsync).toHaveBeenCalledWith({ entryIds: ['c1'] }));
    expect(onSelectEntry).not.toHaveBeenCalled();
    expect((await screen.findByTestId('undo-toast-message')).textContent).toBe('Marked 1 as reviewed.');
  });

  it('marks the selected rows from the bulk bar and clears the selection', async () => {
    renderPanel();
    const checkboxes = within(screen.getByTestId('audit-needs-review-table-row-c1')).getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByTestId('audit-needs-review-bulk-mark-btn'));

    await waitFor(() => expect(mocks.markAsync).toHaveBeenCalledWith({ entryIds: ['c1'] }));
    await waitFor(() => expect(screen.queryByTestId('audit-needs-review-bulk-mark-btn')).toBeNull());
  });

  it('undoes a review by unmarking exactly the reviewed ids, and reports skipped entries', async () => {
    setQueue([
      makeReviewQueueEntry({ id: 'c1' }),
      makeReviewQueueEntry({ id: 'c2' }),
      makeReviewQueueEntry({ id: 'c3' }),
    ]);
    mocks.markAsync.mockResolvedValue({
      reviewed: ['c1'],
      skipped: [
        { id: 'c2', reason: 'already_reviewed' },
        { id: 'c3', reason: 'already_reviewed' },
      ],
    });
    renderPanel();
    for (const id of ['c1', 'c2', 'c3']) {
      fireEvent.click(within(screen.getByTestId(`audit-needs-review-table-row-${id}`)).getAllByRole('checkbox')[0]);
    }
    fireEvent.click(screen.getByTestId('audit-needs-review-bulk-mark-btn'));

    expect((await screen.findByTestId('undo-toast-message')).textContent).toBe(
      'Marked 1 as reviewed. 2 were already reviewed.'
    );
    expect(mocks.markAsync).toHaveBeenCalledTimes(1);
    const sent = (mocks.markAsync.mock.calls[0][0] as { entryIds: string[] }).entryIds;
    expect([...sent].sort()).toEqual(['c1', 'c2', 'c3']);

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await waitFor(() => expect(mocks.unmarkAsync).toHaveBeenCalledWith({ entryIds: ['c1'] }));
    expect(mocks.unmarkAsync).toHaveBeenCalledTimes(1);
  });

  it('words every skip reason in the toast, including entries about the viewer', async () => {
    mocks.markAsync.mockImplementation(async ({ entryIds }: { entryIds: string[] }) => ({
      reviewed: [],
      skipped: [
        { id: entryIds[0], reason: 'about_you' },
        { id: 'x1', reason: 'about_you' },
        { id: 'x2', reason: 'own_action' },
      ],
    }));
    renderPanel();
    fireEvent.click(
      within(screen.getByTestId('audit-needs-review-table-row-c1')).getByTestId('audit-needs-review-row-mark-btn')
    );

    expect((await screen.findByTestId('undo-toast-message')).textContent).toBe(
      'Nothing was marked as reviewed. 2 were about your own account, 1 was your own action.'
    );
  });

  it('says suspensions are critical in the rules copy', () => {
    renderPanel();
    expect(screen.getByTestId('audit-needs-review-panel').textContent).toContain('suspensions');
  });

  it('hides selection, bulk bar and row action for admins who cannot sign off', () => {
    mocks.currentUser = { id: 'me', isAdmin: false, adminPermissions: ['support:read'] };
    renderPanel();
    expect(screen.getByTestId('audit-needs-review-not-full-admin').textContent).toContain('Only full admins');
    expect(screen.queryByTestId('audit-needs-review-row-mark-btn')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByTestId('audit-needs-review-bulk-mark-btn')).toBeNull();
  });

  it('labels each entry in All critical by its review state', () => {
    mocks.all = [
      makeReviewQueueEntry({
        id: 'r1',
        review: makeAuditReview({ auditEntryId: 'r1', reviewer: { userId: 'u2', name: 'Rita Reviewer' } }),
      }),
      makeReviewQueueEntry({
        id: 'b1',
        review: makeAuditReview({ auditEntryId: 'b1', baseline: true, reviewer: { userId: null, name: 'Rollout' } }),
      }),
      makeReviewQueueEntry({
        id: 'm1',
        actor: { kind: 'user', scope: 'platform', userId: 'me', name: 'Me', wasAdmin: true },
      }),
      makeReviewQueueEntry({ id: 'n1' }),
      makeReviewQueueEntry({ id: 'a1', target: { kind: 'user', id: 'ME', displayName: 'Me' } }),
    ];
    renderPanel();
    fireEvent.click(screen.getByTestId('audit-needs-review-view-all'));

    expect(screen.getByTestId('audit-needs-review-status-r1').textContent).toBe('Reviewed');
    expect(screen.getByTestId('audit-needs-review-table-row-r1').textContent).toContain('by Rita Reviewer');
    expect(screen.getByTestId('audit-needs-review-status-b1').textContent).toBe('Baselined');
    expect(screen.getByTestId('audit-needs-review-status-m1').textContent).toBe('Your action');
    expect(screen.getByTestId('audit-needs-review-status-n1').textContent).toBe('Not reviewed');
    expect(screen.getByTestId('audit-needs-review-status-a1').textContent).toBe('About you');
    expect(screen.queryByTestId('audit-needs-review-row-mark-btn')).toBeNull();
    expect(
      mocks.queueCalls.some(call => call.status === 'all' && call.options.from === '2026-09-19T00:00:00.000Z')
    ).toBe(true);
  });
});
