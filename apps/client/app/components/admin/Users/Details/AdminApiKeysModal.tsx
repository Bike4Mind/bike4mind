import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import { useAdminGetUserApiKeys, useAdminResetApiKeyRateLimit } from '@client/app/hooks/data/userApiKeys';
import type { ApiKeyRateLimitResetResponse } from '@client/app/hooks/data/userApiKeys';
import { ApiKeyStatus, IUserApiKeyDocument } from '@bike4mind/common';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { Chip, IconButton, Stack, Tooltip, Typography } from '@mui/joy';
import {
  ActionDialog,
  AdminDialog,
  DataTable,
  EmptyState,
  RelativeTime,
  type DataColumn,
} from '@client/app/components/admin/shared';
import { useUser } from '@client/app/contexts/UserContext';
import { adminActionBlockedReason } from '../Profile/userProfileModel';
import { revocationTooltip } from '@client/app/utils/apiKeyRevocation';
import { formatRateLimitReset } from '@client/app/utils/formatRateLimitReset';
import { useState } from 'react';
import { toast } from 'sonner';

interface AdminApiKeysModalProps {
  open: boolean;
  onClose: () => void;
  user: AdminUserListItem;
}

const STATUS_CHIP: Record<ApiKeyStatus, { color: 'success' | 'neutral' | 'warning' | 'danger'; label: string }> = {
  [ApiKeyStatus.ACTIVE]: { color: 'success', label: 'Active' },
  [ApiKeyStatus.DISABLED]: { color: 'danger', label: 'Disabled' },
  [ApiKeyStatus.EXPIRED]: { color: 'neutral', label: 'Expired' },
  [ApiKeyStatus.RATE_LIMITED]: { color: 'warning', label: 'Rate limited' },
};

