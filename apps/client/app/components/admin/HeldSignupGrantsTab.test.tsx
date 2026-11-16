import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import HeldSignupGrantsTab from './HeldSignupGrantsTab';

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: getMock, post: postMock } }));
const user = vi.hoisted(() => ({
  currentUser: { isAdmin: true } as { isAdmin: boolean; adminPermissions?: string[] },
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: user.currentUser }) }));

const theme = extendTheme({ ...getThemeConfig() });
const rows = ['a', 'b'].map(letter => ({
  id: letter.repeat(24),
  email: `${letter}@example.test`,
  reason: 'budget_exhausted',
  createdAt: '2026-01-01T00:00:00.000Z',
}));

// hidden: the release dialog is modal and keeps the table aria-hidden while a release is in flight.
const rowCheckbox = (id: string) =>
  within(screen.getByTestId(`admin-table-select-${id}`)).getByRole('checkbox', { hidden: true });
const selectRow = async (id: string) => {
  await screen.findByTestId(`admin-table-select-${id}`);
  fireEvent.click(rowCheckbox(id));
};
const confirmRelease = async () => {
  fireEvent.click(await screen.findByTestId('held-signup-grants-release-btn'));
  fireEvent.click(await screen.findByTestId('held-signup-grants-release-dialog-reason-input-preset-0'));
  fireEvent.click(screen.getByTestId('held-signup-grants-release-dialog-confirm-btn'));
};
const confirmRevoke = async () => {
  fireEvent.click(await screen.findByTestId('held-signup-grants-revoke-dialog-reason-input-preset-0'));
  fireEvent.click(screen.getByTestId('held-signup-grants-revoke-confirm-btn'));
};

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={theme}>
        <HeldSignupGrantsTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return invalidate;
}

// For a dialog already open, e.g. after an override.
const confirmReleaseDialog = async () => {
  fireEvent.click(await screen.findByTestId('held-signup-grants-release-dialog-reason-input-preset-0'));
  fireEvent.click(screen.getByTestId('held-signup-grants-release-dialog-confirm-btn'));
};

const advisory = (over: Record<string, unknown> = {}) => ({
  assessmentId: 'c'.repeat(24),
  detectionId: 'd1',
  detector: 'signupNetworkBurst',
  result: 'abuse',
  confidence: 0.9,
  assessedAt: '2026-11-02T10:00:00.000Z',
  otherVerdicts: 0,
  newerVerdicts: 0,
  ...over,
});

beforeEach(() => {
  user.currentUser = { isAdmin: true };
  getMock.mockReset().mockResolvedValue({ data: { data: rows, nextCursor: null } });
  postMock.mockReset();
});

