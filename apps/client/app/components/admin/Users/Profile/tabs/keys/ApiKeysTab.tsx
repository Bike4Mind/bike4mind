import React, { useMemo, useState } from 'react';
import { Box, Button, IconButton, Stack, Tooltip, Typography } from '@mui/joy';
import AutorenewRoundedIcon from '@mui/icons-material/AutorenewRounded';
import BlockRoundedIcon from '@mui/icons-material/BlockRounded';
import { toast } from 'sonner';
import {
  ApiKeyStatus,
  type AdminApiKeyRequestCounts,
  type ApiKeyRateLimitUsage,
  type IUserApiKeyDocument,
} from '@bike4mind/common';
import { useAdminGetUserApiKeys } from '@client/app/hooks/data/userApiKeys';
import {
  useAdminRestoreApiKey,
  useAdminRevokeAllApiKeys,
  useAdminRevokeApiKey,
  useAdminRotateApiKey,
} from '@client/app/hooks/data/adminUserCredits';
import AdminGenerateApiKeyModal from '../../../Details/AdminGenerateApiKeyModal';
import AdminApiKeysModal from '../../../Details/AdminApiKeysModal';
import {
  ADMIN_REASON_PRESETS,
  ActionDialog,
  CopyValue,
  DataTable,
  InlineBar,
  RelativeTime,
  SectionCard,
  StatusChip,
  useUndoToast,
  type DataColumn,
} from '../../../../shared';
import type { AdminUserProfile } from '../../userProfileModel';
import {
  KEY_STATUS,
  SINGLE_REVOKE_REASON,
  UNDO_REVOKE_REASON,
  apiErrorMessage,
  describeKeyAccess,
  describeLiveLimit,
  maxWeeklyRequests,
  requestCounts,
} from './apiKeysModel';

const DASH = '-';
const VISIBLE_SCOPES = 1;

type NewSecret = { name: string; keyPrefix: string; secret: string };

type KeyRowActions = {
  onRevoke: (key: IUserApiKeyDocument) => void;
  onRotate: (key: IUserApiKeyDocument) => void;
  pendingKeyId: string | null;
};

const Scopes: React.FC<{ scopes: readonly string[] }> = ({ scopes }) => {
  if (scopes.length === 0) return <>{DASH}</>;
  const hidden = scopes.length - VISIBLE_SCOPES;
  return (
    <Stack direction="row" alignItems="center" gap={0.5} title={scopes.join(', ')}>
      {scopes.slice(0, VISIBLE_SCOPES).map(scope => (
        <Box
          key={scope}
          component="span"
          sx={{
            fontFamily: 'code',
            fontSize: 12,
            px: 0.75,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            borderRadius: '6px',
            bgcolor: 'admin.status.neutral.background',
            color: 'admin.status.neutral.foreground',
          }}
        >
          {scope}
        </Box>
      ))}
      {hidden > 0 && (
        <Typography component="span" level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          +{hidden}
        </Typography>
      )}
    </Stack>
  );
};

const RowActions: React.FC<{ apiKey: IUserApiKeyDocument } & KeyRowActions> = ({
  apiKey,
  onRevoke,
  onRotate,
  pendingKeyId,
}) => {
  if (apiKey.status !== ApiKeyStatus.ACTIVE) return null;
  const busy = pendingKeyId === apiKey.id;
  return (
    <Stack direction="row" gap={0.5} justifyContent="flex-end">
      <Tooltip title="Rotate key">
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label={`Rotate ${apiKey.name}`}
          disabled={busy}
          onClick={() => onRotate(apiKey)}
          data-testid="user-keys-rotate-btn"
          sx={{ color: 'admin.inkMuted' }}
        >
          <AutorenewRoundedIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
      <Tooltip title="Revoke key">
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label={`Revoke ${apiKey.name}`}
          disabled={busy}
          onClick={() => onRevoke(apiKey)}
          data-testid="user-keys-revoke-btn"
          sx={{ color: 'admin.inkMuted', '&:hover': { color: 'admin.danger' } }}
        >
          <BlockRoundedIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
    </Stack>
  );
};

