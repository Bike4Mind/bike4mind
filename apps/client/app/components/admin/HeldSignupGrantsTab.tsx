import { useState } from 'react';
import { Alert, Button, IconButton, MenuItem, Stack, Tooltip, Typography } from '@mui/joy';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import { toast } from 'sonner';
import type { AssessmentAiDecision } from '@bike4mind/common';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminActionCountsQueryKey } from '@client/app/hooks/data/adminActionCounts';
import { PENDING_GRANTS_QUERY_KEY } from '@client/app/hooks/data/adminSignupGrant';
import {
  HELD_SIGNUP_GRANTS_QUERY_KEY,
  useAcceptAssessmentSuggestion,
} from '@client/app/hooks/data/aiAssessmentSuggestions';
import type { SignupRiskReviewRow } from '@client/app/hooks/data/signupRiskReviews';
import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';
import {
  ADMIN_REASON_PRESETS,
  ActionDialog,
  AdminPageHeader,
  BulkActionBar,
  DataTable,
  EmptyState,
  FilterChip,
  RowActionsMenu,
  type AdminSelection,
  type DataColumn,
  type DataTableRowShortcut,
} from './shared';
import { AdminPermissionAction, useMissingAdminPermission } from './shared/MissingPermission';
import { ADMIN_REGION_GAP } from './shared/adminStyles';
import { SignupAdvisoryCell, isAssessmentOpen } from './SignupAdvisoryCell';

const QUERY_KEY = HELD_SIGNUP_GRANTS_QUERY_KEY;
const ENDPOINT = '/api/admin/held-signup-grants';

type HeldReason = 'budget_exhausted';
type HeldRow = {
  id: string;
  email: string | null;
  reason: HeldReason;
  createdAt: string;
  advisory?: SignupRiskReviewRow['advisory'];
};
type ReleaseRequest = { userIds: string[]; reason: string; aiDecision?: AssessmentAiDecision };
/** The accounts a release dialog is open for; `assessmentId` is set when it was opened by overriding the model's abuse verdict. */
type Releasing = { userIds: string[]; assessmentId?: string };
type ReleaseResult = {
  batchId: string;
  results: { userId: string; outcome: string; credits: number }[];
};
type RevokeResult = {
  batchId: string;
  results: { userId: string; outcome: string; credits: number; heldRestored?: boolean }[];
};

const REASON_LABELS: Record<HeldReason, string> = {
  budget_exhausted: 'Daily budget spent',
};