describe('HeldSignupGrantsTab', () => {
  it('lets a support:read delegate see the held list but not release it', async () => {
    user.currentUser = { isAdmin: false, adminPermissions: ['support:read'] };
    renderTab();
    await selectRow(rows[0].id);
    expect(screen.getByTestId('held-signup-grants-release-btn')).toBeDisabled();
  });

  it('lets a credits:adjust delegate release', async () => {
    user.currentUser = { isAdmin: false, adminPermissions: ['credits:adjust'] };
    renderTab();
    await selectRow(rows[0].id);
    expect(screen.getByTestId('held-signup-grants-release-btn')).not.toBeDisabled();
  });

  it('shows the bulk bar only once a row is selected', async () => {
    renderTab();
    await screen.findByTestId(`admin-table-select-${rows[0].id}`);
    expect(screen.queryByTestId('held-signup-grants-release-btn')).not.toBeInTheDocument();
    await selectRow(rows[0].id);
    expect(screen.getByTestId('held-signup-grants-release-btn')).toBeEnabled();
  });

  it('releases only after the dialog is confirmed, with every selected id', async () => {
    postMock.mockResolvedValue({ data: { batchId: 'batch-1', results: [] } });
    renderTab();
    await selectRow(rows[0].id);
    await selectRow(rows[1].id);
    fireEvent.click(screen.getByTestId('held-signup-grants-release-btn'));
    expect(await screen.findByTestId('held-signup-grants-release-dialog')).toHaveTextContent('Pay 2 held grants');
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('held-signup-grants-release-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('held-signup-grants-release-dialog-confirm-btn'));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/admin/held-signup-grants/release', {
        userIds: [rows[0].id, rows[1].id],
        reason: expect.stringContaining('Goodwill grant'),
      })
    );
  });

  it('keeps rows ticked while a release is in flight selected', async () => {
    let resolve!: (v: unknown) => void;
    postMock.mockReturnValue(
      new Promise(r => {
        resolve = r;
      })
    );
    renderTab();
    await selectRow(rows[0].id);
    await confirmRelease();
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/admin/held-signup-grants/release', {
        userIds: [rows[0].id],
        reason: expect.stringContaining('Goodwill grant'),
      })
    );

    await selectRow(rows[1].id);
    resolve({ data: { batchId: 'batch-1', results: [] } });
    await waitFor(() => {
      expect(rowCheckbox(rows[0].id)).not.toBeChecked();
      expect(rowCheckbox(rows[1].id)).toBeChecked();
    });
  });

  it('shows an empty state with a way out', async () => {
    getMock.mockResolvedValue({ data: { data: [], nextCursor: null } });
    renderTab();
    expect(await screen.findByTestId('admin-empty-state')).toHaveTextContent('No signup grants are held');
    fireEvent.click(screen.getByTestId('held-signup-grants-empty-action'));
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    expect(getMock).toHaveBeenLastCalledWith('/api/admin/held-signup-grants', { params: {} });
  });

  it('clears the reason filter from the empty state', async () => {
    renderTab();
    await screen.findByTestId(`admin-table-select-${rows[0].id}`);
    getMock.mockResolvedValue({ data: { data: [], nextCursor: null } });
    fireEvent.click(await screen.findByTestId('admin-filter-reason'));
    fireEvent.click(await screen.findByTestId('admin-filter-reason-budget_exhausted'));
    await waitFor(() =>
      expect(getMock).toHaveBeenLastCalledWith(expect.any(String), {
        params: { reason: 'budget_exhausted' },
      })
    );
    fireEvent.click(await screen.findByTestId('held-signup-grants-empty-action'));
    await waitFor(() => expect(getMock).toHaveBeenLastCalledWith(expect.any(String), { params: {} }));
  });

  it('keeps release blocked until a reason is entered', async () => {
    renderTab();
    await selectRow(rows[1].id);
    fireEvent.click(screen.getByTestId('held-signup-grants-release-btn'));
    const confirm = await screen.findByTestId('held-signup-grants-release-dialog-confirm-btn');
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('held-signup-grants-release-dialog-reason-input-preset-0'));
    expect(confirm).not.toBeDisabled();
  });

  it('releases the selected grants, then revokes that batch', async () => {
    postMock
      .mockResolvedValueOnce({
        data: { batchId: 'batch-1', results: [{ userId: rows[1].id, outcome: 'released', credits: 12 }] },
      })
      .mockResolvedValueOnce({
        data: {
          batchId: 'batch-1',
          results: [{ userId: rows[1].id, outcome: 'reversed', credits: 12, heldRestored: true }],
        },
      });
    const invalidate = renderTab();
    await selectRow(rows[1].id);
    await confirmRelease();
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/admin/held-signup-grants/release', {
        userIds: [rows[1].id],
        reason: expect.stringContaining('Goodwill grant'),
      })
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'signup-grants'] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'action-counts'] });
    invalidate.mockClear();
    fireEvent.click(await screen.findByTestId('held-signup-grants-revoke-btn'));
    expect(await screen.findByTestId('held-signup-grants-revoke-dialog')).toHaveTextContent(
      'returns the accounts to the held list'
    );
    expect(postMock).toHaveBeenCalledTimes(1);
    await confirmRevoke();
    await waitFor(() =>
      expect(postMock).toHaveBeenLastCalledWith('/api/admin/held-signup-grants/revoke', { batchId: 'batch-1' })
    );
    expect(await screen.findByTestId('held-signup-grants-revoke-result')).toHaveTextContent('Revoked 1 of 1');
    expect(screen.getByTestId('held-signup-grants-revoke-btn')).toBeDisabled();
    expect(getMock).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'signup-grants'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'action-counts'] });
  });

  it('says when an account was left alone because it was granted more since the release', async () => {
    postMock
      .mockResolvedValueOnce({
        data: { batchId: 'batch-1', results: [{ userId: rows[1].id, outcome: 'released', credits: 12 }] },
      })
      .mockResolvedValueOnce({
        data: { batchId: 'batch-1', results: [{ userId: rows[1].id, outcome: 'state_changed', credits: 12 }] },
      });
    renderTab();
    await selectRow(rows[1].id);
    await confirmRelease();
    fireEvent.click(await screen.findByTestId('held-signup-grants-revoke-btn'));
    await confirmRevoke();
    expect(await screen.findByTestId('held-signup-grants-revoke-result')).toHaveTextContent(
      'Revoked 0 of 1 grants. Accounts that received more credits since the release were left as they are.'
    );
  });

  it('says when a release saved no account state, so only the credits were taken back', async () => {
    postMock
      .mockResolvedValueOnce({
        data: { batchId: 'batch-1', results: [{ userId: rows[1].id, outcome: 'released', credits: 12 }] },
      })
      .mockResolvedValueOnce({
        data: { batchId: 'batch-1', results: [{ userId: rows[1].id, outcome: 'reversed', credits: 12 }] },
      });
    renderTab();
    await selectRow(rows[1].id);
    await confirmRelease();
    fireEvent.click(await screen.findByTestId('held-signup-grants-revoke-btn'));
    await confirmRevoke();
    expect(await screen.findByTestId('held-signup-grants-revoke-result')).toHaveTextContent(
      'Revoked 1 of 1 grants. Releases without saved account state only had their credits taken back and were not returned to the held list.'
    );
  });

  it('allows another revoke when the previous one left a retryable entry', async () => {
    postMock
      .mockResolvedValueOnce({
        data: { batchId: 'batch-1', results: [{ userId: rows[1].id, outcome: 'released', credits: 12 }] },
      })
      .mockResolvedValueOnce({
        data: { batchId: 'batch-1', results: [{ userId: rows[1].id, outcome: 'insufficient_balance', credits: 12 }] },
      });
    renderTab();
    await selectRow(rows[1].id);
    await confirmRelease();
    fireEvent.click(await screen.findByTestId('held-signup-grants-revoke-btn'));
    await confirmRevoke();
    expect(await screen.findByTestId('held-signup-grants-revoke-result')).toHaveTextContent('Revoked 0 of 1');
    await waitFor(() => expect(screen.getByTestId('held-signup-grants-revoke-btn')).not.toBeDisabled());
  });

  it('refreshes pending exposure when a release request fails after possible payouts', async () => {
    postMock.mockRejectedValue(new Error('Request interrupted'));
    const invalidate = renderTab();
    await selectRow(rows[1].id);
    await confirmRelease();
    expect(await screen.findByTestId('held-signup-grants-release-dialog-error')).toHaveTextContent(
      'Request interrupted'
    );
    expect(screen.getByTestId('held-signup-grants-release-dialog')).toContainElement(
      screen.getByTestId('held-signup-grants-release-dialog-error')
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'signup-grants'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'action-counts'] });
  });

  it('refreshes pending exposure when a revoke request fails after possible debits', async () => {
    postMock
      .mockResolvedValueOnce({
        data: { batchId: 'batch-1', results: [{ userId: rows[1].id, outcome: 'released', credits: 12 }] },
      })
      .mockRejectedValueOnce(new Error('Request interrupted'));
    const invalidate = renderTab();
    await selectRow(rows[1].id);
    await confirmRelease();
    fireEvent.click(await screen.findByTestId('held-signup-grants-revoke-btn'));
    invalidate.mockClear();
    await confirmRevoke();
    expect(await screen.findByText('Request interrupted')).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'signup-grants'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'action-counts'] });
  });

  describe('AI assessment', () => {
    const [abuseRow, legitRow, bareRow] = [
      { ...rows[0], advisory: advisory() },
      { ...rows[1], id: 'e'.repeat(24), advisory: advisory({ result: 'legitimate_automation' }) },
      { ...rows[1], id: 'f'.repeat(24), advisory: null },
    ];
    beforeEach(() => {
      getMock.mockResolvedValue({ data: { data: [abuseRow, legitRow, bareRow], nextCursor: null } });
    });

    it('suggests on an abuse row, shows a neutral chip on others and nothing without an advisory', async () => {
      renderTab();
      expect(await screen.findByTestId(`held-signup-grants-ai-${abuseRow.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`held-signup-grants-advisory-${legitRow.id}`)).toBeInTheDocument();
      expect(screen.queryByTestId(`held-signup-grants-accept-assessment-${legitRow.id}`)).toBeNull();
      expect(screen.queryByTestId(`held-signup-grants-ai-${bareRow.id}`)).toBeNull();
      expect(screen.queryByTestId(`held-signup-grants-advisory-${bareRow.id}`)).toBeNull();
      expect(screen.queryByTestId(`held-signup-grants-actions-${bareRow.id}`)).toBeNull();
    });

    it('accepts the assessment without releasing anything', async () => {
      postMock.mockResolvedValue({ data: { aiSuggestionId: 's1' } });
      const invalidate = renderTab();
      fireEvent.click(await screen.findByTestId(`held-signup-grants-actions-${abuseRow.id}`));
      fireEvent.click(await screen.findByTestId(`held-signup-grants-accept-assessment-${abuseRow.id}`));
      await waitFor(() =>
        expect(postMock).toHaveBeenCalledWith('/api/admin/ai-assessment-suggestions/accept', {
          surface: 'heldSignupGrant',
          userId: abuseRow.id,
          assessmentId: abuseRow.advisory.assessmentId,
        })
      );
      await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['held-signup-grants'] }));
      expect(postMock).toHaveBeenCalledTimes(1);
    });

    it('opens the release dialog for just that account on override and sends the aiDecision', async () => {
      postMock.mockResolvedValue({
        data: { batchId: 'batch-1', results: [{ userId: abuseRow.id, outcome: 'released', credits: 5 }] },
      });
      renderTab();
      fireEvent.click(await screen.findByTestId(`held-signup-grants-actions-${abuseRow.id}`));
      fireEvent.click(await screen.findByTestId(`held-signup-grants-override-assessment-${abuseRow.id}`));
      expect(postMock).not.toHaveBeenCalled();
      await confirmReleaseDialog();
      await waitFor(() =>
        expect(postMock).toHaveBeenCalledWith('/api/admin/held-signup-grants/release', {
          userIds: [abuseRow.id],
          reason: 'Goodwill grant',
          aiDecision: { assessmentId: abuseRow.advisory.assessmentId },
        })
      );
    });

    it('sends no aiDecision when releasing selected rows through the dialog', async () => {
      postMock.mockResolvedValue({ data: { batchId: 'batch-1', results: [] } });
      renderTab();
      await selectRow(abuseRow.id);
      await confirmRelease();
      await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
      expect(postMock.mock.calls[0][1]).toEqual({ userIds: [abuseRow.id], reason: 'Goodwill grant' });
    });

    it.each(['accepted', 'overridden'] as const)(
      'offers no accept or override once the assessment is %s',
      async decision => {
        const decided = { ...abuseRow, advisory: advisory({ decision }) };
        getMock.mockResolvedValue({ data: { data: [decided], nextCursor: null } });
        renderTab();
        expect(await screen.findByTestId(`held-signup-grants-decision-${decided.id}`)).toHaveTextContent(
          decision === 'accepted' ? 'Accepted' : 'Overridden'
        );
        expect(screen.queryByTestId(`held-signup-grants-ai-${decided.id}`)).toBeNull();
        expect(screen.queryByTestId(`held-signup-grants-actions-${decided.id}`)).toBeNull();
        fireEvent.keyDown(screen.getByTestId(`admin-table-select-${decided.id}`), { key: 'a' });
        expect(postMock).not.toHaveBeenCalled();
      }
    );

    it('hides the AI assessment column when no row has an advisory', async () => {
      getMock.mockResolvedValue({ data: { data: rows, nextCursor: null } });
      renderTab();
      await screen.findByTestId(`admin-table-select-${rows[0].id}`);
      expect(screen.queryByText('AI assessment')).toBeNull();
    });

    it('keeps the multi-row selection when an override release succeeds', async () => {
      postMock.mockResolvedValue({
        data: { batchId: 'batch-1', results: [{ userId: abuseRow.id, outcome: 'released', credits: 5 }] },
      });
      renderTab();
      await selectRow(bareRow.id);
      await selectRow(legitRow.id);
      fireEvent.click(screen.getByTestId(`held-signup-grants-actions-${abuseRow.id}`));
      fireEvent.click(await screen.findByTestId(`held-signup-grants-override-assessment-${abuseRow.id}`));
      await confirmReleaseDialog();
      await waitFor(() => expect(screen.getByTestId('held-signup-grants-release-result')).toBeInTheDocument());
      expect(rowCheckbox(bareRow.id)).toBeChecked();
      expect(rowCheckbox(legitRow.id)).toBeChecked();
    });
  });

  it('disables Next without a cursor', async () => {
    renderTab();
    await screen.findByTestId(`admin-table-select-${rows[0].id}`);
    expect(screen.getByTestId('held-signup-grants-next')).toBeDisabled();
  });
});