const buildColumns = (
  requests: Readonly<Record<string, AdminApiKeyRequestCounts>> | undefined,
  liveUsage: Readonly<Record<string, ApiKeyRateLimitUsage>> | undefined,
  actions: KeyRowActions
): DataColumn<IUserApiKeyDocument>[] => {
  const weeklyMax = maxWeeklyRequests(requests);
  return [
    {
      id: 'name',
      label: 'Name and prefix',
      sortValue: key => key.name.toLowerCase(),
      render: key => (
        <Stack alignItems="flex-start" gap={0.25} sx={{ minWidth: 0 }}>
          <Typography level="body-sm" noWrap sx={{ color: 'admin.ink', fontWeight: 500, maxWidth: '100%' }}>
            {key.name}
          </Typography>
          <CopyValue value={key.keyPrefix} label="key prefix" mono data-testid={`user-keys-copy-${key.id}-btn`} />
        </Stack>
      ),
    },
    { id: 'scopes', label: 'Scopes', render: key => <Scopes scopes={key.scopes ?? []} /> },
    {
      id: 'lastUsed',
      label: 'Last used',
      sortValue: key => (key.lastUsedAt ? new Date(key.lastUsedAt).getTime() : 0),
      render: key => (
        <Stack gap={0.25}>
          <span>{key.lastUsedAt ? <RelativeTime at={key.lastUsedAt} /> : 'Never'}</span>
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
            Created <RelativeTime at={key.createdAt} />
          </Typography>
        </Stack>
      ),
    },
    {
      id: 'requests',
      label: 'Requests, 7d',
      numeric: true,
      sortValue: key => requestCounts(requests, key.id).last7d,
      render: key => {
        const { last24h, last7d } = requestCounts(requests, key.id);
        return (
          <Stack alignItems="flex-end" gap={0.25}>
            <Stack direction="row" alignItems="center" gap={1}>
              <InlineBar value={last7d} max={weeklyMax} />
              <span>{last7d.toLocaleString('en-US')}</span>
            </Stack>
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              {last24h.toLocaleString('en-US')} in 24h
            </Typography>
          </Stack>
        );
      },
    },
    {
      id: 'status',
      label: 'Status',
      render: key => {
        const liveLimit = describeLiveLimit(key, liveUsage?.[key.id]);
        if (liveLimit) {
          return (
            <Tooltip title={liveLimit}>
              <span tabIndex={0} data-testid="user-keys-live-limit">
                <StatusChip tone="warn" label="At limit" />
              </span>
            </Tooltip>
          );
        }
        const status = KEY_STATUS[key.status] ?? { label: key.status, tone: 'neutral' as const };
        return <StatusChip tone={status.tone} label={status.label} />;
      },
    },
    { id: 'actions', label: '', render: key => <RowActions apiKey={key} {...actions} /> },
  ];
};

const SecretOnce: React.FC<{ secret: NewSecret; onDone: () => void }> = ({ secret, onDone }) => (
  <Stack
    gap={1}
    data-testid="user-keys-new-secret"
    sx={{
      m: 2,
      p: 2,
      borderRadius: '8px',
      border: '1px solid',
      borderColor: 'admin.selection.border',
      bgcolor: 'admin.selection.background',
    }}
  >
    <Typography level="body-sm" sx={{ color: 'admin.ink', fontWeight: 600 }}>
      New secret for {secret.name}
    </Typography>
    <Typography level="body-xs" sx={{ color: 'admin.inkSecondary' }}>
      Shown once. Copy it now and send it to the user over a secure channel; it cannot be shown again.
    </Typography>
    <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1} flexWrap="wrap">
      <CopyValue value={secret.secret} label="new secret" mono data-testid="user-keys-secret-copy-btn" />
      <Button size="sm" variant="outlined" color="neutral" onClick={onDone} data-testid="user-keys-secret-done-btn">
        Done
      </Button>
    </Stack>
  </Stack>
);

