import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  DialogContent,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  ListDivider,
  MenuItem,
  Stack,
  Typography,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import { toast } from 'sonner';
import type { IMcpConnectionPublic } from '@bike4mind/common';
import AddMcpConnectorForm from '@client/app/components/integrations/customMcp/AddMcpConnectorForm';
import McpConnectionDetailsFields, {
  type McpConnectionDetailsDraft,
} from '@client/app/components/integrations/customMcp/McpConnectionDetailsFields';
import McpToolReview from '@client/app/components/integrations/customMcp/McpToolReview';
import {
  connectionDetailsPatch,
  offeredToolCount,
  pendingReviewCount,
} from '@client/app/components/integrations/customMcp/customMcpModel';
import {
  mcpConnectionErrorMessage,
  useDeleteMcpConnection,
  usePlatformMcpConnections,
  useRefreshMcpConnectionTools,
  useRotateMcpConnectionApiKey,
  useUpdateMcpConnection,
} from '@client/app/hooks/data/mcpConnections';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import {
  ADMIN_REASON_PRESETS,
  ActionDialog,
  AdminDialog,
  AdminDialogFooter,
  AdminPageHeader,
  Dash,
  DataTable,
  EmptyState,
  ErrorState,
  RelativeTime,
  SettingsSection,
  StatusChip,
  type DataColumn,
} from './shared';
import { adminFocus } from './shared/adminStyles';
import { AdminPermissionAction, useMissingAdminPermission } from './shared/MissingPermission';
import { RowActionsMenu } from './shared/RowActionsMenu';

type Connection = IMcpConnectionPublic;
type Dialog = { kind: 'review' | 'api-key' | 'details' | 'remove'; connection: Connection };

const ADD_BUTTON_ID = 'platform-mcp-add-btn';
const rowMenuId = (id: string) => `platform-mcp-row-actions-${id}`;

const FEATURE_OFF_REASON = 'Turn on Enable MCP Server and Enable Custom MCP Connectors in Admin settings first.';
const BLOCKED = 'Blocked by the connector policy.';

