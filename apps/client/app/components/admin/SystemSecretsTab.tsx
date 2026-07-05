/**
 * SystemSecretsTab - Admin UI for managing system secrets
 *
 * Features:
 * - View all configurable secrets grouped by category
 * - Edit secret values (encrypted before storage)
 * - See source of each secret (database override vs SST fallback)
 * - Delete database overrides to revert to SST value
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  FormControl,
  FormLabel,
  Input,
  Modal,
  ModalDialog,
  Stack,
  Table,
  Typography,
  IconButton,
  Alert,
  CircularProgress,
} from '@mui/joy';
import {
  Edit,
  Delete,
  Visibility,
  VisibilityOff,
  Warning,
  Info,
  Refresh,
  CheckCircle,
  Error as ErrorIcon,
} from '@mui/icons-material';
import Tooltip from '@mui/joy/Tooltip';
import toast from 'react-hot-toast';
import { isAxiosError } from 'axios';
import { api } from '@client/app/contexts/ApiContext';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

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
}

interface Tier1StatusResponse {
  stage: string;
  secrets: Tier1SecretInfo[];
}

const CATEGORY_LABELS: Record<string, string> = {
  auth: 'Authentication',
  mail: 'Email Configuration',
  oauth: 'OAuth Providers',
  api_key: 'API Keys',
  slack: 'Slack Integration',
};

const CATEGORY_ORDER = ['auth', 'mail', 'oauth', 'api_key', 'slack'];

/**
 * Status chip component for Tier 1 secrets
 */
