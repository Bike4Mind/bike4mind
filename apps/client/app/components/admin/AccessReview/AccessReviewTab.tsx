import { type ReactNode, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  FormLabel,
  Input,
  ListDivider,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from '@mui/joy';
import { toast } from 'sonner';
import {
  ACCESS_REVIEW_DORMANT_DAYS_MAX,
  ACCESS_REVIEW_DORMANT_DAYS_MIN,
  formatAdminPermissionSource,
} from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import {
  downloadAccessReviewCsv,
  useAccessReviewDecision,
  useAccessReviewReport,
  type AccessReviewRole,
  type AccessReviewRow,
  type WireAccessReviewDecision,
} from '@client/app/hooks/data/adminAccessReview';
import { AdminPageHeader, DataTable, EmptyState, RelativeTime, type DataColumn } from '../shared';
import { ADMIN_REGION_GAP } from '../shared/adminStyles';
import { RowActionsMenu } from '../shared/RowActionsMenu';
import { RevokeAccessDialog } from './RevokeAccessDialog';

// Must match ACCESS_REVIEW_DEFAULT_DORMANT_DAYS in packages/server-utils/src/security/accessReview/accessReview.ts.
const DORMANT_DAYS_DEFAULT = 90;

/** A live admin row, or an account whose access this review already revoked. */
type ReviewRow = {
  live: AccessReviewRow | null;
  revoked: WireAccessReviewDecision | null;
  userId: string;
  reviewComplete: boolean;
};

const sameId = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

const label = (row: ReviewRow) =>
  row.live ? (row.live.email ?? row.live.username ?? row.userId) : (row.revoked?.email ?? row.userId);

const decisionOf = (row: ReviewRow) => row.live?.decision ?? row.revoked;

function PermissionsCell({ row }: { row: ReviewRow }) {
  const fullAdmin = row.live?.fullAdmin ?? row.revoked?.fullAdmin ?? false;
  if (fullAdmin)
    return (
      <Chip size="sm" color="primary">
        Full admin
      </Chip>
    );
  if (row.live) {
    if (row.live.permissionSources.length === 0) return <Typography level="body-sm">-</Typography>;
    return (
      <Stack data-testid="admin-access-review-permission-sources">
        {row.live.permissionSources.map(source => (
          <Typography key={source.permission} level="body-sm">
            {source.permission} - {formatAdminPermissionSource(source)}
          </Typography>
        ))}
      </Stack>
    );
  }
  const viaRoles = (row.revoked?.roles ?? []).map(role => role.name ?? 'a deleted role');
  return (
    <Stack>
      <Typography level="body-sm">{row.revoked?.permissions.join(', ') || '-'}</Typography>
      {viaRoles.length > 0 && <Typography level="body-xs">via roles: {viaRoles.join(', ')}</Typography>}
    </Stack>
  );
}

const rolesCell = (row: ReviewRow): ReactNode => {
  if (!row.live) return '\u2014';
  if (row.live.roles.length === 0) return '-';
  return (
    <Stack direction="row" gap={0.5} flexWrap="wrap">
      {row.live.roles.map(role =>
        role.deleted ? (
          <Tooltip key={role.id} title={`This account still lists a deleted role (${role.id}). It grants nothing.`}>
            <Chip
              size="sm"
              color="warning"
              variant="soft"
              data-testid={`admin-access-review-deleted-role-chip-${role.id}`}
            >
              Deleted role
            </Chip>
          </Tooltip>
        ) : (
          <Chip
            key={role.id}
            size="sm"
            variant="soft"
            color="neutral"
            data-testid={`admin-access-review-role-chip-${role.id}`}
          >
            {role.name}
          </Chip>
        )
      )}
    </Stack>
  );
};

function DecisionCell({ row }: { row: ReviewRow }) {
  const decision = decisionOf(row);
  if (!decision && row.reviewComplete)
    return (
      <Tooltip title="Access granted after this quarter's review was completed. It is included in the next quarterly review.">
        <Chip size="sm" variant="soft" color="neutral" data-testid="admin-access-review-added-after-chip">
          Added after review
        </Chip>
      </Tooltip>
    );
  if (!decision)
    return (
      <Typography level="body-sm" data-testid="admin-access-review-pending-text">
        Pending
      </Typography>
    );
  return (
    <Stack>
      <Chip size="sm" color={decision.decision === 'revoked' ? 'danger' : 'success'}>
        {decision.decision === 'revoked' ? 'Revoked' : 'Confirmed'}
      </Chip>
      <Typography level="body-xs">by {decision.reviewer.name}</Typography>
    </Stack>
  );
}

// Column widths plus the 3.5rem actions column sum to the DataTable minWidth below; keep them in step.
const columns: DataColumn<ReviewRow>[] = [
  { id: 'admin', label: 'Admin', width: '12rem', wrap: true, render: row => label(row) },
  { id: 'roles', label: 'Roles', width: '7rem', wrap: true, render: rolesCell },
  { id: 'permissions', label: 'Permissions', width: '11rem', wrap: true, render: row => <PermissionsCell row={row} /> },
  {
    id: 'granted',
    label: 'Granted by',
    width: '7.5rem',
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
    width: '6rem',
    wrap: true,
    wrapHeader: true,
    render: ({ live }) => {
      if (!live) return '\u2014';
      return live.lastAdminActionAt ? <RelativeTime at={live.lastAdminActionAt} /> : 'None';
    },
  },
  {
    id: 'lastSignIn',
    label: 'Last sign-in',
    width: '8rem',
    wrap: true,
    render: ({ live }) => {
      if (!live) return '\u2014';
      return live.lastSignInAt ? <RelativeTime at={live.lastSignInAt} /> : 'None in 12 months';
    },
  },
  {
    id: 'flags',
    label: 'Flags',
    width: '6.5rem',
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
  { id: 'decision', label: 'Decision', width: '9rem', wrap: true, render: row => <DecisionCell row={row} /> },
];

const memberLabel = (member: AccessReviewRole['members'][number]) => member.email ?? member.username ?? member.userId;

// Column widths sum to the roles DataTable minWidth below; keep them in step.
const roleColumns: DataColumn<AccessReviewRole>[] = [
  {
    id: 'role',
    label: 'Role',
    width: '12rem',
    wrap: true,
    render: role => (
      <Stack>
        <Typography level="body-sm">{role.name}</Typography>
        {role.description && <Typography level="body-xs">{role.description}</Typography>}
      </Stack>
    ),
  },
  {
    id: 'permissions',
    label: 'Permissions',
    width: '16rem',
    wrap: true,
    render: role => role.permissions.join(', ') || '-',
  },
  {
    id: 'members',
    label: 'Members',
    width: '16rem',
    wrap: true,
    render: role => (
      <Stack>
        <Typography level="body-xs">
          {role.members.length} {role.members.length === 1 ? 'member' : 'members'}
        </Typography>
        {role.members.map(member => (
          <Typography key={member.userId} level="body-sm">
            {memberLabel(member)}
            {member.status !== 'active' ? ` (${member.status})` : ''}
          </Typography>
        ))}
      </Stack>
    ),
  },
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
    const reviewComplete = Boolean(data.record?.completedAt);
    const live = data.admins.map(admin => ({ live: admin, revoked: null, userId: admin.userId, reviewComplete }));
    const listed = new Set(data.admins.map(admin => admin.userId));
    const revoked = (data.record?.decisions ?? [])
      .filter(entry => entry.decision === 'revoked' && !listed.has(entry.userId))
      .map(entry => ({ live: null, revoked: entry, userId: entry.userId, reviewComplete }));
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
    const menu = (
      <RowActionsMenu
        testId="admin-access-review-row-actions"
        ariaLabel={`Actions for ${label({ live, revoked: null, userId: live.userId, reviewComplete: false })}`}
        disabled={own}
      >
        <MenuItem
          disabled={live.decision?.decision === 'confirmed' || decision.isPending}
          onClick={() => confirm(live)}
          data-testid="admin-access-review-confirm-btn"
        >
          Confirm access
        </MenuItem>
        <ListDivider />
        <MenuItem color="danger" onClick={() => setRevoking(live)} data-testid="admin-access-review-revoke-btn">
          Revoke access
        </MenuItem>
      </RowActionsMenu>
    );
    if (!own) return menu;
    return (
      <Tooltip title="Another admin must confirm your access">
        <span>{menu}</span>
      </Tooltip>
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
        loading={isPending}
        error={isError && !data ? 'The access review could not be loaded.' : undefined}
        onRetry={() => void refetch()}
        pagination={false}
        minWidth="70.5rem"
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

      <Stack sx={{ gap: 2, minWidth: 0 }}>
        <Typography level="title-md" component="h2">
          Admin roles
        </Typography>
        <DataTable
          label="Admin roles"
          testId="admin-access-review-roles-table"
          rows={data?.roles ?? []}
          columns={roleColumns}
          getRowId={role => role.id}
          rowTestId={role => `admin-access-review-role-row-${role.id}`}
          loading={isPending}
          error={isError && !data ? 'The access review could not be loaded.' : undefined}
          onRetry={() => void refetch()}
          pagination={false}
          minWidth="44rem"
          maxHeight="none"
          empty={
            <EmptyState
              title="No admin roles defined"
              description="Roles created on the Roles page appear here with their members."
              action={null}
            />
          }
        />
      </Stack>

      {revoking && <RevokeAccessDialog admin={revoking} dormantDays={dormantDays} onClose={() => setRevoking(null)} />}
    </Stack>
  );
}