export default function HeldSignupGrantsTab() {
  const [reason, setReason] = useState<HeldReason | undefined>(undefined);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [selection, setSelection] = useState<AdminSelection>({ mode: 'explicit', ids: [] });
  const queryClient = useQueryClient();
  const after = cursors[cursors.length - 1];
  const query = useQuery({
    queryKey: [...QUERY_KEY, reason ?? 'all', after],
    queryFn: async () =>
      (
        await api.get<{ data: HeldRow[]; nextCursor: string | null }>(ENDPOINT, {
          params: { ...(reason ? { reason } : {}), ...(after ? { after } : {}) },
        })
      ).data,
  });
  const release = useMutation({
    mutationFn: async (request: ReleaseRequest) => (await api.post<ReleaseResult>(`${ENDPOINT}/release`, request)).data,
    // Rows ticked while the release was in flight, or left out of a one-row override release, stay selected.
    onSuccess: (_result, { userIds }) =>
      setSelection(current =>
        current.mode === 'explicit'
          ? { mode: 'explicit', ids: current.ids.filter(id => !userIds.includes(id)) }
          : current
      ),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: PENDING_GRANTS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: adminActionCountsQueryKey }),
      ]);
    },
  });
  const revoke = useMutation({
    mutationFn: async (batchId: string) => (await api.post<RevokeResult>(`${ENDPOINT}/revoke`, { batchId })).data,
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: PENDING_GRANTS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: adminActionCountsQueryKey }),
      ]);
    },
  });
  const acceptSuggestion = useAcceptAssessmentSuggestion();
  const [releasing, setReleasing] = useState<Releasing | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [now] = useState(() => Date.now());
  const releaseMissing = useMissingAdminPermission('credits:adjust');
  const rows = query.data?.data ?? [];
  const hasAdvisories = rows.some(row => row.advisory);
  const busy = release.isPending || revoke.isPending;
  const selectedIds = selection.mode === 'explicit' ? selection.ids : [];
  const openRelease = (next: Releasing) => {
    // A failure from the previous attempt would otherwise reappear inside the fresh dialog.
    if (release.error) release.reset();
    setReleasing(next);
  };
  const acceptAssessment = (row: HeldRow) => {
    if (!isAssessmentOpen(row.advisory)) return;
    acceptSuggestion.mutate(
      { surface: 'heldSignupGrant', userId: row.id, assessmentId: row.advisory.assessmentId },
      {
        onSuccess: () => toast.success(`Accepted the abuse assessment for ${row.email ?? row.id}`),
        onError: error => toast.error(getErrorMessage(error)),
      }
    );
  };
  const overrideAssessment = (row: HeldRow) => {
    if (!isAssessmentOpen(row.advisory)) return;
    openRelease({ userIds: [row.id], assessmentId: row.advisory.assessmentId });
  };
  // Only an abuse verdict can be accepted or overridden; accepting records agreement and releases nothing.
  const decisions = (row: HeldRow): Partial<Record<DataTableRowShortcut, () => void>> =>
    isAssessmentOpen(row.advisory) && !releaseMissing
      ? { a: () => acceptAssessment(row), o: () => overrideAssessment(row) }
      : {};
  const advisoryColumn: DataColumn<HeldRow> = {
    id: 'advisory',
    label: 'AI assessment',
    render: row => (
      <SignupAdvisoryCell
        userId={row.id}
        advisory={row.advisory ?? null}
        now={now}
        testIdPrefix="held-signup-grants"
        abuseProposal="Likely abuse: keep held"
        onAccept={decisions(row).a}
        onOverride={decisions(row).o}
      />
    ),
  };
  const releaseCount = releasing?.userIds.length ?? 0;
  const grantsLabel = `${releaseCount} held grant${releaseCount === 1 ? '' : 's'}`;
  const paid = release.data?.results.filter(result => result.outcome === 'released') ?? [];
  const revokeDone =
    revoke.data?.batchId === release.data?.batchId &&
    !revoke.data?.results.some(
      result =>
        result.outcome === 'insufficient_balance' || result.outcome === 'state_changed' || result.outcome === 'failed'
    );
  const changeReason = (value: HeldReason | undefined) => {
    setReason(value);
    setCursors([undefined]);
    setSelection({ mode: 'explicit', ids: [] });
  };

  return (
    <Stack gap={ADMIN_REGION_GAP} data-testid="held-signup-grants-tab">
      <AdminPageHeader
        title="Held signup grants"
        description={
          <>
            Free signup credits withheld from new accounts, oldest first.
            <Tooltip
              variant="outlined"
              placement="bottom-start"
              sx={{ maxWidth: 480 }}
              title={
                <Typography level="body-sm" component="div">
                  A grant held by the daily budget is also paid automatically once a new day&apos;s budget opens.
                  Releasing here pays the original grant without drawing the budget; Revoke takes back the credits a
                  release paid (balances already spent are skipped) and returns the account to this list.
                </Typography>
              }
            >
              <IconButton
                size="sm"
                variant="plain"
                aria-label="About held signup grants"
                data-testid="held-signup-grants-help-btn"
                sx={{ '--IconButton-size': '24px', ml: 0.5, verticalAlign: 'middle' }}
              >
                <HelpOutlineIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          </>
        }
      />
      {release.error && !releasing && <Alert color="danger">{getErrorMessage(release.error)}</Alert>}
      {revoke.error && <Alert color="danger">{getErrorMessage(revoke.error)}</Alert>}
      {release.data && (
        <Alert color="success" data-testid="held-signup-grants-release-result">
          Released {paid.length} of {release.data.results.length} grants
          {' ('}
          {paid.reduce((sum, result) => sum + result.credits, 0)} credits).
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            sx={{ ml: 2 }}
            data-testid="held-signup-grants-revoke-btn"
            disabled={busy || !paid.length || revokeDone}
            onClick={() => setConfirmRevoke(true)}
          >
            Revoke
          </Button>
        </Alert>
      )}
      {revoke.data && (
        <Alert color="neutral" data-testid="held-signup-grants-revoke-result">
          Revoked {revoke.data.results.filter(result => result.outcome === 'reversed').length} of{' '}
          {revoke.data.results.length} grants.
          {revoke.data.results.some(result => result.outcome === 'state_changed') &&
            ' Accounts that received more credits since the release were left as they are.'}
          {revoke.data.results.some(result => result.outcome === 'reversed' && !result.heldRestored) &&
            ' Releases without saved account state only had their credits taken back and were not returned to the held list.'}
        </Alert>
      )}
      <ActionDialog
        open={confirmRevoke}
        onClose={() => setConfirmRevoke(false)}
        title="Revoke this release?"
        tone="danger"
        description="This takes back the credits granted by this release and returns the accounts to the held list, where they are paid again like any other held grant."
        reasonPresets={ADMIN_REASON_PRESETS.heldSignupGrantRevoke}
        reasonAudited={false}
        confirmLabel="Revoke credits"
        onConfirm={() => {
          setConfirmRevoke(false);
          if (release.data) revoke.mutate(release.data.batchId);
        }}
        data-testid="held-signup-grants-revoke-dialog"
        testIds={{ confirm: 'held-signup-grants-revoke-confirm-btn' }}
      />
      <ActionDialog
        open={releasing !== null}
        onClose={() => {
          if (!release.isPending) setReleasing(null);
        }}
        title="Release held grants"
        description={`Pay ${grantsLabel} without drawing the daily budget.`}
        reasonPresets={ADMIN_REASON_PRESETS.signupGrantRelease}
        pending={release.isPending}
        confirmLabel={`Release ${grantsLabel}`}
        onConfirm={reason => {
          if (!releasing) return;
          release.mutate(
            {
              userIds: releasing.userIds,
              reason,
              ...(releasing.assessmentId && releasing.userIds.length === 1
                ? { aiDecision: { assessmentId: releasing.assessmentId } }
                : {}),
            },
            { onSuccess: () => setReleasing(null) }
          );
        }}
        data-testid="held-signup-grants-release-dialog"
      >
        {/* The dialog stays open on failure, so the error has to show inside it. */}
        {release.error && (
          <Alert color="danger" data-testid="held-signup-grants-release-dialog-error">
            {getErrorMessage(release.error)}
          </Alert>
        )}
      </ActionDialog>
      <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1}>
        <FilterChip
          id="reason"
          label="Reason"
          options={Object.entries(REASON_LABELS).map(([value, label]) => ({ value, label }))}
          value={reason}
          onChange={value => changeReason(value as HeldReason | undefined)}
        />
      </Stack>
      <DataTable<HeldRow>
        rows={rows}
        getRowId={row => row.id}
        label="Held signup grants"
        minWidth="40rem"
        testId="held-signup-grants-table"
        loading={query.isPending}
        error={query.error ? getErrorMessage(query.error) : undefined}
        onRetry={() => {
          void query.refetch();
        }}
        pagination={false}
        selection={selection}
        onSelectionChange={setSelection}
        rowShortcuts={decisions}
        rowActions={row =>
          isAssessmentOpen(row.advisory) ? (
            <RowActionsMenu
              testId={`held-signup-grants-actions-${row.id}`}
              ariaLabel={`Actions for ${row.email ?? row.id}`}
              disabled={!!releaseMissing}
            >
              <MenuItem
                disabled={acceptSuggestion.isPending}
                data-testid={`held-signup-grants-accept-assessment-${row.id}`}
                onClick={() => acceptAssessment(row)}
              >
                Accept AI assessment
              </MenuItem>
              <MenuItem
                data-testid={`held-signup-grants-override-assessment-${row.id}`}
                onClick={() => overrideAssessment(row)}
              >
                Override: release grant
              </MenuItem>
            </RowActionsMenu>
          ) : null
        }
        empty={
          <EmptyState
            title="No signup grants are held"
            action={
              reason ? (
                <Button
                  size="sm"
                  variant="outlined"
                  color="neutral"
                  onClick={() => changeReason(undefined)}
                  data-testid="held-signup-grants-empty-action"
                >
                  Clear filter
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outlined"
                  color="neutral"
                  onClick={() => void query.refetch()}
                  data-testid="held-signup-grants-empty-action"
                >
                  Refresh
                </Button>
              )
            }
          />
        }
        columns={[
          { id: 'email', label: 'Account', render: row => row.email ?? row.id },
          ...(hasAdvisories ? [advisoryColumn] : []),
          { id: 'reason', label: 'Reason', render: row => REASON_LABELS[row.reason] },
          { id: 'created', label: 'Signed up', render: row => new Date(row.createdAt).toLocaleString() },
        ]}
      />
      <Stack direction="row" gap={1} justifyContent="flex-end">
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          data-testid="held-signup-grants-previous"
          disabled={cursors.length === 1 || query.isPending}
          onClick={() => setCursors(current => current.slice(0, -1))}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          data-testid="held-signup-grants-next"
          disabled={!query.data?.nextCursor || query.isPending}
          onClick={() => setCursors(current => [...current, query.data?.nextCursor ?? undefined])}
        >
          Next
        </Button>
      </Stack>
      <BulkActionBar
        selection={selection}
        totalMatching={selectedIds.length}
        onSelectAllMatching={() => undefined}
        onClear={() => setSelection({ mode: 'explicit', ids: [] })}
      >
        <AdminPermissionAction requirement="credits:adjust">
          {missingPermission => (
            <Button
              size="sm"
              data-testid="held-signup-grants-release-btn"
              disabled={missingPermission || busy}
              loading={release.isPending}
              onClick={() => openRelease({ userIds: [...selectedIds] })}
            >
              Release grants
            </Button>
          )}
        </AdminPermissionAction>
      </BulkActionBar>
    </Stack>
  );
}
