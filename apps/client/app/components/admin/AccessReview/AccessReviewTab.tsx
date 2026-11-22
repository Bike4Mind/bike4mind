import { type ReactNode, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Alert, Box, Button, Chip, Input, MenuItem, Stack, Tooltip, Typography } from '@mui/joy';
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
} from '@client/app/hooks/data/adminAccessReview';
import {
  AdminPageHeader,
  BulkActionBar,
  Dash,
  DataTable,
  EmptyState,
  FilterInputLabel,
  FilterToolbar,
  RelativeTime,
  SegmentedControl,
  StatusChip,
  type AdminSelection,
  type DataColumn,
} from '../shared';
import { ADMIN_REGION_GAP } from '../shared/adminStyles';
import { RowActionsMenu } from '../shared/RowActionsMenu';
import { AccessReviewProgressBanner, formatReviewDate } from './AccessReviewOverdueBanner';
import {
  buildReviewRows,
  countByStatus,
  filterByStatus,
  isSuggestedRevoke,
  rowLabel,
  type ReviewRow,
  type ReviewStatusFilter,
} from './accessReviewRows';
import { BulkRevokeAccessDialog } from './BulkRevokeAccessDialog';
import { RevokeAccessDialog } from './RevokeAccessDialog';

// Must match ACCESS_REVIEW_DEFAULT_DORMANT_DAYS in packages/server-utils/src/security/accessReview/accessReview.ts.
const DORMANT_DAYS_DEFAULT = 90;

const sameId = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

const Muted = ({ children, testId }: { children: ReactNode; testId?: string }) => (
  <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid={testId}>
    {children}
  </Typography>
);

function AdminCell({ row }: { row: ReviewRow }) {
  return (
    <Link
      to="/admin/users/$userId"
      params={{ userId: row.userId }}
      data-testid={`admin-access-review-profile-link-${row.userId}`}
      style={{ color: 'inherit', textDecoration: 'none' }}
    >
      <Typography
        level="body-sm"
        sx={{ color: 'inherit', overflowWrap: 'anywhere', '&:hover': { textDecoration: 'underline' } }}
      >
        {rowLabel(row)}
      </Typography>
    </Link>
  );
}

function PermissionsCell({ row }: { row: ReviewRow }) {
  if (row.live) {
    if (row.live.fullAdmin) return <StatusChip tone="info" label="Full admin" />;
    if (row.live.permissionSources.length === 0) return <Dash />;
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
  // A revoked row shows what was removed, as plain text: no chip that reads as access still held.
  const removed = row.revoked?.fullAdmin
    ? ['Full admin', ...(row.revoked.permissions ?? [])]
    : (row.revoked?.permissions ?? []);
  const viaRoles = (row.revoked?.roles ?? []).map(role => role.name ?? 'a deleted role');
  if (removed.length === 0 && viaRoles.length === 0) return <Dash />;
  return (
    <Stack data-testid="admin-access-review-removed-access">
      {removed.length > 0 && <Typography level="body-sm">Removed: {removed.join(', ')}</Typography>}
      {viaRoles.length > 0 && <Typography level="body-xs">via roles: {viaRoles.join(', ')}</Typography>}
    </Stack>
  );
}

const rolesCell = (row: ReviewRow): ReactNode => {
  if (!row.live || row.live.roles.length === 0) return <Dash />;
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
            title={role.name ?? undefined}
            data-testid={`admin-access-review-role-chip-${role.id}`}
          >
            {role.name}
          </Chip>
        )
      )}
    </Stack>
  );
};

function GrantedByCell({ row }: { row: ReviewRow }) {
  const { live } = row;
  if (!live) return <Dash />;
  if (!live.grantedBy) return <Muted testId="admin-access-review-granted-unknown">Before audit log</Muted>;
  return (
    <Stack>
      <Typography level="body-sm">{live.grantedBy.email ?? live.grantedBy.name}</Typography>
      <RelativeTime at={live.grantedAt} />
    </Stack>
  );
}

/** Problems only: a healthy row shows the empty dash. No MFA is a security risk, so it outranks Dormant. */
function FlagsCell({ row }: { row: ReviewRow }) {
  const { live } = row;
  if (!live || (!live.noMfa && !live.dormant)) return <Dash />;
  return (
    <Stack direction="row" gap={0.5} flexWrap="wrap">
      {live.noMfa && (
        <Box data-testid="admin-access-review-no-mfa-chip">
          <StatusChip tone="bad" label="No MFA" dot />
        </Box>
      )}
      {live.dormant && (
        <Box data-testid="admin-access-review-dormant-chip">
          <StatusChip tone="neutral" label="Dormant" />
        </Box>
      )}
    </Stack>
  );
}

