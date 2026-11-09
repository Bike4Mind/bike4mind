import { useState } from 'react';
import { Alert, Button, IconButton, Stack, Tooltip, Typography } from '@mui/joy';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PENDING_GRANTS_QUERY_KEY } from '@client/app/hooks/data/adminSignupGrant';
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
  type AdminSelection,
} from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';

const QUERY_KEY = ['held-signup-grants'];
const ENDPOINT = '/api/admin/held-signup-grants';

type HeldReason = 'budget_exhausted';
type HeldRow = { id: string; email: string | null; reason: HeldReason; createdAt: string };
type ReleaseResult = {
  batchId: string;
  results: { userId: string; outcome: string; credits: number }[];
};
type RevokeResult = { batchId: string; results: { userId: string; outcome: string; credits: number }[] };

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
    mutationFn: async (userIds: string[]) => (await api.post<ReleaseResult>(`${ENDPOINT}/release`, { userIds })).data,
    onSuccess: () => setSelection({ mode: 'explicit', ids: [] }),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: PENDING_GRANTS_QUERY_KEY }),
      ]);
    },
  });
  const revoke = useMutation({
    mutationFn: async (batchId: string) => (await api.post<RevokeResult>(`${ENDPOINT}/revoke`, { batchId })).data,
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: PENDING_GRANTS_QUERY_KEY }),
      ]);
    },
  });
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const rows = query.data?.data ?? [];
  const busy = release.isPending || revoke.isPending;
  const selectedIds = selection.mode === 'explicit' ? selection.ids : [];
  const paid = release.data?.results.filter(result => result.outcome === 'released') ?? [];
  const revokeDone =
    revoke.data?.batchId === release.data?.batchId &&
    !revoke.data?.results.some(result => result.outcome === 'insufficient_balance' || result.outcome === 'failed');
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
                  Releasing here pays the original grant without drawing the budget; Revoke permanently debits the
                  credits a release paid (balances already spent are skipped), and the account is not paid this grant
                  again.
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
      {release.error && <Alert color="danger">{getErrorMessage(release.error)}</Alert>}
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
        </Alert>
      )}
      <ActionDialog
        open={confirmRevoke}
        onClose={() => setConfirmRevoke(false)}
        title="Revoke this release?"
        tone="danger"
        description="This permanently debits the credits granted by this release. The accounts will not be paid this grant again, and they leave the held list."
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
        open={confirmRelease}
        onClose={() => setConfirmRelease(false)}
        title="Release held grants"
        description={`Pay ${selectedIds.length} held grant${selectedIds.length === 1 ? '' : 's'} without drawing the daily budget.`}
        reasonPresets={ADMIN_REASON_PRESETS.heldSignupGrantRelease}
        reasonAudited={false}
        confirmLabel={`Release ${selectedIds.length} grant${selectedIds.length === 1 ? '' : 's'}`}
        onConfirm={() => {
          setConfirmRelease(false);
          release.mutate([...selectedIds]);
        }}
        data-testid="held-signup-grants-release-dialog"
      />
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
        <Button
          size="sm"
          data-testid="held-signup-grants-release-btn"
          disabled={busy}
          loading={release.isPending}
          onClick={() => setConfirmRelease(true)}
        >
          Release grants
        </Button>
      </BulkActionBar>
    </Stack>
  );
}
