import { useState } from 'react';
import { Alert, Button, IconButton, MenuItem, Stack, Tooltip, Typography } from '@mui/joy';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import type { SpendFreezeScope } from '@bike4mind/common';
import {
  useActiveSpendFreezes,
  useFreezeSpend,
  useLiftSpendFreeze,
  useSpendMonitorOverview,
  type ActiveSpendFreezeRow,
  type SpendIncidentRow,
} from '@client/app/hooks/data/spendMonitor';
import { getErrorMessage } from '@client/app/utils/error';
import {
  AdminPageHeader,
  AdminPermissionAction,
  CopyValue,
  DataTable,
  Dash,
  EmptyState,
  RowActionsMenu,
  SectionCard,
  StatStrip,
  StatTile,
  StatusChip,
  formatUtc,
  relativeTime,
  useMissingAdminPermission,
  useUndoToast,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';
import { FreezeSpendDialog, LiftSpendFreezeDialog } from './SpendMonitor/SpendFreezeDialogs';
import {
  FREEZE_UNDO_REASON,
  LIFT_UNDO_REASON,
  RULE_LABELS,
  SCOPE_TYPE_LABELS,
  isFreezeScopeType,
} from './SpendMonitor/spendMonitorLabels';

const POLICY_HELP =
  'In shadow mode an incident that reaches its threshold is only marked "Would pause" and nothing is paused. The mode and the thresholds are edited on Admin settings.';
const MODE_LABELS = { off: 'Off', shadow: 'Shadow', enforce: 'Enforce' } as const;

const muted = { color: 'admin.inkMuted' } as const;

const formatCredits = (credits: number): string => credits.toLocaleString('en-US');
const formatThreshold = (credits: number): string => (credits > 0 ? formatCredits(credits) : 'off');

const Time = ({ iso, now }: { iso: string; now: number }) => {
  const date = new Date(iso);
  return (
    <Tooltip title={formatUtc(date)}>
      <Typography component="time" dateTime={date.toISOString()} tabIndex={0} level="body-sm" noWrap>
        {relativeTime(date, now)}
      </Typography>
    </Tooltip>
  );
};

const AccountCell = ({ label, scopeId, scopeType, testId }: AccountCellProps) => (
  <Stack gap={0.25} sx={{ minWidth: 0 }}>
    {label ? (
      <Typography level="body-sm" noWrap sx={{ color: 'admin.ink' }} title={label}>
        {label}
      </Typography>
    ) : scopeType === 'platform' ? (
      <Typography level="body-sm" sx={{ color: 'admin.ink' }}>
        Whole platform
      </Typography>
    ) : (
      <CopyValue value={scopeId} label="account id" mono truncate data-testid={`${testId}-copy`} />
    )}
    <Typography level="body-xs" sx={muted}>
      {SCOPE_TYPE_LABELS[scopeType]}
    </Typography>
  </Stack>
);
type AccountCellProps = {
  label: string | null;
  scopeId: string;
  scopeType: keyof typeof SCOPE_TYPE_LABELS;
  testId: string;
};

/** The payer's freeze state now, read with the automatic decision recorded on the incident. */
const AutoPauseCell = ({ incident }: { incident: SpendIncidentRow }) => {
  const { autoPause, frozen } = incident;
  const testId = `spend-monitor-autopause-${incident.id}`;
  if (frozen) {
    const label = autoPause?.freezeId ? 'Paused' : 'Frozen';
    return <StatusChip tone="bad" label={label} data-testid={testId} />;
  }
  if (!autoPause) return <Dash />;
  if (autoPause.mode === 'shadow') return <StatusChip tone="neutral" label="Would pause" data-testid={testId} />;
  return <StatusChip tone="neutral" label="Lifted" data-testid={testId} />;
};

const FrozenByCell = ({ freeze }: { freeze: ActiveSpendFreezeRow }) => {
  const testId = `spend-monitor-freeze-by-${freeze.id}`;
  if (freeze.actor.kind === 'admin') return <StatusChip tone="neutral" label="Admin" data-testid={testId} />;
  return (
    <Tooltip title={`Rule: ${freeze.actor.rule}`}>
      <span tabIndex={0}>
        <StatusChip tone="neutral" label="Automatic" data-testid={testId} />
      </span>
    </Tooltip>
  );
};

const IncidentActions = ({
  incident,
  disabled,
  onFreeze,
}: {
  incident: SpendIncidentRow;
  disabled: boolean;
  onFreeze: (state: FreezeDialogState) => void;
}) => {
  const { scopeType, scopeId } = incident;
  // Only a user, organization or API key can be frozen.
  if (!isFreezeScopeType(scopeType)) return null;
  return (
    <RowActionsMenu
      testId={`spend-monitor-incident-actions-${incident.id}`}
      ariaLabel={`Actions for ${incident.label ?? scopeId}`}
      disabled={disabled}
    >
      <MenuItem
        data-testid={`spend-monitor-incident-freeze-${incident.id}`}
        onClick={() => onFreeze({ initialScope: { scopeType, scopeId } })}
      >
        Freeze spending
      </MenuItem>
    </RowActionsMenu>
  );
};

type FreezeDialogState = { initialScope?: Partial<SpendFreezeScope> };

/** Live credit spend, open spend incidents and the accounts whose spending is frozen. */
export default function SpendMonitorTab() {
  const overview = useSpendMonitorOverview();
  const freezes = useActiveSpendFreezes();
  const freezeSpend = useFreezeSpend();
  const liftFreeze = useLiftSpendFreeze();
  const showUndoToast = useUndoToast();
  const freezeMissing = useMissingAdminPermission('credits:adjust');
  // Relative times are measured from the last refetch, not first mount, so they stay current while polling.
  const [mountedAt] = useState(() => Date.now());
  const now = overview.dataUpdatedAt || mountedAt;
  const [freezeDialog, setFreezeDialog] = useState<FreezeDialogState | null>(null);
  const [liftTarget, setLiftTarget] = useState<ActiveSpendFreezeRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const incidents = overview.data?.incidents ?? [];
  const frozen = freezes.data?.items ?? [];
  const autoPause = overview.data?.autoPause;
  const criticalCount = incidents.filter(incident => incident.severity === 'critical').length;
  const frozenCount = freezes.data
    ? `${formatCredits(freezes.data.items.length)}${freezes.data.nextCursor ? '+' : ''}`
    : null;

  const openFreezeDialog = (state: FreezeDialogState = {}) => {
    // A failure from the previous attempt would otherwise reappear inside the fresh dialog.
    freezeSpend.reset();
    setFreezeDialog(state);
  };
  const openLiftDialog = (freeze: ActiveSpendFreezeRow) => {
    liftFreeze.reset();
    setLiftTarget(freeze);
  };

  const freeze = async (scope: SpendFreezeScope, reason: string) => {
    setNotice(null);
    const result = await freezeSpend.mutateAsync({ ...scope, reason });
    setFreezeDialog(null);
    if (!result.created) {
      setNotice('That account was already frozen, so nothing changed.');
      return;
    }
    showUndoToast({
      message: 'Spending frozen.',
      onUndo: async () => {
        await liftFreeze.mutateAsync({ ...scope, reason: FREEZE_UNDO_REASON });
      },
    });
  };

  const lift = async (reason: string) => {
    if (!liftTarget) return;
    const scope: SpendFreezeScope = { scopeType: liftTarget.scopeType, scopeId: liftTarget.scopeId };
    setNotice(null);
    const result = await liftFreeze.mutateAsync({ ...scope, reason });
    setLiftTarget(null);
    if (!result.lifted) {
      setNotice('That freeze was already lifted, so nothing changed.');
      return;
    }
    showUndoToast({
      message: 'Freeze lifted.',
      onUndo: async () => {
        await freezeSpend.mutateAsync({ ...scope, reason: LIFT_UNDO_REASON });
      },
    });
  };

  const incidentColumns: readonly DataColumn<SpendIncidentRow>[] = [
    {
      id: 'openedAt',
      label: 'Opened',
      render: row => <Time iso={row.openedAt} now={now} />,
      sortValue: row => row.openedAt,
      width: '8rem',
    },
    {
      id: 'account',
      label: 'Account',
      render: row => (
        <AccountCell
          label={row.label}
          scopeId={row.scopeId}
          scopeType={row.scopeType}
          testId={`spend-monitor-incident-${row.id}`}
        />
      ),
      width: '14rem',
    },
    {
      id: 'rule',
      label: 'Rule',
      render: row => <Typography level="body-sm">{RULE_LABELS[row.rule]}</Typography>,
      width: '9rem',
    },
    {
      id: 'severity',
      label: 'Severity',
      render: row =>
        row.severity === 'critical' ? (
          <StatusChip tone="bad" label="Critical" />
        ) : (
          <StatusChip tone="warn" label="Warning" />
        ),
      width: '7rem',
    },
    {
      id: 'current',
      label: 'Current',
      render: row => formatCredits(row.lastValue),
      sortValue: row => row.lastValue,
      numeric: true,
      width: '7rem',
    },
    {
      id: 'peak',
      label: 'Peak',
      render: row => formatCredits(row.peakValue),
      sortValue: row => row.peakValue,
      numeric: true,
      width: '7rem',
    },
    { id: 'autoPause', label: 'Automatic pause', render: row => <AutoPauseCell incident={row} />, width: '10rem' },
  ];

  const frozenColumns: readonly DataColumn<ActiveSpendFreezeRow>[] = [
    {
      id: 'account',
      label: 'Account',
      render: row =>
        row.label ? (
          <Typography level="body-sm" noWrap sx={{ color: 'admin.ink' }} title={row.label}>
            {row.label}
          </Typography>
        ) : (
          <CopyValue
            value={row.scopeId}
            label="account id"
            mono
            truncate
            data-testid={`spend-monitor-freeze-${row.id}-copy`}
          />
        ),
      width: '14rem',
    },
    {
      id: 'type',
      label: 'Type',
      render: row => <Typography level="body-sm">{SCOPE_TYPE_LABELS[row.scopeType]}</Typography>,
      width: '8rem',
    },
    {
      id: 'frozenAt',
      label: 'Frozen',
      render: row => <Time iso={row.frozenAt} now={now} />,
      sortValue: row => row.frozenAt,
      width: '8rem',
    },
    { id: 'by', label: 'By', render: row => <FrozenByCell freeze={row} />, width: '8rem' },
    { id: 'reason', label: 'Reason', render: row => row.reason, wrap: true },
  ];

  return (
    <Stack gap={ADMIN_REGION_GAP} sx={{ minWidth: 0 }} data-testid="admin-spend-monitor-tab">
      <AdminPageHeader
        title="Spend monitor"
        description="Live credit spend, open spend incidents and frozen accounts."
        actions={
          <AdminPermissionAction requirement="credits:adjust">
            {disabled => (
              <Button disabled={disabled} onClick={() => openFreezeDialog()} data-testid="spend-monitor-freeze-btn">
                Freeze spending
              </Button>
            )}
          </AdminPermissionAction>
        }
      />
      {notice && (
        <Alert color="neutral" data-testid="spend-monitor-notice">
          {notice}
        </Alert>
      )}
      {(overview.error || freezes.error) && (
        <Alert color="danger" data-testid="spend-monitor-load-error">
          {getErrorMessage(overview.error ?? freezes.error)}
        </Alert>
      )}
      <StatStrip aria-label="Spend monitor key numbers">
        <StatTile
          label="Credits, last hour"
          value={overview.data ? overview.data.platform.lastHourCredits : <Dash />}
        />
        <StatTile
          label="Credits, last 24 hours"
          value={overview.data ? overview.data.platform.last24hCredits : <Dash />}
        />
        <StatTile
          label="Open incidents"
          value={overview.data ? incidents.length : <Dash />}
          comparison={overview.data ? `${criticalCount} critical` : undefined}
        />
        <StatTile label="Frozen accounts" value={frozenCount ?? <Dash />} />
        <StatTile
          label="Automatic pause"
          help={
            <Tooltip variant="outlined" placement="bottom-start" sx={{ maxWidth: 360 }} title={POLICY_HELP}>
              <IconButton
                size="sm"
                variant="plain"
                aria-label="About automatic pause"
                data-testid="spend-monitor-autopause-help-btn"
                sx={{ '--IconButton-size': '24px' }}
              >
                <HelpOutlineIcon />
              </IconButton>
            </Tooltip>
          }
          value={autoPause ? MODE_LABELS[autoPause.mode] : <Dash />}
          comparison={
            autoPause
              ? `Standard ${formatThreshold(autoPause.minCreditsByTier.standard)} - Paid ${formatThreshold(autoPause.minCreditsByTier.paid)} - Trusted ${formatThreshold(autoPause.minCreditsByTier.trusted)}`
              : undefined
          }
        />
      </StatStrip>
      <SectionCard
        title="Open incidents"
        body="custom"
        action={
          <Typography level="body-xs" sx={muted}>
            Credits per 15 minutes
          </Typography>
        }
        data-testid="spend-monitor-incidents-card"
      >
        <DataTable<SpendIncidentRow>
          framed={false}
          rows={incidents}
          columns={incidentColumns}
          getRowId={row => row.id}
          label="Open spend incidents"
          testId="spend-monitor-incidents-table"
          rowTestId={row => `spend-monitor-incident-row-${row.id}`}
          loading={overview.isPending}
          error={overview.error ? "Couldn't load spend incidents." : undefined}
          onRetry={() => void overview.refetch()}
          pagination={false}
          minWidth="62rem"
          rowActions={row => <IncidentActions incident={row} disabled={!!freezeMissing} onFreeze={openFreezeDialog} />}
          empty={
            <EmptyState
              title="No open incidents"
              action={
                <Button
                  variant="outlined"
                  color="neutral"
                  onClick={() => void overview.refetch()}
                  data-testid="spend-monitor-incidents-refresh-btn"
                >
                  Refresh
                </Button>
              }
            />
          }
        />
      </SectionCard>
      <SectionCard title="Frozen accounts" body="custom" data-testid="spend-monitor-frozen-card">
        <DataTable<ActiveSpendFreezeRow>
          framed={false}
          rows={frozen}
          columns={frozenColumns}
          getRowId={row => row.id}
          label="Frozen accounts"
          testId="spend-monitor-frozen-table"
          rowTestId={row => `spend-monitor-freeze-row-${row.id}`}
          loading={freezes.isPending}
          error={freezes.error ? "Couldn't load frozen accounts." : undefined}
          onRetry={() => void freezes.refetch()}
          pagination={false}
          minWidth="50rem"
          rowActions={row => (
            <RowActionsMenu
              testId={`spend-monitor-freeze-actions-${row.id}`}
              ariaLabel={`Actions for ${row.label ?? row.scopeId}`}
              disabled={!!freezeMissing}
            >
              <MenuItem data-testid={`spend-monitor-lift-${row.id}`} onClick={() => openLiftDialog(row)}>
                Lift freeze
              </MenuItem>
            </RowActionsMenu>
          )}
          empty={
            <EmptyState
              title="No frozen accounts"
              action={
                <AdminPermissionAction requirement="credits:adjust">
                  {disabled => (
                    <Button
                      variant="outlined"
                      color="neutral"
                      disabled={disabled}
                      onClick={() => openFreezeDialog()}
                      data-testid="spend-monitor-frozen-empty-btn"
                    >
                      Freeze spending
                    </Button>
                  )}
                </AdminPermissionAction>
              }
            />
          }
        />
      </SectionCard>
      {freezeDialog && (
        <FreezeSpendDialog
          initialScope={freezeDialog.initialScope}
          pending={freezeSpend.isPending}
          error={freezeSpend.error}
          onClose={() => setFreezeDialog(null)}
          onFreeze={freeze}
        />
      )}
      {liftTarget && (
        <LiftSpendFreezeDialog
          scope={{ scopeType: liftTarget.scopeType, scopeId: liftTarget.scopeId }}
          label={liftTarget.label}
          pending={liftFreeze.isPending}
          error={liftFreeze.error}
          onClose={() => setLiftTarget(null)}
          onLift={lift}
        />
      )}
    </Stack>
  );
}