/** A pending row's decision is its Confirm and Revoke buttons; a decided row shows who decided and when. */
function DecisionCell({ row, pendingActions }: { row: ReviewRow; pendingActions: ReactNode }) {
  const decision = row.live?.decision?.decision === 'confirmed' ? row.live.decision : row.revoked;
  if (row.status === 'pending') {
    return (
      <Stack gap={0.75} alignItems="flex-start" data-testid="admin-access-review-pending-decision">
        {pendingActions}
        {row.reviewComplete && (
          <Tooltip title="Access granted after this quarter's review was completed. It is included in the next quarterly review.">
            <Chip size="sm" variant="soft" color="neutral" data-testid="admin-access-review-added-after-chip">
              Added after review
            </Chip>
          </Tooltip>
        )}
        {isSuggestedRevoke(row) && (
          <Tooltip title="Full admin with no MFA and no admin action in the dormant window.">
            <Box data-testid="admin-access-review-suggested-revoke">
              <StatusChip tone="warn" label="Suggested: revoke" />
            </Box>
          </Tooltip>
        )}
      </Stack>
    );
  }
  if (!decision) return <Dash />;
  return (
    <Stack gap={0.25} alignItems="flex-start">
      <StatusChip
        tone={decision.decision === 'revoked' ? 'neutral' : 'good'}
        label={decision.decision === 'revoked' ? 'Revoked' : 'Confirmed'}
      />
      <Typography level="body-xs" data-testid="admin-access-review-decided-by">
        by {[decision.reviewer.name, formatReviewDate(decision.decidedAt)].filter(Boolean).join(', ')}
      </Typography>
    </Stack>
  );
}

function lastActionCell({ live }: ReviewRow): ReactNode {
  return live?.lastAdminActionAt ? <RelativeTime at={live.lastAdminActionAt} /> : <Dash title="None recorded" />;
}

function lastSignInCell({ live }: ReviewRow): ReactNode {
  return live?.lastSignInAt ? <RelativeTime at={live.lastSignInAt} /> : <Dash title="None in 12 months" />;
}

// Column widths plus the selection and actions columns sum to the table's minWidth; keep them in step.
// The total stays under the content width of a 1440 px window, so the Decision buttons need no sideways scroll.
const ROLES_COLUMN_WIDTH = 6.5;
const BASE_COLUMNS_WIDTH = 11 + 10 + 7 + 5.5 + 5.5 + 5.5 + 11;
const SELECTION_WIDTH = 2.75;

