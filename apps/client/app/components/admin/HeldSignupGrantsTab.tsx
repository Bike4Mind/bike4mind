import { useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  DialogActions,
  DialogContent,
  Dropdown,
  IconButton,
  Menu,
  MenuButton,
  MenuItem,
  Option,
  Select,
  Stack,
  Typography,
} from '@mui/joy';
import { MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import type { AssessmentAiDecision } from '@bike4mind/common';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PENDING_GRANTS_QUERY_KEY } from '@client/app/hooks/data/adminSignupGrant';
import {
  HELD_SIGNUP_GRANTS_QUERY_KEY,
  useAcceptAssessmentSuggestion,
} from '@client/app/hooks/data/aiAssessmentSuggestions';
import type { SignupRiskReviewRow } from '@client/app/hooks/data/signupRiskReviews';
import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';
import { ActionDialog } from './shared/ActionDialog';
import { ADMIN_REASON_PRESETS } from './shared/adminReason';
import { AdminDialog } from './shared/AdminDialog';
import { DataTable, type DataTableRowShortcut } from './shared/DataTable';
import { AdminPermissionAction, useMissingAdminPermission } from './shared/MissingPermission';
import { SignupAdvisoryCell } from './SignupAdvisoryCell';

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
  const [reason, setReason] = useState<HeldReason | 'all'>('all');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();
  const after = cursors[cursors.length - 1];
  const query = useQuery({
    queryKey: [...QUERY_KEY, reason, after],
    queryFn: async () =>
      (
        await api.get<{ data: HeldRow[]; nextCursor: string | null }>(ENDPOINT, {
          params: { ...(reason === 'all' ? {} : { reason }), ...(after ? { after } : {}) },
        })
      ).data,
  });
  const release = useMutation({
    mutationFn: async (request: ReleaseRequest) => (await api.post<ReleaseResult>(`${ENDPOINT}/release`, request)).data,
    onSuccess: () => setSelected(new Set()),
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
  const acceptSuggestion = useAcceptAssessmentSuggestion();
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [releasing, setReleasing] = useState<Releasing | null>(null);
  const [now] = useState(() => Date.now());
  const releaseMissing = useMissingAdminPermission('credits:adjust');
  const rows = query.data?.data ?? [];
  const busy = release.isPending || revoke.isPending;
  const toggle = (id: string) =>
    setSelected(current => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const acceptAssessment = (row: HeldRow) => {
    if (row.advisory?.result !== 'abuse') return;
    acceptSuggestion.mutate(
      { surface: 'heldSignupGrant', userId: row.id, assessmentId: row.advisory.assessmentId },
      {
        onSuccess: () => toast.success(`Accepted the abuse assessment for ${row.email ?? row.id}`),
        onError: error => toast.error(getErrorMessage(error)),
      }
    );
  };
  const overrideAssessment = (row: HeldRow) => {
    if (row.advisory?.result !== 'abuse') return;
    release.reset();
    setReleasing({ userIds: [row.id], assessmentId: row.advisory.assessmentId });
  };
  // Only an abuse verdict can be accepted or overridden; accepting records agreement and releases nothing.
  const decisions = (row: HeldRow): Partial<Record<DataTableRowShortcut, () => void>> =>
    row.advisory?.result === 'abuse' && !releaseMissing
      ? { a: () => acceptAssessment(row), o: () => overrideAssessment(row) }
      : {};
  const paid = release.data?.results.filter(result => result.outcome === 'released') ?? [];
  const revokeDone =
    revoke.data?.batchId === release.data?.batchId &&
    !revoke.data?.results.some(
      result =>
        result.outcome === 'insufficient_balance' || result.outcome === 'state_changed' || result.outcome === 'failed'
    );

  return (
    <Stack spacing={2} data-testid="held-signup-grants-tab">
      <Typography level="h3">Held signup grants</Typography>
      <Typography>
        Free credits withheld from new accounts, oldest first. A grant held by the daily budget is also paid
        automatically once a new day&apos;s budget opens. Releasing here pays the original grant without drawing the
        budget; Revoke takes back the credits a release paid (balances already spent are skipped) and returns the
        account to this list.
      </Typography>
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
      {confirmRevoke && (
        <AdminDialog
          title="Revoke this release?"
          role="alertdialog"
          onClose={() => setConfirmRevoke(false)}
          data-testid="held-signup-grants-revoke-dialog"
        >
          <DialogContent>
            This takes back the credits granted by this release and returns the accounts to the held list, where they
            are paid again like any other held grant.
          </DialogContent>
          <DialogActions>
            <Button
              color="danger"
              data-testid="held-signup-grants-revoke-confirm-btn"
              onClick={() => {
                setConfirmRevoke(false);
                if (release.data) revoke.mutate(release.data.batchId);
              }}
            >
              Revoke credits
            </Button>
            <Button
              variant="plain"
              color="neutral"
              data-testid="held-signup-grants-revoke-cancel-btn"
              onClick={() => setConfirmRevoke(false)}
            >
              Cancel
            </Button>
          </DialogActions>
        </AdminDialog>
      )}
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Select
          size="sm"
          value={reason}
          data-testid="held-signup-grants-reason-select"
          onChange={(_event, value) => {
            setReason(value ?? 'all');
            setCursors([undefined]);
            setSelected(new Set());
          }}
        >
          <Option value="all">All reasons</Option>
          <Option value="budget_exhausted">{REASON_LABELS.budget_exhausted}</Option>
        </Select>
        <AdminPermissionAction requirement="credits:adjust">
          {missingPermission => (
            <Button
              size="sm"
              data-testid="held-signup-grants-release-btn"
              disabled={missingPermission || busy || selected.size === 0}
              onClick={() => {
                release.reset();
                setReleasing({ userIds: [...selected] });
              }}
            >
              Release selected ({selected.size})
            </Button>
          )}
        </AdminPermissionAction>
        <Button
          size="sm"
          variant="outlined"
          data-testid="held-signup-grants-previous"
          disabled={cursors.length === 1 || query.isPending}
          onClick={() => setCursors(current => current.slice(0, -1))}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="outlined"
          data-testid="held-signup-grants-next"
          disabled={!query.data?.nextCursor || query.isPending}
          onClick={() => setCursors(current => [...current, query.data?.nextCursor ?? undefined])}
        >
          Next
        </Button>
      </Stack>
      <ActionDialog
        open={releasing !== null}
        onClose={() => {
          if (!release.isPending) setReleasing(null);
        }}
        title={
          releasing && releasing.userIds.length > 1 ? `Release ${releasing.userIds.length} grants` : 'Release grant'
        }
        description="This pays the original signup grant without drawing the daily budget. Revoke is offered afterwards to take the credits back."
        reasonPresets={ADMIN_REASON_PRESETS.signupGrantRelease}
        confirmLabel={
          releasing && releasing.userIds.length > 1 ? `Release ${releasing.userIds.length} grants` : 'Release grant'
        }
        pending={release.isPending}
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
        testIds={{ reason: 'held-signup-grants-release-reason', confirm: 'held-signup-grants-release-confirm-btn' }}
      >
        {release.error && (
          <Alert color="danger" data-testid="held-signup-grants-release-error">
            {getErrorMessage(release.error)}
          </Alert>
        )}
      </ActionDialog>
      <DataTable<HeldRow>
        rows={rows}
        getRowId={row => row.id}
        label="Held signup grants"
        loading={query.isPending}
        error={query.error ? getErrorMessage(query.error) : undefined}
        onRetry={() => {
          void query.refetch();
        }}
        pagination={false}
        rowShortcuts={decisions}
        rowActions={row =>
          row.advisory?.result === 'abuse' ? (
            <Dropdown>
              <MenuButton
                slots={{ root: IconButton }}
                slotProps={{
                  root: { variant: 'plain', size: 'sm', 'aria-label': `Actions for ${row.email ?? row.id}` },
                }}
                disabled={!!releaseMissing}
                data-testid={`held-signup-grants-actions-${row.id}`}
              >
                <MoreHorizontal size={16} />
              </MenuButton>
              <Menu placement="bottom-end">
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
              </Menu>
            </Dropdown>
          ) : null
        }
        empty={<Typography>No signup grants are held.</Typography>}
        columns={[
          {
            id: 'select',
            label: '',
            render: row => (
              <Checkbox
                checked={selected.has(row.id)}
                disabled={busy}
                slotProps={{ input: { 'data-testid': `held-signup-grants-select-${row.id}` } }}
                onChange={() => toggle(row.id)}
              />
            ),
          },
          { id: 'email', label: 'Account', render: row => row.email ?? row.id },
          {
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
          },
          { id: 'reason', label: 'Reason', render: row => REASON_LABELS[row.reason] },
          { id: 'created', label: 'Signed up', render: row => new Date(row.createdAt).toLocaleString() },
        ]}
      />
    </Stack>
  );
}
