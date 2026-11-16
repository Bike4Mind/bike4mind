import { useMemo, useState } from 'react';
import { Alert, Box, Button, Chip, FormControl, FormLabel, Input, Stack, Tooltip, Typography } from '@mui/joy';
import { toast } from 'sonner';
import { ACCESS_REVIEW_DORMANT_DAYS_MAX, ACCESS_REVIEW_DORMANT_DAYS_MIN } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import {
  downloadAccessReviewCsv,
  useAccessReviewDecision,
  useAccessReviewReport,
  type AccessReviewRow,
  type WireAccessReviewDecision,
} from '@client/app/hooks/data/adminAccessReview';
import { AdminPageHeader, DataTable, EmptyState, RelativeTime, type DataColumn } from '../shared';
import { ADMIN_REGION_GAP } from '../shared/adminStyles';
import { RevokeAccessDialog } from './RevokeAccessDialog';

// Must match ACCESS_REVIEW_DEFAULT_DORMANT_DAYS in packages/server-utils/src/security/accessReview/accessReview.ts.
const DORMANT_DAYS_DEFAULT = 90;

/** A live admin row, or an account whose access this review already revoked. */
type ReviewRow = { live: AccessReviewRow | null; revoked: WireAccessReviewDecision | null; userId: string };

const sameId = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

const label = (row: ReviewRow) =>
  row.live ? (row.live.email ?? row.live.username ?? row.userId) : (row.revoked?.email ?? row.userId);

const decisionOf = (row: ReviewRow) => row.live?.decision ?? row.revoked;

function PermissionsCell({ row }: { row: ReviewRow }) {
  const fullAdmin = row.live?.fullAdmin ?? row.revoked?.fullAdmin ?? false;
  const permissions = row.live?.permissions ?? row.revoked?.permissions ?? [];
  if (fullAdmin)
    return (
      <Chip size="sm" color="primary">
        Full admin
      </Chip>
    );
  return <Typography level="body-sm">{permissions.join(', ') || '-'}</Typography>;
}

function DecisionCell({ row }: { row: ReviewRow }) {
  const decision = decisionOf(row);
  if (!decision) return <Typography level="body-sm">Pending</Typography>;
  return (
    <Stack>
      <Chip size="sm" color={decision.decision === 'revoked' ? 'danger' : 'success'}>
        {decision.decision === 'revoked' ? 'Revoked' : 'Confirmed'}
      </Chip>
      <Typography level="body-xs">by {decision.reviewer.name}</Typography>
    </Stack>
  );
}

const columns: DataColumn<ReviewRow>[] = [
  { id: 'admin', label: 'Admin', render: row => label(row) },
  { id: 'permissions', label: 'Permissions', wrap: true, render: row => <PermissionsCell row={row} /> },
  {
    id: 'granted',
    label: 'Granted by',
    wrap: true,
    render: ({ live }) => {
      if (!live) return '-';
      if (!live.grantedBy) return 'Unknown (before audit log)';
      return (
        <Stack>
          <Typography level="body-sm">{live.grantedBy.email ?? live.grantedBy.name}</Typography>
          <RelativeTime at={live.grantedAt} />
        </Stack>
      );
    },
  },
  {
    id: 'lastAction',
    label: 'Last admin action',
    width: '9rem',
    render: ({ live }) => (live?.lastAdminActionAt ? <RelativeTime at={live.lastAdminActionAt} /> : 'None'),
  },
  {
    id: 'lastSignIn',
    label: 'Last sign-in',
    width: '9rem',
    render: ({ live }) => (live?.lastSignInAt ? <RelativeTime at={live.lastSignInAt} /> : 'None in 12 months'),
  },
  {
    id: 'flags',
    label: 'Flags',
    wrap: true,
    render: ({ live }) =>
      live ? (
        <Stack direction="row" gap={0.5} flexWrap="wrap">
          {live.mfaEnabled && (
            <Chip size="sm" color="success" variant="soft">
              MFA
            </Chip>
          )}
          {live.dormant && (
            <Chip size="sm" color="warning" data-testid="admin-access-review-dormant-chip">
              Dormant
            </Chip>
          )}
          {live.noMfa && (
            <Chip size="sm" color="danger" data-testid="admin-access-review-no-mfa-chip">
              No MFA
            </Chip>
          )}
        </Stack>
      ) : null,
  },
  { id: 'decision', label: 'Decision', width: '8rem', render: row => <DecisionCell row={row} /> },
];