export default function AdminApiKeysModal({ open, onClose, user }: AdminApiKeysModalProps) {
  // The minute window lives at most 60s, so a fetch-time snapshot goes stale within seconds.
  const { data, isLoading, error, refetch } = useAdminGetUserApiKeys(open ? user.id : undefined, {
    refetchInterval: 15_000,
  });
  const resetMutation = useAdminResetApiKeyRateLimit();
  const { currentUser } = useUser();
  const resetBlocked = adminActionBlockedReason(currentUser, user, 'users:moderate');
  const [resettingKey, setResettingKey] = useState<IUserApiKeyDocument | null>(null);

  const usageFor = (key: IUserApiKeyDocument) => data?.liveUsage[key.id] ?? { minute: 0, day: 0 };

  // The rate_limited status value is never persisted on key docs; a wedged key
  // is detected from the live cache counters sitting at their ceiling.
  const isWedged = (key: IUserApiKeyDocument) => {
    const usage = usageFor(key);
    return usage.minute >= key.rateLimit.requestsPerMinute || usage.day >= key.rateLimit.requestsPerDay;
  };

  const statusChip = (key: IUserApiKeyDocument) => {
    if (key.status === ApiKeyStatus.ACTIVE && isWedged(key)) {
      return STATUS_CHIP[ApiKeyStatus.RATE_LIMITED];
    }
    return STATUS_CHIP[key.status] ?? { color: 'neutral' as const, label: key.status };
  };

  // Names which counter(s) actually caused the lockout - a bare "reset
  // succeeded" leaves an admin unable to tell request vs. management. A
  // counter entry is undefined when clearing it failed (best-effort); that
  // reads as "could not be verified", distinct from a counter that was
  // actually cleared and found not to be at its ceiling.
  const describeLockoutCause = (lockout: NonNullable<ApiKeyRateLimitResetResponse['lockout']>): string => {
    const atCeiling: string[] = [];
    const unknown: string[] = [];
    const note = (name: 'request' | 'management', state: typeof lockout.request) => {
      if (state === undefined) unknown.push(name);
      else if (state.minuteAtLimit || state.dayAtLimit) atCeiling.push(name);
    };
    note('request', lockout.request);
    note('management', lockout.management);

    const clauses: string[] = [];
    if (atCeiling.length > 0) {
      clauses.push(
        atCeiling.length > 1
          ? `${atCeiling.join(' and ')} counters were at their ceilings`
          : `${atCeiling[0]} counter was at its ceiling`
      );
    }
    if (unknown.length > 0) {
      clauses.push(
        unknown.length > 1
          ? `${unknown.join(' and ')} counters could not be verified`
          : `${unknown[0]} counter could not be verified`
      );
    }
    return clauses.length === 0 ? '' : ` - ${clauses.join('; ')}`;
  };

  const handleReset = async () => {
    if (!resettingKey || resetBlocked) return;
    const key = resettingKey;
    try {
      const response = await resetMutation.mutateAsync(key.id);
      toast.success(
        `Rate limit reset for "${key.name}"${response.lockout ? describeLockoutCause(response.lockout) : ''}`
      );
      setResettingKey(null);
    } catch {
      // The mutation hook reports the request error; keep the dialog open for a retry.
    }
  };

  const columns: DataColumn<IUserApiKeyDocument>[] = [
    { id: 'name', label: 'Name', render: key => key.name, sortValue: key => key.name.toLowerCase() },
    {
      id: 'prefix',
      label: 'Key prefix',
      render: key => (
        <Typography level="body-xs" fontFamily="monospace">
          {key.keyPrefix}
        </Typography>
      ),
    },
    { id: 'scopes', label: 'Scopes', render: key => key.scopes.join(', ') },
    {
      id: 'status',
      label: 'Status',
      render: key => {
        const chip = statusChip(key);
        return (
          <Tooltip title={revocationTooltip(key) ?? ''}>
            <Chip variant="soft" color={chip.color} data-testid={`admin-api-key-status-${key.id}`}>
              {chip.label}
            </Chip>
          </Tooltip>
        );
      },
    },
    {
      id: 'usage',
      label: 'Rate limit',
      render: key => {
        const usage = usageFor(key);
        const minuteReset = formatRateLimitReset(usage.minuteResetAt);
        const dayReset = formatRateLimitReset(usage.dayResetAt);
        return (
          <Stack data-testid={`admin-api-key-usage-${key.id}`}>
            <Typography level="body-xs" data-testid={`admin-api-key-usage-minute-${key.id}`}>
              {usage.minute}/{key.rateLimit.requestsPerMinute} per min
              {usage.minute > 0 && minuteReset ? ` \u00b7 resets in ${minuteReset}` : ''}
            </Typography>
            <Typography level="body-xs" data-testid={`admin-api-key-usage-day-${key.id}`}>
              {usage.day}/{key.rateLimit.requestsPerDay} per day
              {usage.day > 0 && dayReset ? ` \u00b7 resets in ${dayReset}` : ''}
            </Typography>
          </Stack>
        );
      },
    },
    {
      id: 'lastUsed',
      label: 'Last used',
      render: key => (key.lastUsedAt ? <RelativeTime at={key.lastUsedAt} /> : 'Never'),
      sortValue: key => (key.lastUsedAt ? new Date(key.lastUsedAt).getTime() : 0),
    },
    {
      id: 'actions',
      label: 'Actions',
      render: key => (
        <Tooltip title={resetBlocked ?? 'Reset rate limit'}>
          <span>
            <IconButton
              size="sm"
              variant="outlined"
              aria-label={`Reset rate limit for ${key.name}`}
              disabled={!!resetBlocked || resetMutation.isPending}
              onClick={() => setResettingKey(key)}
              data-testid={`admin-api-key-reset-rate-limit-btn-${key.id}`}
            >
              <RestartAltIcon />
            </IconButton>
          </span>
        </Tooltip>
      ),
    },
  ];

  return (
    <>
      <AdminDialog
        open={open && !resettingKey}
        onClose={onClose}
        title={`API keys for ${user.username}`}
        width={960}
        data-testid="admin-api-keys-dialog"
      >
        <DataTable
          rows={data?.apiKeys ?? []}
          columns={columns}
          getRowId={key => key.id}
          label="API key rate limits"
          loading={isLoading}
          error={error ? 'Failed to load API keys.' : undefined}
          onRetry={() => void refetch()}
          testId="admin-api-keys-table"
          rowTestId={key => `admin-api-key-row-${key.id}`}
          empty={<EmptyState title="This user has no API keys." action={null} />}
        />
      </AdminDialog>
      <ActionDialog
        open={open && resettingKey !== null}
        onClose={() => setResettingKey(null)}
        title="Reset rate limit"
        description={`Reset the minute and day rate-limit counters for "${resettingKey?.name ?? ''}"? The next request opens a fresh window. This reset cannot be undone.`}
        reasonPresets={['Support request', 'Key locked out', 'Counter correction']}
        reasonAudited={false}
        confirmLabel="Reset rate limit"
        onConfirm={handleReset}
        pending={resetMutation.isPending}
        blockedReason={resetBlocked}
        data-testid="admin-api-keys-reset-dialog"
      />
    </>
  );
}