const Tier1StatusChip: React.FC<{
  status: Tier1SecretStatus;
  message?: string;
  hint?: string;
}> = ({ status, message, hint }) => {
  const statusConfig: Record<
    Tier1SecretStatus,
    { color: 'success' | 'warning' | 'danger'; icon: React.ReactNode; label: string }
  > = {
    configured: { color: 'success', icon: <CheckCircle fontSize="small" />, label: 'Configured' },
    warning: { color: 'warning', icon: <Warning fontSize="small" />, label: 'Warning' },
    placeholder: { color: 'warning', icon: <Warning fontSize="small" />, label: 'Placeholder' },
    invalid: { color: 'danger', icon: <ErrorIcon fontSize="small" />, label: 'Invalid' },
    insecure: { color: 'danger', icon: <ErrorIcon fontSize="small" />, label: 'Insecure' },
    missing: { color: 'danger', icon: <ErrorIcon fontSize="small" />, label: 'Missing' },
  };

  const config = statusConfig[status];

  const chip = (
    <Chip size="sm" color={config.color} variant="soft" startDecorator={config.icon}>
      {config.label}
    </Chip>
  );

  if (hint || message) {
    return (
      <Tooltip
        title={
          <Box sx={{ maxWidth: 400 }}>
            {message && <Typography level="body-xs">{message}</Typography>}
            {hint && (
              <Typography level="body-xs" sx={{ fontFamily: 'monospace', mt: message ? 1 : 0, wordBreak: 'break-all' }}>
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

/**
 * Tier 1 Status Section - displays infrastructure secrets status (read-only)
 */
const Tier1StatusSection: React.FC = () => {
  const [tier1Status, setTier1Status] = useState<Tier1StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchTier1Status = useCallback(async (showRefreshIndicator = false) => {
    if (showRefreshIndicator) setRefreshing(true);
    try {
      const response = await api.get<Tier1StatusResponse>('/api/admin/system-secrets/tier1-status');
      setTier1Status(response.data);
    } catch (error) {
      console.error('Error fetching Tier 1 status:', error);
      toast.error('Failed to load infrastructure secrets status');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchTier1Status();
  }, [fetchTier1Status]);

  if (loading) {
    return (
      <Card variant="outlined" sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="center" alignItems="center" minHeight={100}>
            <CircularProgress size="sm" />
          </Box>
        </CardContent>
      </Card>
    );
  }

  if (!tier1Status) {
    return null;
  }

  const hasIssues = tier1Status.secrets.some(s => s.status !== 'configured');

  return (
    <Card variant="outlined" color={hasIssues ? 'warning' : 'neutral'} sx={{ mb: 3 }}>
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2 }}>
          <Box>
            <Typography level="title-md">Infrastructure Secrets (SST)</Typography>
            <Typography level="body-sm" color="neutral">
              These secrets must be configured via SST CLI
            </Typography>
          </Box>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => fetchTier1Status(true)}
            disabled={refreshing}
            title="Refresh status"
          >
            {refreshing ? <CircularProgress size="sm" /> : <Refresh />}
          </IconButton>
        </Box>

        <Table size="sm">
          <tbody>
            {tier1Status.secrets.map(secret => (
              <tr key={secret.name}>
                <td style={{ width: '40%' }}>
                  <Typography level="body-sm" fontFamily="monospace">
                    {secret.name}
                  </Typography>
                </td>
                <td>
                  <Tier1StatusChip status={secret.status} message={secret.message} hint={secret.hint} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>

        <Typography level="body-xs" color="neutral" sx={{ mt: 2 }}>
          Stage: <code>{tier1Status.stage}</code>
        </Typography>
      </CardContent>
    </Card>
  );
};

const SystemSecretsTab: React.FC = () => {
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingSecret, setEditingSecret] = useState<SecretStatus | null>(null);
  const [secretValue, setSecretValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchSecrets = useCallback(async () => {
    try {
      const response = await api.get<SecretsResponse>('/api/admin/system-secrets');
      setSecrets(response.data.secrets);
    } catch (error) {
      console.error('Error fetching secrets:', error);
      toast.error('Failed to load system secrets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSecrets();
  }, [fetchSecrets]);

  const handleEdit = (secret: SecretStatus) => {
    setEditingSecret(secret);
    setSecretValue('');
    setShowValue(false);
    setEditModalOpen(true);
  };

  const handleCloseModal = () => {
    setEditModalOpen(false);
    setEditingSecret(null);
    setSecretValue('');
    setShowValue(false);
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

    if (
      !confirm(
        `Are you sure you want to delete the database override for ${secret.secretName}?\n\n` +
          `This will revert to using the SST value (if configured).`
      )
    ) {
      return;
    }

    try {
      await api.delete(`/api/admin/system-secrets/${secret.dbRecord.id}`);
      toast.success(`Database override for ${secret.secretName} deleted`);
      fetchSecrets();
    } catch (error) {
      const errorMessage = isAxiosError(error) ? error.response?.data?.error : undefined;
      toast.error(errorMessage || 'Failed to delete secret');
    }
  };

  const getSourceChip = (secret: SecretStatus) => {
    if (!secret.isConfigured) {
      return (
        <Chip color="danger" size="sm" variant="soft">
          Not Configured
        </Chip>
      );
    }
    if (secret.source === 'database') {
      return (
        <Chip color="success" size="sm" variant="soft">
          GUI Override
        </Chip>
      );
    }
    if (secret.source === 'sst') {
      return (
        <Chip color="primary" size="sm" variant="soft">
          SST
        </Chip>
      );
    }
    return (
      <Chip color="neutral" size="sm" variant="soft">
        Unknown
      </Chip>
    );
  };

  const groupedSecrets = CATEGORY_ORDER.reduce(
    (acc, category) => {
      const categorySecrets = secrets.filter(s => s.category === category);
      if (categorySecrets.length > 0) {
        acc[category] = categorySecrets;
      }
      return acc;
    },
    {} as Record<string, SecretStatus[]>
  );

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight={200}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} mb={3}>
        <Typography level="h3">System Secrets</Typography>
        <ContextHelpButton helpId="admin/secrets-management" tooltipText="System Secrets Help" />
      </Stack>

      {/* Tier 1 Infrastructure Secrets Status (read-only) */}
      <Tier1StatusSection />

      {/* Tier 2/3 Configurable Secrets */}
      <Alert color="neutral" startDecorator={<Info />} sx={{ mb: 3 }}>
        Configure secrets below to override SST values. Changes take effect immediately.
      </Alert>

      {Object.entries(groupedSecrets).map(([category, categorySecrets]) => (
        <Card key={category} variant="outlined" sx={{ mb: 2 }}>
          <CardContent>
            <Typography level="title-lg" sx={{ mb: 2 }}>
              {CATEGORY_LABELS[category] || category}
            </Typography>
            <Table>
              <thead>
                <tr>
                  <th style={{ width: '25%' }}>Secret</th>
                  <th style={{ width: '30%' }}>Description</th>
                  <th style={{ width: '15%' }}>Status</th>
                  <th style={{ width: '15%' }}>Value</th>
                  <th style={{ width: '15%' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {categorySecrets.map(secret => (
                  <tr key={secret.secretName}>
                    <td>
                      <Typography level="body-sm" fontFamily="monospace">
                        {secret.secretName}
                      </Typography>
                      {secret.warnings && secret.warnings.length > 0 && (
                        <Chip
                          color="warning"
                          size="sm"
                          variant="soft"
                          startDecorator={<Warning fontSize="small" />}
                          sx={{ mt: 0.5 }}
                        >
                          Warning
                        </Chip>
                      )}
                    </td>
                    <td>
                      <Typography level="body-sm">{secret.description}</Typography>
                    </td>
                    <td>{getSourceChip(secret)}</td>
                    <td>
                      <Typography level="body-sm" fontFamily="monospace">
                        {secret.maskedValue || '-'}
                      </Typography>
                    </td>
                    <td>
                      <Stack direction="row" spacing={1}>
                        <IconButton
                          size="sm"
                          variant="plain"
                          color="primary"
                          onClick={() => handleEdit(secret)}
                          title="Edit secret"
                        >
                          <Edit fontSize="small" />
                        </IconButton>
                        {secret.dbRecord && (
                          <IconButton
                            size="sm"
                            variant="plain"
                            color="danger"
                            onClick={() => handleDelete(secret)}
                            title="Delete database override (revert to SST)"
                          >
                            <Delete fontSize="small" />
                          </IconButton>
                        )}
                      </Stack>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>
      ))}

      {/* Edit Modal */}
      <Modal open={editModalOpen} onClose={handleCloseModal}>
        <ModalDialog sx={{ maxWidth: 500 }}>
          <Typography level="h4" mb={2}>
            {editingSecret?.dbRecord ? 'Update' : 'Set'} {editingSecret?.secretName}
          </Typography>

          <Typography level="body-sm" mb={2}>
            {editingSecret?.description}
          </Typography>

          {editingSecret?.dbRecord && (
            <Alert color="neutral" size="sm" sx={{ mb: 2 }}>
              Current source: {editingSecret.source === 'database' ? 'GUI Override' : 'SST'}
              {editingSecret.maskedValue && ` (${editingSecret.maskedValue})`}
            </Alert>
          )}

          <FormControl sx={{ mb: 2 }}>
            <FormLabel>New Value</FormLabel>
            <Input
              type={showValue ? 'text' : 'password'}
              value={secretValue}
              onChange={e => setSecretValue(e.target.value)}
              placeholder="Enter secret value"
              endDecorator={
                <IconButton
                  variant="plain"
                  onClick={() => setShowValue(!showValue)}
                  title={showValue ? 'Hide value' : 'Show value'}
                >
                  {showValue ? <VisibilityOff /> : <Visibility />}
                </IconButton>
              }
            />
          </FormControl>

          <Divider sx={{ my: 2 }} />

          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button variant="plain" color="neutral" onClick={handleCloseModal}>
              Cancel
            </Button>
            <Button color="primary" onClick={handleSave} loading={saving} disabled={!secretValue.trim()}>
              Save
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>
    </Box>
  );
};

export default SystemSecretsTab;