const buildColumns = (showRoles: boolean, pendingActions: (row: ReviewRow) => ReactNode): DataColumn<ReviewRow>[] => [
  { id: 'admin', label: 'Admin', width: '11rem', wrap: true, render: row => <AdminCell row={row} /> },
  ...(showRoles
    ? [{ id: 'roles', label: 'Roles', width: `${ROLES_COLUMN_WIDTH}rem`, wrap: true, render: rolesCell }]
    : []),
  { id: 'permissions', label: 'Permissions', width: '10rem', wrap: true, render: row => <PermissionsCell row={row} /> },
  { id: 'granted', label: 'Granted by', width: '7rem', wrap: true, render: row => <GrantedByCell row={row} /> },
  {
    id: 'lastAction',
    label: 'Last admin action',
    width: '5.5rem',
    wrap: true,
    wrapHeader: true,
    render: lastActionCell,
  },
  { id: 'lastSignIn', label: 'Last sign-in', width: '5.5rem', wrap: true, wrapHeader: true, render: lastSignInCell },
  { id: 'flags', label: 'Flags', width: '5.5rem', wrap: true, render: row => <FlagsCell row={row} /> },
  {
    id: 'decision',
    label: 'Decision',
    width: '11rem',
    wrap: true,
    render: row => <DecisionCell row={row} pendingActions={pendingActions(row)} />,
  },
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
    render: role => (role.permissions.length > 0 ? role.permissions.join(', ') : <Dash />),
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

const EMPTY_SELECTION: AdminSelection = { mode: 'explicit', ids: [] };

/** The quarterly admin access review: every admin's access, its provenance and activity, and a decision per admin. */
export default function AccessReviewTab() {
  const { currentUser } = useUser();
  const [dormantDraft, setDormantDraft] = useState(String(DORMANT_DAYS_DEFAULT));
  const [dormantDays, setDormantDays] = useState(DORMANT_DAYS_DEFAULT);
  const [statusFilter, setStatusFilter] = useState<ReviewStatusFilter>('all');
  const [selection, setSelection] = useState<AdminSelection>(EMPTY_SELECTION);
  const [revoking, setRevoking] = useState<AccessReviewRow | null>(null);
  const [bulkRevoking, setBulkRevoking] = useState<AccessReviewRow[] | null>(null);
  const [exporting, setExporting] = useState(false);
  const { data, isPending, isError, refetch } = useAccessReviewReport(dormantDays);
  const decision = useAccessReviewDecision();

  const rows = useMemo(() => (data ? buildReviewRows(data) : []), [data]);
  const counts = useMemo(() => countByStatus(rows), [rows]);
  const visibleRows = useMemo(() => filterByStatus(rows, statusFilter), [rows, statusFilter]);

  const showRoles = Boolean(data && (data.roles.length > 0 || data.admins.some(admin => admin.roles.length > 0)));
  const tableMinWidth = `${SELECTION_WIDTH + BASE_COLUMNS_WIDTH + (showRoles ? ROLES_COLUMN_WIDTH : 0) + 3.5}rem`;

  const isOwn = (userId: string) => sameId(currentUser?.id, userId);
  const isSelectable = (row: ReviewRow) => !!row.live && !isOwn(row.userId);
  const selectedIds = new Set(selection.mode === 'explicit' ? selection.ids : []);
  const selectedAdmins = rows
    .filter(row => row.live && isSelectable(row) && selectedIds.has(row.userId))
    .flatMap(row => (row.live ? [row.live] : []));

  const activeAdmins = data?.admins.length ?? 0;
  const pendingSelf = counts.pending === 1 && rows.some(row => row.status === 'pending' && isOwn(row.userId));
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

  const ownTooltip = (node: ReactNode) => (
    <Tooltip title="Another admin must confirm your access">
      <span>{node}</span>
    </Tooltip>
  );

  // Pending rows are a review queue, so their decision is visible Confirm and Revoke buttons in the
  // Decision column (DESIGN_GUIDE.md, Tables); a confirmed row keeps the "..." menu for a later revoke.
  const pendingActions = (row: ReviewRow): ReactNode => {
    const { live } = row;
    if (!live || row.status !== 'pending') return null;
    const own = isOwn(live.userId);
    const buttons = (
      <Stack direction="row" gap={0.5}>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          disabled={own || decision.isPending}
          onClick={() => confirm(live)}
          sx={{ px: 1.25 }}
          data-testid="admin-access-review-confirm-btn"
        >
          Confirm
        </Button>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          disabled={own}
          onClick={() => setRevoking(live)}
          sx={{ px: 1.25 }}
          data-testid="admin-access-review-revoke-btn"
        >
          Revoke
        </Button>
      </Stack>
    );
    return own ? ownTooltip(buttons) : buttons;
  };
  const columns = buildColumns(showRoles, pendingActions);

  const rowActions = (row: ReviewRow) => {
    const { live } = row;
    if (!live || row.status !== 'confirmed') return null;
    const own = isOwn(live.userId);
    const menu = (
      <RowActionsMenu
        testId="admin-access-review-row-actions"
        ariaLabel={`Actions for ${rowLabel(row)}`}
        disabled={own}
      >
        <MenuItem color="danger" onClick={() => setRevoking(live)} data-testid="admin-access-review-revoke-btn">
          Revoke access
        </MenuItem>
      </RowActionsMenu>
    );
    return own ? ownTooltip(menu) : menu;
  };

  const statusOptions = (['all', 'pending', 'confirmed', 'revoked'] as const).map(value => ({
    value,
    label: `${value === 'all' ? 'All' : value[0].toUpperCase() + value.slice(1)} (${counts[value]})`,
  }));

  const filteredEmpty =
    statusFilter !== 'all' && rows.length > 0 ? (
      <EmptyState
        title={`No ${statusFilter} admins`}
        description="Nothing in this quarter's review has that status."
        action={
          <Button variant="outlined" onClick={() => setStatusFilter('all')}>
            Show all
          </Button>
        }
      />
    ) : (
      <EmptyState
        title="No admins"
        description="No account currently holds admin access."
        action={
          <Button variant="outlined" onClick={() => void refetch()}>
            Refresh
          </Button>
        }
      />
    );

  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP, minWidth: 0 }} data-testid="admin-access-review-tab">
      <AdminPageHeader
        title="Access review"
        count={data ? activeAdmins : undefined}
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
      {!completedAt && data?.overdueSince && (
        <AccessReviewProgressBanner pending={counts.pending} total={activeAdmins} overdueSince={data.overdueSince} />
      )}
      {!completedAt && pendingSelf && (
        <Alert color="warning" data-testid="admin-access-review-pending-self">
          Your own access needs a second reviewer: another full admin must confirm it before this review can complete.
        </Alert>
      )}

      <FilterToolbar data-testid="admin-access-review-filters">
        <SegmentedControl
          aria-label="Decision status"
          data-testid="admin-access-review-status-filter"
          options={statusOptions}
          value={statusFilter}
          onChange={setStatusFilter}
        />
        <Input
          type="number"
          size="sm"
          value={dormantDraft}
          onChange={event => changeDormantDays(event.target.value)}
          startDecorator={<FilterInputLabel>Dormant after</FilterInputLabel>}
          endDecorator={<FilterInputLabel>days</FilterInputLabel>}
          sx={{ width: '13rem' }}
          slotProps={{
            input: {
              min: ACCESS_REVIEW_DORMANT_DAYS_MIN,
              max: ACCESS_REVIEW_DORMANT_DAYS_MAX,
              'aria-label': 'Dormant after (days)',
              'data-testid': 'admin-access-review-dormant-days-input',
            },
          }}
        />
      </FilterToolbar>

      <DataTable
        label="Admin access review"
        testId="admin-access-review-table"
        rows={visibleRows}
        columns={columns}
        getRowId={row => row.userId}
        rowTestId={row => `admin-access-review-row-${row.userId}`}
        selection={selection}
        onSelectionChange={setSelection}
        isRowSelectable={isSelectable}
        rowActions={rowActions}
        isRowMuted={row => row.status === 'revoked'}
        loading={isPending}
        error={isError && !data ? 'The access review could not be loaded.' : undefined}
        onRetry={() => void refetch()}
        pagination={false}
        minWidth={tableMinWidth}
        maxHeight="none"
        empty={filteredEmpty}
      />

      <BulkActionBar
        selection={{ mode: 'explicit', ids: selectedAdmins.map(admin => admin.userId) }}
        totalMatching={selectedAdmins.length}
        onSelectAllMatching={() => undefined}
        onClear={() => setSelection(EMPTY_SELECTION)}
      >
        <Button
          size="sm"
          color="danger"
          variant="outlined"
          onClick={() => setBulkRevoking(selectedAdmins)}
          data-testid="admin-access-review-bulk-revoke-btn"
        >
          Revoke access
        </Button>
      </BulkActionBar>

      {/* A failed load is reported once, by the admin table above. */}
      {!(isError && !data) &&
        data &&
        (data.roles.length === 0 ? (
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="admin-access-review-no-roles">
            No admin roles defined. Roles created on the Roles page appear here with their members.
          </Typography>
        ) : (
          <Stack sx={{ gap: 2, minWidth: 0 }}>
            <Typography level="title-md" component="h2">
              Admin roles
            </Typography>
            <DataTable
              label="Admin roles"
              testId="admin-access-review-roles-table"
              rows={data.roles}
              columns={roleColumns}
              getRowId={role => role.id}
              rowTestId={role => `admin-access-review-role-row-${role.id}`}
              onRetry={() => void refetch()}
              pagination={false}
              minWidth="44rem"
              maxHeight="none"
            />
          </Stack>
        ))}

      {revoking && <RevokeAccessDialog admin={revoking} dormantDays={dormantDays} onClose={() => setRevoking(null)} />}
      {bulkRevoking && (
        <BulkRevokeAccessDialog
          admins={bulkRevoking}
          dormantDays={dormantDays}
          onClose={() => setBulkRevoking(null)}
          onRevoked={userIds =>
            setSelection(current =>
              current.mode === 'explicit'
                ? { mode: 'explicit', ids: current.ids.filter(id => !userIds.includes(id)) }
                : current
            )
          }
        />
      )}
    </Stack>
  );
}