/** The user's API keys with request volume, per-key revoke (with Undo) and rotate, and revoke all. */
export const ApiKeysTab: React.FC<{ user: AdminUserProfile }> = ({ user }) => {
  const keys = useAdminGetUserApiKeys(user.id, { refetchInterval: 15_000 });
  const revoke = useAdminRevokeApiKey(user.id);
  const restore = useAdminRestoreApiKey(user.id);
  const rotate = useAdminRotateApiKey(user.id);
  const revokeAll = useAdminRevokeAllApiKeys(user.id);
  const showUndo = useUndoToast();

  const [modal, setModal] = useState<'generate' | 'limits' | null>(null);
  const [rotating, setRotating] = useState<IUserApiKeyDocument | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);
  const [newSecret, setNewSecret] = useState<NewSecret | null>(null);
  const [pendingKeyId, setPendingKeyId] = useState<string | null>(null);

  const apiKeys = useMemo(() => keys.data?.apiKeys ?? [], [keys.data]);
  const activeCount = apiKeys.filter(key => key.status === ApiKeyStatus.ACTIVE).length;
  const access = keys.data?.access ? describeKeyAccess(keys.data.access) : null;

  const revokeKey = async (key: IUserApiKeyDocument) => {
    setPendingKeyId(key.id);
    try {
      await revoke.mutateAsync({ keyId: key.id, reason: SINGLE_REVOKE_REASON });
    } catch (error) {
      toast.error(apiErrorMessage(error, `${key.name} could not be revoked. Try again.`));
      return;
    } finally {
      setPendingKeyId(null);
    }
    showUndo({
      message: `Revoked ${key.name}. Requests using it now fail.`,
      onUndo: async () => {
        try {
          await restore.mutateAsync({ keyId: key.id, reason: UNDO_REVOKE_REASON });
        } catch (error) {
          throw new Error(apiErrorMessage(error, `${key.name} could not be restored.`));
        }
      },
    });
  };

  const rotateKey = async (reason: string) => {
    if (!rotating) return;
    try {
      const result = await rotate.mutateAsync({ keyId: rotating.id, reason });
      setNewSecret({ name: rotating.name, keyPrefix: result.keyPrefix, secret: result.secret });
      setRotating(null);
    } catch (error) {
      toast.error(apiErrorMessage(error, `${rotating.name} could not be rotated. Try again.`));
      throw error;
    }
  };

  const revokeAllKeys = async (reason: string) => {
    try {
      const result = await revokeAll.mutateAsync(reason);
      setRevokingAll(false);
      toast.success(
        `Revoked ${result.revokedKeyIds.length} API ${result.revokedKeyIds.length === 1 ? 'key' : 'keys'}.`
      );
    } catch (error) {
      toast.error(apiErrorMessage(error, 'The keys could not be revoked. Try again.'));
      throw error;
    }
  };

  const columns = buildColumns(keys.data?.requests, keys.data?.liveUsage, {
    onRevoke: key => void revokeKey(key),
    onRotate: setRotating,
    pendingKeyId,
  });

  return (
    <>
      <SectionCard
        title="API keys"
        body="custom"
        data-testid="user-profile-api-keys"
        action={
          <Stack direction="row" gap={1} flexWrap="wrap" justifyContent="flex-end">
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => setModal('limits')}
              data-testid="user-profile-key-limits-btn"
            >
              Rate limits
            </Button>
            <Button
              size="sm"
              variant="outlined"
              color="danger"
              disabled={activeCount === 0}
              onClick={() => setRevokingAll(true)}
              data-testid="user-keys-revoke-all-btn"
            >
              Revoke all
            </Button>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              onClick={() => setModal('generate')}
              data-testid="user-profile-generate-key-btn"
            >
              Generate key
            </Button>
          </Stack>
        }
      >
        {access && (
          <Stack
            direction="row"
            alignItems="flex-start"
            gap={1.5}
            data-testid="user-keys-access"
            sx={{ px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'admin.border' }}
          >
            <StatusChip tone={access.tone} label={access.label} data-testid="user-keys-access-chip" />
            <Typography level="body-sm" sx={{ color: 'admin.inkSecondary' }}>
              {access.text}
            </Typography>
          </Stack>
        )}
        {newSecret && <SecretOnce secret={newSecret} onDone={() => setNewSecret(null)} />}
        <DataTable
          rows={apiKeys}
          columns={columns}
          getRowId={key => key.id}
          label="API keys"
          loading={keys.isLoading}
          error={keys.isError ? 'API keys could not be loaded.' : undefined}
          onRetry={() => void keys.refetch()}
          empty={
            <Typography level="body-sm" sx={{ p: 2, color: 'admin.inkMuted' }}>
              This user has no API keys.
            </Typography>
          }
          testId="user-keys-table"
          rowTestId={key => `user-keys-row-${key.id}`}
        />
        <Typography
          level="body-xs"
          sx={{ px: 2, py: 1.5, color: 'admin.inkMuted', borderTop: '1px solid', borderColor: 'admin.border' }}
        >
          Request counts come from the usage log, which keeps 90 days.
        </Typography>
      </SectionCard>

      <ActionDialog
        open={rotating !== null}
        onClose={() => setRotating(null)}
        title={rotating ? `Rotate ${rotating.name}` : 'Rotate key'}
        description={
          rotating && (
            <>
              Issues a new secret and revokes{' '}
              <Box component="span" sx={{ fontFamily: 'code', fontSize: 12 }}>
                {rotating.keyPrefix}
              </Box>{' '}
              at once. Anything still using the old secret fails until it gets the new one, which is shown once.
            </>
          )
        }
        reasonPresets={ADMIN_REASON_PRESETS.apiKeyRotate}
        confirmLabel="Rotate key"
        onConfirm={rotateKey}
        pending={rotate.isPending}
        data-testid="user-keys-rotate-dialog"
      />

      <ActionDialog
        open={revokingAll}
        onClose={() => setRevokingAll(false)}
        title="Revoke all API keys"
        description={`Revokes ${activeCount} active ${activeCount === 1 ? 'key' : 'keys'} at once. Every integration using them starts failing immediately, and they cannot be restored from here.`}
        reasonPresets={ADMIN_REASON_PRESETS.apiKeyRevokeAll}
        confirmLabel={`Revoke ${activeCount} ${activeCount === 1 ? 'key' : 'keys'}`}
        onConfirm={revokeAllKeys}
        tone="danger"
        blockedReason={activeCount === 0 ? 'This user has no active keys.' : null}
        pending={revokeAll.isPending}
        data-testid="user-keys-revoke-all-dialog"
      />

      <AdminGenerateApiKeyModal open={modal === 'generate'} onClose={() => setModal(null)} user={user} />
      <AdminApiKeysModal open={modal === 'limits'} onClose={() => setModal(null)} user={user} />
    </>
  );
};
