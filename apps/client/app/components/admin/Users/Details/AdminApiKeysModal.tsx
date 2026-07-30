import { useAdminGetUserApiKeys, useAdminResetApiKeyRateLimit } from '@client/app/hooks/data/userApiKeys';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { ApiKeyStatus, IUserApiKeyDocument, IUserDocument } from '@bike4mind/common';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Modal,
  ModalDialog,
  Table,
  Tooltip,
  Typography,
} from '@mui/joy';
import { tableHeaderSx } from '@client/app/components/ProfileModal/settingsStyles';
import { revocationTooltip } from '@client/app/utils/apiKeyRevocation';
import { useState } from 'react';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

interface AdminApiKeysModalProps {
  open: boolean;
  onClose: () => void;
  user: IUserDocument;
}

const STATUS_CHIP: Record<ApiKeyStatus, { color: 'success' | 'neutral' | 'warning' | 'danger'; label: string }> = {
  [ApiKeyStatus.ACTIVE]: { color: 'success', label: 'Active' },
  [ApiKeyStatus.DISABLED]: { color: 'danger', label: 'Disabled' },
  [ApiKeyStatus.EXPIRED]: { color: 'neutral', label: 'Expired' },
  [ApiKeyStatus.RATE_LIMITED]: { color: 'warning', label: 'Rate limited' },
};

export default function AdminApiKeysModal({ open, onClose, user }: AdminApiKeysModalProps) {
  const { data, isLoading, error, refetch } = useAdminGetUserApiKeys(open ? user.id : undefined);
  const resetMutation = useAdminResetApiKeyRateLimit();
  const confirm = useConfirmation();
  const [resettingKeyId, setResettingKeyId] = useState<string | null>(null);

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

  const handleReset = (key: IUserApiKeyDocument) => {
    confirm({
      title: 'Reset rate limit',
      description: `Reset the minute and day rate-limit counters for "${key.name}"? The next request opens a fresh window.`,
      type: 'danger',
      onOk: () => {
        setResettingKeyId(key.id);
        resetMutation.mutate(key.id, {
          onSuccess: () => toast.success(`Rate limit reset for "${key.name}"`),
          // Clear only our own row: a later reset on another row may already
          // own the spinner when this settle lands.
          onSettled: () => setResettingKeyId(prev => (prev === key.id ? null : prev)),
        });
      },
    });
  };

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog size="lg" sx={{ width: '900px', maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto' }}>
        <Typography level="h4">API Keys for {user.username}</Typography>

        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress data-testid="admin-api-keys-loading" />
          </Box>
        ) : error ? (
          <Alert color="danger" data-testid="admin-api-keys-error">
            Failed to load API keys.
            <Button size="sm" variant="outlined" color="danger" onClick={() => refetch()}>
              Retry
            </Button>
          </Alert>
        ) : !data || data.apiKeys.length === 0 ? (
          <Alert color="neutral" startDecorator={<InfoOutlinedIcon />} data-testid="admin-api-keys-empty">
            This user has no API keys.
          </Alert>
        ) : (
          <Table stickyHeader hoverRow sx={{ '& thead th': tableHeaderSx }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key Prefix</th>
                <th>Scopes</th>
                <th>Status</th>
                <th>Rate limit</th>
                <th>Last Used</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.apiKeys.map(key => {
                const usage = usageFor(key);
                const chip = statusChip(key);
                return (
                  <tr key={key.id} data-testid={`admin-api-key-row-${key.id}`}>
                    <td>{key.name}</td>
                    <td>
                      <Typography level="body-xs" sx={{ fontFamily: 'monospace' }}>
                        {key.keyPrefix}
                      </Typography>
                    </td>
                    <td>{key.scopes.join(', ')}</td>
                    <td>
                      <Tooltip title={revocationTooltip(key) ?? ''}>
                        <Chip variant="soft" color={chip.color} data-testid={`admin-api-key-status-${key.id}`}>
                          {chip.label}
                        </Chip>
                      </Tooltip>
                    </td>
                    <td data-testid={`admin-api-key-usage-${key.id}`}>
                      <Typography level="body-xs">
                        {usage.minute}/{key.rateLimit.requestsPerMinute} per min
                      </Typography>
                      <Typography level="body-xs">
                        {usage.day}/{key.rateLimit.requestsPerDay} per day
                      </Typography>
                    </td>
                    <td>{key.lastUsedAt ? dayjs(key.lastUsedAt).fromNow() : 'Never'}</td>
                    <td>
                      <Tooltip title="Reset rate limit">
                        <IconButton
                          size="sm"
                          variant="outlined"
                          onClick={() => handleReset(key)}
                          loading={resetMutation.isPending && resettingKeyId === key.id}
                          data-testid={`admin-api-key-reset-rate-limit-btn-${key.id}`}
                        >
                          <RestartAltIcon />
                        </IconButton>
                      </Tooltip>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </ModalDialog>
    </Modal>
  );
}