const AUTH_LABELS: Record<Connection['auth']['kind'], string> = {
  api_key: 'API key',
  none: 'No authentication',
  oauth: 'Provider sign-in',
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A platform row's status in admin terms; a refused connector names the action that fixes it. */
const rowStatus = (connection: Connection): { tone: AdminStatusTone; label: string; detail?: string } => {
  switch (connection.status) {
    case 'blocked_by_policy':
      return { tone: 'neutral', label: 'Blocked', detail: BLOCKED };
    case 'pending_auth':
    case 'needs_reconnect':
      return connection.auth.kind === 'api_key'
        ? { tone: 'bad', label: 'Key refused', detail: 'Replace the API key to reconnect.' }
        : {
            tone: 'bad',
            label: 'Server requires authentication',
            detail: 'Remove it and add it again with an API key.',
          };
    case 'error':
      return { tone: 'bad', label: 'Error', detail: connection.lastError?.message };
    default:
      return pendingReviewCount(connection) > 0
        ? { tone: 'warn', label: 'Pending review' }
        : { tone: 'good', label: 'Connected' };
  }
};

const columns: DataColumn<Connection>[] = [
  {
    id: 'name',
    label: 'Name',
    wrap: true,
    render: connection => {
      const status = rowStatus(connection);
      return (
        <Stack gap={0.25} sx={{ minWidth: 0 }}>
          <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
            <Typography level="inherit" sx={{ color: 'admin.ink', fontWeight: 500 }}>
              {connection.displayName}
            </Typography>
            <StatusChip tone={status.tone} label={status.label} data-testid={`platform-mcp-status-${connection.id}`} />
            {!connection.enabled && (
              <StatusChip tone="neutral" label="Disabled" data-testid={`platform-mcp-disabled-${connection.id}`} />
            )}
          </Stack>
          {status.detail && (
            <Typography
              level="body-xs"
              sx={{ color: 'admin.inkMuted' }}
              data-testid={`platform-mcp-detail-${connection.id}`}
            >
              {status.detail}
            </Typography>
          )}
        </Stack>
      );
    },
  },
  {
    id: 'host',
    label: 'Host',
    width: '13rem',
    render: connection => <span data-testid={`platform-mcp-host-${connection.id}`}>{connection.urlHost}</span>,
  },
  {
    id: 'auth',
    label: 'Authentication',
    width: '10rem',
    render: connection => AUTH_LABELS[connection.auth.kind],
  },
  {
    id: 'tools',
    label: 'Tools',
    width: '15rem',
    wrap: true,
    render: connection => {
      const pending = pendingReviewCount(connection);
      return (
        <Stack data-testid={`platform-mcp-tools-${connection.id}`}>
          <span>
            {connection.enabled && connection.status === 'connected'
              ? `${offeredToolCount(connection)} of ${plural(connection.tools.length, 'tool', 'tools')} offered to users`
              : 'Not offered to users'}
          </span>
          {pending > 0 && (
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              {`${pending} waiting for review`}
            </Typography>
          )}
        </Stack>
      );
    },
  },
  {
    id: 'lastUsed',
    label: 'Last used',
    width: '8rem',
    render: connection =>
      connection.lastUsedAt ? (
        <RelativeTime at={connection.lastUsedAt} data-testid={`platform-mcp-last-used-${connection.id}`} />
      ) : (
        <Dash title="Never used" />
      ),
  },
];

function ConnectorRowMenu({
  connection,
  featureOffReason,
  onReview,
  onEditDetails,
  onReplaceKey,
  onRemove,
}: {
  connection: Connection;
  featureOffReason: string | null;
  onReview: (connection: Connection) => void;
  onEditDetails: (connection: Connection) => void;
  onReplaceKey: (connection: Connection) => void;
  onRemove: (connection: Connection) => void;
}) {
  const update = useUpdateMcpConnection('platform');
  const refresh = useRefreshMcpConnectionTools('platform');
  const { id, displayName } = connection;
  const blocked = connection.status === 'blocked_by_policy';

  const refreshTools = () =>
    refresh.mutate(id, {
      onSuccess: ({ discovery, connection: refreshed }) => {
        const changes = discovery.added.length + discovery.changed.length;
        toast.success(changes > 0 ? `${plural(changes, 'tool', 'tools')} to review.` : 'Tools are up to date.');
        if (pendingReviewCount(refreshed) > 0) onReview(refreshed);
      },
      onError: error => toast.error(mcpConnectionErrorMessage(error, 'Could not refresh the tools.')),
    });

  const setEnabled = (enabled: boolean) =>
    update.mutate(
      { id, enabled },
      { onError: error => toast.error(mcpConnectionErrorMessage(error, 'Could not update the connector.')) }
    );

  return (
    <RowActionsMenu
      testId={rowMenuId(id)}
      ariaLabel={`Actions for ${displayName}`}
      loading={update.isPending || refresh.isPending}
    >
      {!blocked && connection.status === 'connected' && connection.tools.length > 0 && (
        <MenuItem onClick={() => onReview(connection)} data-testid={`platform-mcp-review-${id}`}>
          Review tools
        </MenuItem>
      )}
      {/* Text only: it reaches no remote server, so neither the switch nor the policy gates it. */}
      <AdminPermissionAction requirement="settings:manage">
        {disabled => (
          <MenuItem
            disabled={disabled}
            onClick={() => onEditDetails(connection)}
            data-testid={`platform-mcp-edit-${id}`}
          >
            Edit details
          </MenuItem>
        )}
      </AdminPermissionAction>
      {!blocked && connection.status !== 'pending_auth' && (
        <AdminPermissionAction requirement="settings:manage" blockedReason={featureOffReason}>
          {disabled => (
            <MenuItem disabled={disabled} onClick={refreshTools} data-testid={`platform-mcp-refresh-${id}`}>
              Refresh tools
            </MenuItem>
          )}
        </AdminPermissionAction>
      )}
      {!blocked && connection.auth.kind === 'api_key' && (
        <AdminPermissionAction requirement="settings:manage" blockedReason={featureOffReason}>
          {disabled => (
            <MenuItem
              disabled={disabled}
              onClick={() => onReplaceKey(connection)}
              data-testid={`platform-mcp-api-key-${id}`}
            >
              Replace API key
            </MenuItem>
          )}
        </AdminPermissionAction>
      )}
      <AdminPermissionAction requirement="settings:manage" blockedReason={blocked ? BLOCKED : null}>
        {disabled => (
          <MenuItem
            disabled={disabled}
            onClick={() => setEnabled(!connection.enabled)}
            data-testid={`platform-mcp-toggle-${id}`}
          >
            {connection.enabled ? 'Turn off for all users' : 'Turn on for all users'}
          </MenuItem>
        )}
      </AdminPermissionAction>
      <ListDivider />
      <AdminPermissionAction requirement="settings:manage">
        {disabled => (
          <MenuItem
            color="danger"
            disabled={disabled}
            onClick={() => onRemove(connection)}
            data-testid={`platform-mcp-remove-${id}`}
          >
            Remove
          </MenuItem>
        )}
      </AdminPermissionAction>
    </RowActionsMenu>
  );
}

function ReplaceKeyDialog({
  connection,
  onClose,
  onReview,
}: {
  connection: Connection;
  onClose: () => void;
  onReview: (connection: Connection) => void;
}) {
  const rotate = useRotateMcpConnectionApiKey('platform');
  // Mounted only while open, so a typed key is gone once the dialog closes.
  const [apiKey, setApiKey] = useState('');
  const last4 = connection.auth.apiKey?.last4;

  const save = () =>
    rotate.mutate(
      { id: connection.id, value: apiKey },
      {
        onSuccess: rotated => {
          setApiKey('');
          if (rotated.status === 'connected') toast.success('API key replaced.');
          else toast.error(rotated.lastError?.message ?? 'The server did not accept the key.');
          if (rotated.status === 'connected' && pendingReviewCount(rotated) > 0) onReview(rotated);
          else onClose();
        },
        onError: error => toast.error(mcpConnectionErrorMessage(error, 'Could not replace the API key.')),
      }
    );

  return (
    <AdminDialog
      onClose={onClose}
      closeDisabled={rotate.isPending}
      title={`Replace API key for ${connection.displayName}`}
      data-testid="platform-mcp-api-key-dialog"
    >
      <DialogContent>
        <FormControl>
          <FormLabel>New API key</FormLabel>
          <Input
            type="password"
            autoComplete="off"
            autoFocus
            value={apiKey}
            onChange={event => setApiKey(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && apiKey.trim() && !rotate.isPending) save();
            }}
            slotProps={{ input: { 'data-testid': 'platform-mcp-api-key-input' } }}
          />
          {last4 && (
            <FormHelperText data-testid="platform-mcp-api-key-hint">{`Replaces the key ending ${last4}.`}</FormHelperText>
          )}
        </FormControl>
      </DialogContent>
      <AdminDialogFooter>
        <Button
          variant="plain"
          color="neutral"
          disabled={rotate.isPending}
          onClick={onClose}
          data-testid="platform-mcp-api-key-cancel-btn"
        >
          Cancel
        </Button>
        <Button
          loading={rotate.isPending}
          disabled={!apiKey.trim()}
          onClick={save}
          data-testid="platform-mcp-api-key-save-btn"
        >
          Replace key
        </Button>
      </AdminDialogFooter>
    </AdminDialog>
  );
}

