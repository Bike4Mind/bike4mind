/**
 * SystemSecretsTab - Admin UI for managing system secrets
 *
 * Features:
 * - View all configurable secrets grouped by category
 * - Edit secret values (encrypted before storage)
 * - See source of each secret (database override vs SST fallback)
 * - Delete database overrides to revert to SST value
 */

import { useState, useEffect, useCallback, type ReactNode } from 'react';
import {
  Alert,
  Box,
  Button,
  DialogContent,
  Dropdown,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  ListDivider,
  Menu,
  MenuButton,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from '@mui/joy';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import Refresh from '@mui/icons-material/Refresh';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';
import { toast } from 'sonner';
import { isAxiosError } from 'axios';
import { api } from '@client/app/contexts/ApiContext';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import {
  AdminDialog,
  AdminPageHeader,
  DataTable,
  EmptyState,
  StatusChip,
  type DataColumn,
  type DataTableGroup,
} from './shared';
import { ADMIN_REGION_GAP, adminFocus } from './shared/adminStyles';

interface SecretStatus {
  secretName: string;
  category: string;
  description: string;
  isConfigured: boolean;
  source: 'database' | 'sst' | null;
  maskedValue: string;
  isOverridable: boolean;
  dbRecord: {
    id: string;
    source: string;
    lastModifiedBy?: string;
    rotatedAt?: string;
    updatedAt?: string;
  } | null;
  warnings?: string[];
}

interface SecretsResponse {
  secrets: SecretStatus[];
  tier1Note: string;
}

// Tier 1 status types (matches ValidationStatus from tier1SecretValidators)
type Tier1SecretStatus = 'configured' | 'placeholder' | 'invalid' | 'missing' | 'warning' | 'insecure';

interface Tier1SecretInfo {
  name: string;
  status: Tier1SecretStatus;
  severity?: 'error' | 'warning' | 'info';
  message?: string;
  hint?: string;
  /** 'always' blocks a deploy of any stage; 'production' only on stages serving real traffic. */
  enforcement?: 'always' | 'production';
  /** True when a deploy of this stage would be refused for this secret. */
  blocksDeploy?: boolean;
}

interface Tier1StatusResponse {
  stage: string;
  secrets: Tier1SecretInfo[];
}

const CATEGORY_LABELS: Record<string, string> = {
  auth: 'Authentication',
  mail: 'Email configuration',
  oauth: 'OAuth providers',
  api_key: 'API keys',
  slack: 'Slack integration',
};

const CATEGORY_ORDER = ['auth', 'mail', 'oauth', 'api_key', 'slack'];

const TIER1_STATUS: Record<Tier1SecretStatus, { tone: AdminStatusTone; label: string }> = {
  configured: { tone: 'good', label: 'Configured' },
  // Neutral, not warn: a stage can hold many placeholders, and a column of amber hides the real problems.
  placeholder: { tone: 'neutral', label: 'Placeholder' },
  warning: { tone: 'warn', label: 'Warning' },
  invalid: { tone: 'bad', label: 'Invalid' },
  insecure: { tone: 'bad', label: 'Insecure' },
  missing: { tone: 'bad', label: 'Missing' },
};

/** Where the value comes from. Unset is neutral: an optional integration left off is not a fault. */
function sourceStatus(secret: SecretStatus): { tone: AdminStatusTone; label: string } {
  if (!secret.isConfigured) return { tone: 'neutral', label: 'Not configured' };
  if (secret.source === 'database') return { tone: 'info', label: 'GUI override' };
  if (secret.source === 'sst') return { tone: 'neutral', label: 'SST' };
  return { tone: 'neutral', label: 'Unknown' };
}

const dash = (
  <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
    -
  </Typography>
);

/** One line that truncates with an ellipsis, the full text on hover. */
const TruncatedText = ({ text, mono, testId }: { text: string; mono?: boolean; testId?: string }) => (
  <Tooltip title={text} placement="top-start">
    <Typography
      level="body-sm"
      noWrap
      data-testid={testId}
      sx={{ color: 'admin.ink', minWidth: 0, ...(mono && { fontFamily: 'code' }) }}
    >
      {text}
    </Typography>
  </Tooltip>
);

const KeyName = ({ children }: { children: ReactNode }) => (
  <Typography component="code" fontFamily="code" sx={{ color: 'admin.ink' }}>
    {children}
  </Typography>
);

const DialogFooter = ({ children }: { children: ReactNode }) => (
  <Stack
    direction="row"
    justifyContent="flex-end"
    gap={1}
    sx={{ pt: 2, mt: 1, borderTop: '1px solid', borderColor: 'admin.border' }}
  >
    {children}
  </Stack>
);

const SectionTitle = ({ title, description, testId }: { title: string; description: ReactNode; testId: string }) => (
  <Box data-testid={testId}>
    <Typography level="title-md" component="h2" sx={{ color: 'admin.ink' }}>
      {title}
    </Typography>
    <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
      {description}
    </Typography>
  </Box>
);

/** Status chip for a Tier 1 secret; the validator's message and hint show on hover. */
const Tier1StatusChip: React.FC<{ secret: Tier1SecretInfo }> = ({ secret }) => {
  const { tone, label } = TIER1_STATUS[secret.status];
  const { message, hint } = secret;
  const chip = <StatusChip tone={tone} label={label} data-testid={`system-secrets-infra-status-${secret.name}`} />;

  if (hint || message) {
    return (
      <Tooltip
        title={
          <Box sx={{ maxWidth: 400 }}>
            {message && <Typography level="body-xs">{message}</Typography>}
            {hint && (
              <Typography
                level="body-xs"
                data-testid={`system-secrets-infra-hint-${secret.name}`}
                sx={{ fontFamily: 'code', mt: message ? 1 : 0, wordBreak: 'break-all' }}
              >
                {hint}
              </Typography>
            )}
          </Box>
        }
        placement="right"
      >
        <span>{chip}</span>
      </Tooltip>
    );
  }

  return chip;
};

function SecretRowMenu({
  secret,
  onEdit,
  onDelete,
}: {
  secret: SecretStatus;
  onEdit: (secret: SecretStatus) => void;
  onDelete: (secret: SecretStatus) => void;
}) {
  return (
    <Dropdown>
      <MenuButton
        slots={{ root: IconButton }}
        slotProps={{
          root: {
            size: 'sm',
            variant: 'plain',
            'aria-label': `Actions for ${secret.secretName}`,
            sx: { ...adminFocus, color: 'admin.inkMuted' },
          },
        }}
        data-testid={`system-secrets-row-actions-${secret.secretName}`}
      >
        <MoreHorizIcon sx={{ fontSize: 18 }} />
      </MenuButton>
      <Menu size="sm" placement="bottom-end" sx={{ zIndex: 1300 }}>
        <MenuItem onClick={() => onEdit(secret)} data-testid={`system-secrets-row-edit-${secret.secretName}`}>
          Edit value
        </MenuItem>
        {secret.dbRecord && (
          <>
            <ListDivider />
            <MenuItem onClick={() => onDelete(secret)} data-testid={`system-secrets-row-delete-${secret.secretName}`}>
              Delete override
            </MenuItem>
          </>
        )}
      </Menu>
    </Dropdown>
  );
}

const tier1Columns: readonly DataColumn<Tier1SecretInfo>[] = [
  {
    id: 'secret',
    label: 'Secret',
    render: secret => <TruncatedText text={secret.name} mono testId={`system-secrets-infra-name-${secret.name}`} />,
  },
  {
    id: 'status',
    label: 'Status',
    width: '20rem',
    render: secret => (
      <Stack direction="row" alignItems="center" gap={1} sx={{ minWidth: 0 }}>
        <Tier1StatusChip secret={secret} />
        {secret.status !== 'configured' && !secret.blocksDeploy && (
          <Typography level="body-xs" noWrap sx={{ color: 'admin.inkMuted' }}>
            Not required on this stage
          </Typography>
        )}
      </Stack>
    ),
  },
];

const secretColumns: readonly DataColumn<SecretStatus>[] = [
  {
    id: 'secret',
    label: 'Secret',
    width: '17rem',
    render: secret => (
      <Stack direction="row" alignItems="center" gap={1} sx={{ minWidth: 0 }}>
        <TruncatedText text={secret.secretName} mono testId={`system-secrets-name-${secret.secretName}`} />
        {secret.warnings && secret.warnings.length > 0 && (
          <Tooltip title={secret.warnings.join(' ')}>
            <Box component="span" sx={{ flexShrink: 0 }}>
              <StatusChip tone="warn" label="Warning" data-testid={`system-secrets-warning-${secret.secretName}`} />
            </Box>
          </Tooltip>
        )}
      </Stack>
    ),
  },
  {
    id: 'description',
    label: 'Description',
    render: secret => (secret.description ? <TruncatedText text={secret.description} /> : dash),
  },
  {
    id: 'source',
    label: 'Source',
    width: '9rem',
    render: secret => {
      const { tone, label } = sourceStatus(secret);
      return <StatusChip tone={tone} label={label} data-testid={`system-secrets-source-${secret.secretName}`} />;
    },
  },
  {
    id: 'value',
    label: 'Value',
    width: '10rem',
    render: secret =>
      secret.maskedValue ? (
        <Typography level="body-sm" noWrap sx={{ fontFamily: 'code', color: 'admin.ink' }}>
          {secret.maskedValue}
        </Typography>
      ) : (
        dash
      ),
  },
];

const SystemSecretsTab: React.FC = () => {
  const [tier1Status, setTier1Status] = useState<Tier1StatusResponse | null>(null);
  const [tier1Loading, setTier1Loading] = useState(true);
  const [tier1Failed, setTier1Failed] = useState(false);
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [secretsFailed, setSecretsFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingSecret, setEditingSecret] = useState<SecretStatus | null>(null);
  const [secretValue, setSecretValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingSecret, setDeletingSecret] = useState<SecretStatus | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const fetchTier1Status = useCallback(async () => {
    try {
      const response = await api.get<Tier1StatusResponse>('/api/admin/system-secrets/tier1-status');
      setTier1Status(response.data);
      setTier1Failed(false);
    } catch (error) {
      console.error('Error fetching Tier 1 status:', error);
      setTier1Failed(true);
    } finally {
      setTier1Loading(false);
    }
  }, []);

  const fetchSecrets = useCallback(async () => {
    try {
      const response = await api.get<SecretsResponse>('/api/admin/system-secrets');
      setSecrets(response.data.secrets);
      setSecretsFailed(false);
    } catch (error) {
      console.error('Error fetching secrets:', error);
      setSecretsFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTier1Status();
    fetchSecrets();
  }, [fetchTier1Status, fetchSecrets]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([fetchTier1Status(), fetchSecrets()]);
    setRefreshing(false);
  };

  const retryTier1 = () => {
    setTier1Failed(false);
    setTier1Loading(true);
    fetchTier1Status();
  };

  const retrySecrets = () => {
    setSecretsFailed(false);
    setLoading(true);
    fetchSecrets();
  };

  const handleEdit = (secret: SecretStatus) => {
    setEditingSecret(secret);
    setSecretValue('');
    setShowValue(false);
    setEditModalOpen(true);
  };

  const handleCloseModal = () => {
    setEditModalOpen(false);
    setSecretValue('');
    setShowValue(false);
  };

  const handleDismissEdit = () => {
    if (saving) return;
    handleCloseModal();
  };

  const handleCloseDelete = () => {
    if (deleting) return;
    setDeleteDialogOpen(false);
  };

  const handleRequestDelete = (secret: SecretStatus) => {
    setDeletingSecret(secret);
    setDeleteDialogOpen(true);
  };

  const handleSave = async () => {
    if (!editingSecret || !secretValue.trim()) {
      toast.error('Please enter a value');
      return;
    }

    setSaving(true);
    try {
      await api.post('/api/admin/system-secrets', {
        secretName: editingSecret.secretName,
        value: secretValue,
      });
      toast.success(`${editingSecret.secretName} saved successfully`);
      handleCloseModal();
      fetchSecrets();
    } catch (error) {
      const errorMessage = isAxiosError(error) ? error.response?.data?.error : undefined;
      toast.error(errorMessage || 'Failed to save secret');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (secret: SecretStatus) => {
    if (!secret.dbRecord) {
      toast.error('No database override to delete');
      return;
    }

    setDeleting(true);
    try {
      await api.delete(`/api/admin/system-secrets/${secret.dbRecord.id}`);
      toast.success(`Database override for ${secret.secretName} deleted`);
      setDeleteDialogOpen(false);
      fetchSecrets();
    } catch (error) {
      const errorMessage = isAxiosError(error) ? error.response?.data?.error : undefined;
      toast.error(errorMessage || 'Failed to delete secret');
    } finally {
      setDeleting(false);
    }
  };

  // One header row per category, in CATEGORY_ORDER; a secret outside those categories is not listed.
  const listedSecrets = secrets.filter(secret => CATEGORY_ORDER.includes(secret.category));
  const groups: DataTableGroup[] = CATEGORY_ORDER.map(category => ({
    id: category,
    rowIds: listedSecrets.filter(secret => secret.category === category).map(secret => secret.secretName),
    header: (
      <Box sx={{ px: 1.5, py: 1, bgcolor: 'admin.surfaceSubtle' }} data-testid={`system-secrets-group-${category}`}>
        <Typography level="title-sm" component="h3" sx={{ color: 'admin.ink' }}>
          {CATEGORY_LABELS[category] || category}
        </Typography>
      </Box>
    ),
  }));

  const stage = tier1Status?.stage;

  return (
    <Stack gap={ADMIN_REGION_GAP} sx={{ minWidth: 0 }} data-testid="admin-system-secrets-tab">
      <AdminPageHeader
        title="System secrets"
        description="Infrastructure secrets set with SST, and the secrets you can override from here."
        actions={
          <>
            <ContextHelpButton helpId="admin/secrets-management" tooltipText="System secrets help" />
            <Button
              variant="outlined"
              size="sm"
              startDecorator={<Refresh sx={{ fontSize: 16 }} />}
              loading={refreshing}
              onClick={handleRefresh}
              data-testid="system-secrets-refresh-btn"
              sx={adminFocus}
            >
              Refresh
            </Button>
          </>
        }
      />

      <Stack component="section" gap={1.5} sx={{ minWidth: 0 }}>
        <SectionTitle
          title="Infrastructure secrets (SST)"
          testId="system-secrets-infra-title"
          description={
            <>
              Set with the SST CLI, not here. A deploy of{' '}
              {stage ? (
                <>
                  stage <KeyName>{stage}</KeyName>
                </>
              ) : (
                'this stage'
              )}{' '}
              is refused while a required one is unset.
            </>
          }
        />
        <DataTable
          label="Infrastructure secrets"
          testId="system-secrets-infra-table"
          rows={tier1Status?.secrets ?? []}
          columns={tier1Columns}
          getRowId={secret => secret.name}
          rowTestId={secret => `system-secrets-infra-row-${secret.name}`}
          loading={tier1Loading}
          error={tier1Failed ? 'Could not load the infrastructure secrets status.' : undefined}
          onRetry={retryTier1}
          empty={
            <EmptyState
              title="No infrastructure secrets to check"
              action={
                <Button variant="outlined" onClick={retryTier1} data-testid="system-secrets-infra-empty-refresh-btn">
                  Refresh
                </Button>
              }
            />
          }
          pagination={false}
          maxHeight="none"
        />
      </Stack>

      <Stack component="section" gap={1.5} sx={{ minWidth: 0 }}>
        <SectionTitle
          title="Configurable secrets"
          testId="system-secrets-configurable-title"
          description="Overrides set here are encrypted; delete one to go back to the SST value."
        />
        <DataTable
          label="Configurable secrets"
          testId="system-secrets-table"
          rows={listedSecrets}
          columns={secretColumns}
          getRowId={secret => secret.secretName}
          rowTestId={secret => `system-secrets-row-${secret.secretName}`}
          loading={loading}
          error={secretsFailed ? 'Could not load the system secrets.' : undefined}
          onRetry={retrySecrets}
          empty={
            <EmptyState
              title="No configurable secrets"
              action={
                <Button variant="outlined" onClick={retrySecrets} data-testid="system-secrets-empty-refresh-btn">
                  Refresh
                </Button>
              }
            />
          }
          groups={groups}
          rowActions={secret => <SecretRowMenu secret={secret} onEdit={handleEdit} onDelete={handleRequestDelete} />}
          pagination={false}
          // Wide enough that every column keeps one line; below it the table scrolls inside its frame.
          minWidth="56rem"
          maxHeight="none"
        />
      </Stack>

      <AdminDialog
        open={editModalOpen}
        onClose={handleDismissEdit}
        title="Edit value"
        width={500}
        data-testid="system-secrets-edit-dialog"
      >
        <DialogContent sx={{ gap: 2 }}>
          <Box>
            <Typography level="body-sm" component="div">
              New value for <KeyName>{editingSecret?.secretName}</KeyName>.
            </Typography>
            {editingSecret?.description && (
              <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
                {editingSecret.description}
              </Typography>
            )}
          </Box>

          {editingSecret?.dbRecord && (
            <Alert color="neutral" size="sm">
              Current source: {editingSecret.source === 'database' ? 'GUI override' : 'SST'}
              {editingSecret.maskedValue && ` (${editingSecret.maskedValue})`}
            </Alert>
          )}

          <FormControl>
            <FormLabel>New value</FormLabel>
            <Input
              type={showValue ? 'text' : 'password'}
              value={secretValue}
              onChange={e => setSecretValue(e.target.value)}
              placeholder="Enter secret value"
              slotProps={{ input: { 'data-testid': 'system-secrets-edit-value-input' } }}
              endDecorator={
                <IconButton
                  variant="plain"
                  onClick={() => setShowValue(!showValue)}
                  aria-label={showValue ? 'Hide value' : 'Show value'}
                  data-testid="system-secrets-edit-visibility-btn"
                >
                  {showValue ? <VisibilityOff /> : <Visibility />}
                </IconButton>
              }
            />
          </FormControl>
        </DialogContent>
        <DialogFooter>
          <Button
            variant="plain"
            color="neutral"
            onClick={handleDismissEdit}
            disabled={saving}
            data-testid="system-secrets-edit-cancel-btn"
          >
            Cancel
          </Button>
          <Button
            color="primary"
            onClick={handleSave}
            loading={saving}
            disabled={!secretValue.trim()}
            data-testid="system-secrets-edit-save-btn"
          >
            Save value
          </Button>
        </DialogFooter>
      </AdminDialog>

      <AdminDialog
        open={deleteDialogOpen}
        onClose={handleCloseDelete}
        title="Delete override"
        role="alertdialog"
        data-testid="system-secrets-delete-dialog"
      >
        <DialogContent>
          <Typography level="body-sm" component="div">
            Deletes the override for <KeyName>{deletingSecret?.secretName}</KeyName>. The platform goes back to the SST
            value, if one is set. The override value is not kept.
          </Typography>
        </DialogContent>
        <DialogFooter>
          <Button
            variant="plain"
            color="neutral"
            onClick={handleCloseDelete}
            disabled={deleting}
            data-testid="system-secrets-delete-cancel-btn"
          >
            Cancel
          </Button>
          <Button
            color="danger"
            loading={deleting}
            onClick={() => deletingSecret && handleDelete(deletingSecret)}
            data-testid="system-secrets-delete-confirm-btn"
          >
            Delete override
          </Button>
        </DialogFooter>
      </AdminDialog>
    </Stack>
  );
};

export default SystemSecretsTab;