/** The quarterly admin access review: every admin's access, its provenance and activity, and a decision per admin. */
export default function AccessReviewTab() {
  const { currentUser } = useUser();
  const [dormantDraft, setDormantDraft] = useState(String(DORMANT_DAYS_DEFAULT));
  const [dormantDays, setDormantDays] = useState(DORMANT_DAYS_DEFAULT);
  const [revoking, setRevoking] = useState<AccessReviewRow | null>(null);
  const [exporting, setExporting] = useState(false);
  const { data, isPending, isError, refetch } = useAccessReviewReport(dormantDays);
  const decision = useAccessReviewDecision();

  const rows = useMemo<ReviewRow[]>(() => {
    if (!data) return [];
    const live = data.admins.map(admin => ({ live: admin, revoked: null, userId: admin.userId }));
    const listed = new Set(data.admins.map(admin => admin.userId));
    const revoked = (data.record?.decisions ?? [])
      .filter(entry => entry.decision === 'revoked' && !listed.has(entry.userId))
      .map(entry => ({ live: null, revoked: entry, userId: entry.userId }));
    return [...live, ...revoked];
  }, [data]);

  const undecided = data?.admins.filter(admin => !admin.decision) ?? [];
  const pendingSelf = undecided.length === 1 && sameId(currentUser?.id, undecided[0].userId);
  const completedAt = data?.record?.completedAt ?? null;

  const changeDormantDays = (value: string) => {
    setDormantDraft(value);
    const parsed = Number(value);
    if (
      value.trim() !== '' &&
      Number.isInteger(parsed) &&
      parsed >= ACCESS_REVIEW_DORMANT_DAYS_MIN &&
      parsed <= ACCESS_REVIEW_DORMANT_DAYS_MAX
    ) {
      setDormantDays(parsed);
    }
  };

  const confirm = (admin: AccessReviewRow) =>
    decision.mutate(
      { userId: admin.userId, decision: 'confirmed', dormantDays },
      { onError: () => toast.error('The decision was not recorded.') }
    );

  const exportCsv = async () => {
    if (!data) return;
    setExporting(true);
    try {
      await downloadAccessReviewCsv(data.quarter);
    } catch {
      toast.error('The access review could not be exported.');
    } finally {
      setExporting(false);
    }
  };

  const rowActions = ({ live }: ReviewRow) => {
    if (!live) return null;
    const own = sameId(currentUser?.id, live.userId);
    return (
      <Stack direction="row" gap={1}>
        <Tooltip title={own ? 'Another admin must confirm your access' : ''} disableHoverListener={!own}>
          <span>
            <Button
              size="sm"
              variant="outlined"
              disabled={own || live.decision?.decision === 'confirmed' || decision.isPending}
              onClick={() => confirm(live)}
              data-testid="admin-access-review-confirm-btn"
            >
              Confirm
            </Button>
          </span>
        </Tooltip>
        <Button
          size="sm"
          variant="outlined"
          color="danger"
          disabled={own}
          onClick={() => setRevoking(live)}
          data-testid="admin-access-review-revoke-btn"
        >
          Revoke
        </Button>
      </Stack>
    );
  };

  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP, minWidth: 0 }} data-testid="admin-access-review-tab">
      <AdminPageHeader
        title="Access review"
        count={data ? data.admins.length : undefined}
        description={`Confirm or revoke every admin's access once a quarter${data ? ` (${data.quarter})` : ''}. Confirmations and revocations are recorded with the reviewer and land in the audit log.`}
        actions={
          <Button
            variant="outlined"
            loading={exporting}
            disabled={!data}
            onClick={() => void exportCsv()}
            data-testid="admin-access-review-export-btn"
          >
            Export CSV
          </Button>
        }
      />

      {completedAt && (
        <Alert color="success" data-testid="admin-access-review-completed">
          This quarter&apos;s review is complete.
        </Alert>
      )}
      {!completedAt && pendingSelf && (
        <Alert color="warning" data-testid="admin-access-review-pending-self">
          Your own access needs a second reviewer: another full admin must confirm it before this review can complete.
        </Alert>
      )}

      <Box>
        <FormControl sx={{ maxWidth: '14rem' }}>
          <FormLabel>Dormant after (days)</FormLabel>
          <Input
            type="number"
            value={dormantDraft}
            onChange={event => changeDormantDays(event.target.value)}
            slotProps={{
              input: {
                min: ACCESS_REVIEW_DORMANT_DAYS_MIN,
                max: ACCESS_REVIEW_DORMANT_DAYS_MAX,
                'data-testid': 'admin-access-review-dormant-days-input',
              },
            }}
          />
        </FormControl>
      </Box>

      <DataTable
        label="Admin access review"
        testId="admin-access-review-table"
        rows={rows}
        columns={columns}
        getRowId={row => row.userId}
        rowTestId={row => `admin-access-review-row-${row.userId}`}
        rowActions={rowActions}
        actionsWidth="12rem"
        loading={isPending}
        error={isError && !data ? 'The access review could not be loaded.' : undefined}
        onRetry={() => void refetch()}
        pagination={false}
        minWidth="64rem"
        maxHeight="none"
        empty={
          <EmptyState
            title="No admins"
            description="No account currently holds admin access."
            action={
              <Button variant="outlined" onClick={() => void refetch()}>
                Refresh
              </Button>
            }
          />
        }
      />

      {revoking && <RevokeAccessDialog admin={revoking} dormantDays={dormantDays} onClose={() => setRevoking(null)} />}
    </Stack>
  );
}