function EditDetailsDialog({ connection, onClose }: { connection: Connection; onClose: () => void }) {
  const update = useUpdateMcpConnection('platform');
  const [draft, setDraft] = useState<McpConnectionDetailsDraft>({
    displayName: connection.displayName,
    description: connection.description ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const canSave = draft.displayName.trim() !== '' && !update.isPending;

  const save = () => {
    const changes = connectionDetailsPatch(connection, draft);
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setError(null);
    update.mutate(
      { id: connection.id, ...changes },
      {
        onSuccess: () => {
          toast.success('Details saved.');
          onClose();
        },
        onError: failure => setError(mcpConnectionErrorMessage(failure, 'Could not save the details.')),
      }
    );
  };

  return (
    <AdminDialog
      onClose={onClose}
      closeDisabled={update.isPending}
      title={`Edit details for ${connection.displayName}`}
      width={520}
      data-testid="platform-mcp-details-dialog"
    >
      <DialogContent>
        <Stack
          component="form"
          gap={1.5}
          onSubmit={event => {
            event.preventDefault();
            if (canSave) save();
          }}
        >
          <McpConnectionDetailsFields
            draft={draft}
            onChange={setDraft}
            scope="platform"
            testIdPrefix="platform-mcp-details"
            size="md"
          />
        </Stack>
        {error && <ErrorState message={error} onRetry={save} retrying={update.isPending} />}
      </DialogContent>
      <AdminDialogFooter>
        <Button
          variant="plain"
          color="neutral"
          disabled={update.isPending}
          onClick={onClose}
          data-testid="platform-mcp-details-cancel-btn"
        >
          Cancel
        </Button>
        <Button
          loading={update.isPending}
          disabled={!canSave}
          onClick={save}
          data-testid="platform-mcp-details-save-btn"
        >
          Save details
        </Button>
      </AdminDialogFooter>
    </AdminDialog>
  );
}

/** Platform MCP connectors: set up once by an admin, offered in every user's Tools menu. */
const PlatformMcpConnectorsSection = () => {
  const impersonating = useAccessToken(s => s.impersonating);
  const { isFeatureEnabled, authedSettingsLoaded } = useAdminSettingsCache();
  const { data, isPending, isError, refetch } = usePlatformMcpConnections();
  const missingPermission = useMissingAdminPermission('settings:manage');
  const remove = useDeleteMcpConnection('platform');
  const [adding, setAdding] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // The control that takes focus once the open dialog or form is gone: the row's menu, or Add connector.
  const focusTarget = useRef<string | null>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  const connections = data ?? [];
  // Both flags read as off until the signed-in settings arrive.
  const featureOff =
    authedSettingsLoaded && (!isFeatureEnabled('EnableMCPServer') || !isFeatureEnabled('EnableCustomMcpConnectors'));
  const featureOffReason = featureOff ? FEATURE_OFF_REASON : null;

  // Runs after the commit that unmounts a dialog, so it wins over the dialog's own focus return.
  useEffect(() => {
    if (!focusTarget.current || dialog) return;
    const target = sectionRef.current?.querySelector<HTMLElement>(`[data-testid="${focusTarget.current}"]`);
    focusTarget.current = null;
    // A disabled Add connector sits in a focusable wrapper that carries its reason.
    (target instanceof HTMLButtonElement && target.disabled ? target.parentElement : target)?.focus();
  });
  const setFocusTarget = (testId: string) => {
    focusTarget.current = testId;
  };

  const closeDialog = () => {
    if (dialog) setFocusTarget(rowMenuId(dialog.connection.id));
    setDialog(null);
  };
  const openReview = (connection: Connection) => setDialog({ kind: 'review', connection });

  const onCreated = (connection: Connection) => {
    setAdding(false);
    if (connection.status === 'connected' && connection.tools.length > 0) openReview(connection);
    else setFocusTarget(rowMenuId(connection.id));
  };

  const confirmRemove = (connection: Connection) =>
    remove.mutate(connection.id, {
      onSuccess: () => {
        toast.success(`${connection.displayName} removed.`);
        setDialog(null);
        setFocusTarget(ADD_BUTTON_ID);
      },
      onError: error => toast.error(mcpConnectionErrorMessage(error, 'Could not remove the connector.')),
    });

  const addButton = (
    <AdminPermissionAction requirement="settings:manage" blockedReason={featureOffReason}>
      {disabled => (
        <Button
          size="sm"
          variant="outlined"
          startDecorator={<AddIcon />}
          disabled={disabled || adding}
          onClick={() => setAdding(true)}
          data-testid={ADD_BUTTON_ID}
          sx={adminFocus}
        >
          Add connector
        </Button>
      )}
    </AdminPermissionAction>
  );

  const body = () => {
    if (impersonating) {
      return (
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="platform-mcp-impersonating">
          Platform connectors are not shown while impersonating a user.
        </Typography>
      );
    }
    return (
      <>
        {adding && (
          <SettingsSection data-testid="platform-mcp-add">
            <Typography level="title-sm" component="h3" sx={{ mb: 1.5, color: 'admin.ink' }}>
              Add a platform connector
            </Typography>
            <Box sx={{ maxWidth: '40rem' }}>
              <AddMcpConnectorForm
                scope="platform"
                onCreated={onCreated}
                onCancel={() => {
                  setAdding(false);
                  setFocusTarget(ADD_BUTTON_ID);
                }}
              />
            </Box>
          </SettingsSection>
        )}
        {!(adding && connections.length === 0) && (
          <DataTable
            label="Platform connectors"
            testId="platform-mcp-table"
            rows={connections}
            columns={columns}
            getRowId={connection => connection.id}
            rowTestId={connection => `platform-mcp-row-${connection.id}`}
            loading={isPending}
            error={isError ? 'Could not load the platform connectors.' : undefined}
            onRetry={() => void refetch()}
            empty={
              <EmptyState
                title="No platform connectors yet"
                description="Add one to list it in every user's Tools menu."
                action={addButton}
              />
            }
            rowActions={connection => (
              <ConnectorRowMenu
                connection={connection}
                featureOffReason={featureOffReason}
                onReview={openReview}
                onEditDetails={target => setDialog({ kind: 'details', connection: target })}
                onReplaceKey={target => setDialog({ kind: 'api-key', connection: target })}
                onRemove={target => setDialog({ kind: 'remove', connection: target })}
              />
            )}
            minWidth="56rem"
            maxHeight="none"
          />
        )}
      </>
    );
  };

  const removing = dialog?.kind === 'remove' ? dialog.connection : null;

  return (
    <Stack component="section" ref={sectionRef} gap={1.5} sx={{ minWidth: 0 }} data-testid="platform-mcp-section">
      <AdminPageHeader
        level="section"
        title="Platform connectors"
        count={data?.length}
        description="A platform connector appears in every user's Tools menu switched off, and nothing of it reaches a chat until that user turns it on."
        actions={connections.length > 0 ? addButton : undefined}
      />
      {featureOff && (
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="platform-mcp-feature-off">
          Users see no platform connectors while Enable MCP Server or Enable Custom MCP Connectors is off in Admin
          settings, and connectors cannot be added, refreshed or given a new key.
        </Typography>
      )}
      {body()}

      {dialog?.kind === 'review' && (
        <AdminDialog
          onClose={closeDialog}
          title={`Review tools for ${dialog.connection.displayName}`}
          width={720}
          data-testid="platform-mcp-review-dialog"
        >
          <DialogContent>
            <McpToolReview
              connection={dialog.connection}
              scope="platform"
              readOnlyReason={missingPermission}
              onDone={closeDialog}
            />
          </DialogContent>
        </AdminDialog>
      )}
      {dialog?.kind === 'api-key' && (
        <ReplaceKeyDialog connection={dialog.connection} onClose={closeDialog} onReview={openReview} />
      )}
      {dialog?.kind === 'details' && <EditDetailsDialog connection={dialog.connection} onClose={closeDialog} />}
      {/* The delete route takes no reason, so the dialog collects one without sending it. */}
      <ActionDialog
        open={!!removing}
        onClose={closeDialog}
        title="Remove connector"
        description={
          <>
            Removes <b>{removing?.displayName}</b> from every user&apos;s Tools menu. Users who turned it on lose its
            tools. If you add it again later, it starts switched off for everyone.
            {removing?.auth.kind === 'api_key' && ' Revoke the API key at the provider if you no longer need it.'}
          </>
        }
        reasonPresets={ADMIN_REASON_PRESETS.platformMcpConnectorRemove}
        reasonAudited={false}
        tone="danger"
        typedConfirm={removing ? { expected: removing.displayName.trim(), noun: 'connector name' } : undefined}
        confirmLabel="Remove connector"
        pending={remove.isPending}
        onConfirm={() => (removing ? confirmRemove(removing) : undefined)}
        data-testid="platform-mcp-remove-dialog"
      />
    </Stack>
  );
};

export default PlatformMcpConnectorsSection;
