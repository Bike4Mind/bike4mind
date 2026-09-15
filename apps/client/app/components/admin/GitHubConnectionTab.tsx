/**
 * GitHubConnectionTab - Admin UI for managing system-level GitHub API connection
 *
 * Supports both GitHub App and Service Account PAT authentication methods.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  Checkbox,
  Chip,
  Divider,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  List,
  ListDivider,
  ListItem,
  Modal,
  ModalDialog,
  Stack,
  Typography,
  CircularProgress,
  DialogTitle,
  DialogContent,
  DialogActions,
  LinearProgress,
  Textarea,
} from '@mui/joy';
import {
  Refresh,
  Delete,
  Warning,
  CheckCircle,
  Error as ErrorIcon,
  LinkOff,
  VpnKey,
  Schedule,
  Speed,
  Search,
} from '@mui/icons-material';
import GitHubIcon from '@mui/icons-material/GitHub';
import { toast } from 'sonner';
import { isAxiosError } from 'axios';
import { api } from '@client/app/contexts/ApiContext';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { IOrgGitHubConnectionResponse } from '@bike4mind/common';
import { useAdminGitHubRepositories } from '@client/app/hooks/data/useGitHubRepositories';
import ConfirmationModal from '@client/app/components/common/ConfirmationModal';
import { sanitizeErrorMessage } from '@client/app/utils/error';

function extractErrorMessage(error: unknown, fallback: string): string {
  let message = fallback;
  if (isAxiosError(error)) {
    message = error.response?.data?.error || error.response?.data?.message || error.message;
  } else if (error instanceof Error) {
    message = error.message;
  }
  return sanitizeErrorMessage(message);
}

interface TestConnectionResult {
  success: boolean;
  type?: 'user' | 'app';
  login?: string;
  appName?: string;
  error?: string;
  latencyMs: number;
}

interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: string;
  usagePercent: number;
  isNearLimit: boolean;
}

const GitHubConnectionTab: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<IOrgGitHubConnectionResponse | null>(null);
  const [connected, setConnected] = useState(false);

  // Modal states
  const [connectAppModalOpen, setConnectAppModalOpen] = useState(false);
  const [connectPatModalOpen, setConnectPatModalOpen] = useState(false);
  const [disconnectModalOpen, setDisconnectModalOpen] = useState(false);
  const [rotateKeyModalOpen, setRotateKeyModalOpen] = useState(false);

  // Form states - GitHub App
  const [appId, setAppId] = useState('');
  const [installationId, setInstallationId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [connecting, setConnecting] = useState(false);

  // Form states - PAT
  const [accessToken, setAccessToken] = useState('');
  const [patExpiresAt, setPatExpiresAt] = useState('');

  // Other states
  const [disconnecting, setDisconnecting] = useState(false);
  const [rotatingKey, setRotatingKey] = useState(false);
  const [newPrivateKey, setNewPrivateKey] = useState('');
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [rateLimit, setRateLimit] = useState<RateLimitInfo | null>(null);
  const [loadingRateLimit, setLoadingRateLimit] = useState(false);

  // Allowed repositories state
  const [allowedRepos, setAllowedRepos] = useState<string[]>([]);
  const [editingRepos, setEditingRepos] = useState(false);
  const [savingRepos, setSavingRepos] = useState(false);
  const [showEmptyWarningModal, setShowEmptyWarningModal] = useState(false);
  const [repoSearchQuery, setRepoSearchQuery] = useState('');

  // AbortController ref to cancel in-flight requests on modal close
  const abortControllerRef = useRef<AbortController | null>(null);

  // Fetch accessible repositories for checklist (only when editing)
  const {
    data: reposData,
    isLoading: loadingRepos,
    error: reposError,
  } = useAdminGitHubRepositories(connected && editingRepos);

  const fetchConnection = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get('/api/admin/github/connection');
      setConnected(response.data.connected);
      setConnection(response.data.connection || null);
    } catch (error) {
      console.error('Error fetching GitHub connection:', error);
      toast.error('Failed to load GitHub connection');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchRateLimit = useCallback(async () => {
    // Check connected state to prevent race condition
    if (!connected) {
      setRateLimit(null);
      return;
    }
    setLoadingRateLimit(true);
    try {
      const response = await api.get('/api/admin/github/rate-limit');
      // Double-check connected state before setting data (async race protection)
      if (connected) {
        setRateLimit(response.data.rateLimit);
      }
    } catch (error) {
      console.error('Error fetching rate limit:', error);
      // Clear rate limit on error to prevent stale data
      setRateLimit(null);
    } finally {
      setLoadingRateLimit(false);
    }
  }, [connected]);

  useEffect(() => {
    fetchConnection();
  }, [fetchConnection]);

  useEffect(() => {
    if (connected) {
      fetchRateLimit();
    }
  }, [connected, fetchRateLimit]);

  // Clear sensitive form state when modals close to prevent data leakage
  useEffect(() => {
    if (!connectAppModalOpen) {
      setAppId('');
      setInstallationId('');
      setPrivateKey('');
    }
  }, [connectAppModalOpen]);

  useEffect(() => {
    if (!connectPatModalOpen) {
      setAccessToken('');
      setPatExpiresAt('');
    }
  }, [connectPatModalOpen]);

  useEffect(() => {
    if (!rotateKeyModalOpen) {
      setNewPrivateKey('');
    }
  }, [rotateKeyModalOpen]);

  // Sync allowed repos from connection
  useEffect(() => {
    if (connection?.allowedRepositories) {
      setAllowedRepos(connection.allowedRepositories);
    } else {
      setAllowedRepos([]);
    }
  }, [connection?.id, connection?.allowedRepositories]);

  const performSaveRepos = async () => {
    setSavingRepos(true);
    try {
      await api.put('/api/admin/github/connection', {
        allowedRepositories: allowedRepos,
      });
      toast.success('Allowed repositories updated');
      setEditingRepos(false);
      setRepoSearchQuery('');
      fetchConnection();
    } catch (error) {
      toast.error(extractErrorMessage(error, 'Failed to update repositories'));
    } finally {
      setSavingRepos(false);
    }
  };

  const handleSaveRepos = async () => {
    // Show confirmation modal if saving empty whitelist (blocks ALL access)
    if (allowedRepos.length === 0) {
      setShowEmptyWarningModal(true);
      return;
    }
    await performSaveRepos();
  };

  const handleConnectGitHubApp = async () => {
    if (!appId || !installationId || !privateKey) {
      toast.error('All fields are required');
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setConnecting(true);
    try {
      await api.post(
        '/api/admin/github/connection',
        {
          connectionType: 'github_app',
          appId,
          installationId,
          privateKey,
        },
        { signal: controller.signal }
      );
      // Check if aborted before processing success
      if (!controller.signal.aborted) {
        toast.success('GitHub App connected successfully');
        setConnectAppModalOpen(false);
        fetchConnection();
      }
    } catch (error) {
      // Don't show error toast if request was aborted
      if (!controller.signal.aborted) {
        toast.error(extractErrorMessage(error, 'Failed to connect GitHub App'));
      }
    } finally {
      setConnecting(false);
      abortControllerRef.current = null;
      // Always clear sensitive state after attempt (success or failure)
      setAppId('');
      setInstallationId('');
      setPrivateKey('');
    }
  };

  const handleConnectPat = async () => {
    if (!accessToken) {
      toast.error('Access token is required');
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setConnecting(true);
    try {
      await api.post(
        '/api/admin/github/connection',
        {
          connectionType: 'service_account',
          accessToken,
          patExpiresAt: patExpiresAt ? new Date(patExpiresAt).toISOString() : undefined,
        },
        { signal: controller.signal }
      );
      // Check if aborted before processing success
      if (!controller.signal.aborted) {
        toast.success('Service Account PAT connected successfully');
        setConnectPatModalOpen(false);
        fetchConnection();
      }
    } catch (error) {
      // Don't show error toast if request was aborted
      if (!controller.signal.aborted) {
        toast.error(extractErrorMessage(error, 'Failed to connect Service Account'));
      }
    } finally {
      setConnecting(false);
      abortControllerRef.current = null;
      // Always clear sensitive state after attempt (success or failure)
      setAccessToken('');
      setPatExpiresAt('');
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await api.delete('/api/admin/github/connection');
      toast.success('GitHub connection removed');
      setDisconnectModalOpen(false);
      setConnection(null);
      setConnected(false);
      setRateLimit(null);
      setTestResult(null);
    } catch (error) {
      toast.error(extractErrorMessage(error, 'Failed to disconnect'));
    } finally {
      setDisconnecting(false);
    }
  };

  const handleRotateKey = async () => {
    if (!newPrivateKey) {
      toast.error('New private key is required');
      return;
    }

    setRotatingKey(true);
    try {
      await api.post('/api/admin/github/rotate-key', {
        privateKey: newPrivateKey,
      });
      toast.success('Private key rotated successfully');
      setRotateKeyModalOpen(false);
      setNewPrivateKey('');
      fetchConnection();
    } catch (error) {
      toast.error(extractErrorMessage(error, 'Failed to rotate key'));
    } finally {
      setRotatingKey(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await api.post('/api/admin/github/test');
      setTestResult(response.data);
    } catch (error) {
      setTestResult({
        success: false,
        error: extractErrorMessage(error, 'Connection test failed'),
        latencyMs: 0,
      });
    } finally {
      setTesting(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getHealthStatus = () => {
    if (!connection?.health) return null;
    const { lastUsedAt, lastError, lastLatencyMs } = connection.health;

    // Check suspension first - takes precedence over other status
    if (connection.suspendedAt) {
      return { color: 'danger' as const, icon: <ErrorIcon fontSize="small" />, text: 'Suspended' };
    }
    if (lastError) {
      return { color: 'danger' as const, icon: <ErrorIcon fontSize="small" />, text: 'Error' };
    }
    if (lastLatencyMs && lastLatencyMs > 2000) {
      return { color: 'warning' as const, icon: <Warning fontSize="small" />, text: 'Slow' };
    }
    if (lastUsedAt) {
      return { color: 'success' as const, icon: <CheckCircle fontSize="small" />, text: 'Healthy' };
    }
    return { color: 'neutral' as const, icon: null, text: 'Unknown' };
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 200 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ p: 2 }}>
      {/* Header */}
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Stack direction="row" alignItems="center" spacing={1.5}>
          <GitHubIcon sx={{ fontSize: 28 }} />
          <Typography level="h3">GitHub Connection</Typography>
          <ContextHelpButton helpId="admin/github-connection" tooltipText="GitHub Connection Help" />
          <Chip
            size="sm"
            variant="soft"
            color={connected ? 'success' : 'neutral'}
            data-testid="github-connection-status-chip"
          >
            {connected ? 'Connected' : 'Not Connected'}
          </Chip>
        </Stack>
        <Button
          variant="outlined"
          color="neutral"
          startDecorator={<Refresh />}
          onClick={() => {
            fetchConnection();
            if (connected) fetchRateLimit();
          }}
          size="sm"
          data-testid="github-connection-refresh-btn"
        >
          Refresh
        </Button>
      </Stack>

      {/* Description */}
      <Typography level="body-sm" sx={{ mb: 3, color: 'text.secondary' }}>
        Configure the system-level GitHub API connection for outbound calls. This connection is used by system
        automation (LiveOps Triage, scheduled tasks) to interact with GitHub repositories.
      </Typography>

      {/* Not Connected State */}
      {!connected && (
        <Box
          sx={{
            textAlign: 'center',
            py: 6,
            px: 2,
            border: '1px dashed',
            borderColor: 'divider',
            borderRadius: 'md',
          }}
        >
          <GitHubIcon sx={{ fontSize: 48, opacity: 0.5, mb: 2 }} />
          <Typography level="h4" sx={{ mb: 1 }}>
            No GitHub connection configured
          </Typography>
          <Typography level="body-sm" sx={{ color: 'text.secondary', mb: 3 }}>
            Connect a GitHub App or Service Account to enable GitHub API access for system automation.
          </Typography>
          <Stack direction="row" spacing={2} justifyContent="center">
            <Button
              variant="solid"
              color="primary"
              startDecorator={<GitHubIcon />}
              onClick={() => setConnectAppModalOpen(true)}
              data-testid="github-connect-app-btn"
            >
              Connect GitHub App
            </Button>
            <Button
              variant="outlined"
              color="neutral"
              startDecorator={<VpnKey />}
              onClick={() => setConnectPatModalOpen(true)}
              data-testid="github-connect-pat-btn"
            >
              Connect with PAT
            </Button>
          </Stack>
        </Box>
      )}

      {/* Connected State */}
      {connected && connection && (
        <Stack spacing={3}>
          {/* Connection Info Card */}
          <Card variant="outlined">
            <Stack spacing={2} sx={{ p: 2 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Stack direction="row" alignItems="center" spacing={1}>
                  <GitHubIcon />
                  <Typography level="title-lg">
                    {connection.connectionType === 'github_app' ? 'GitHub App' : 'Service Account PAT'}
                  </Typography>
                  <Chip size="sm" variant="soft" color="primary">
                    {connection.connectionType === 'github_app' ? 'App' : 'PAT'}
                  </Chip>
                </Stack>
                {(() => {
                  const health = getHealthStatus();
                  if (!health) return null;
                  return (
                    <Chip
                      size="sm"
                      variant="soft"
                      color={health.color}
                      startDecorator={health.icon}
                      data-testid="github-health-status-chip"
                    >
                      {health.text}
                    </Chip>
                  );
                })()}
              </Stack>

              {/* Connection Details */}
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: 2,
                }}
              >
                {connection.connectionType === 'github_app' && (
                  <>
                    <Box>
                      <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                        App ID
                      </Typography>
                      <Typography level="body-sm" sx={{ fontFamily: 'monospace' }}>
                        {connection.appId}
                      </Typography>
                    </Box>
                    <Box>
                      <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                        Installation ID
                      </Typography>
                      <Typography level="body-sm" sx={{ fontFamily: 'monospace' }}>
                        {connection.installationId}
                      </Typography>
                    </Box>
                    {connection.repositorySelection && (
                      <Box>
                        <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                          Repository Access
                        </Typography>
                        <Typography level="body-sm">
                          {connection.repositorySelection === 'all' ? 'All repositories' : 'Selected repositories'}
                        </Typography>
                      </Box>
                    )}
                    {connection.privateKeyMasked && (
                      <Box sx={{ minWidth: 0 }}>
                        <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                          Private Key
                        </Typography>
                        <Typography
                          level="body-sm"
                          sx={{
                            fontFamily: 'monospace',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {connection.privateKeyMasked}
                        </Typography>
                      </Box>
                    )}
                  </>
                )}
                {connection.connectionType === 'service_account' && (
                  <>
                    {connection.accessTokenMasked && (
                      <Box sx={{ minWidth: 0 }}>
                        <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                          Access Token
                        </Typography>
                        <Typography
                          level="body-sm"
                          sx={{
                            fontFamily: 'monospace',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {connection.accessTokenMasked}
                        </Typography>
                      </Box>
                    )}
                    {connection.patExpiresAt && (
                      <Box>
                        <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                          Token Expires
                        </Typography>
                        <Typography level="body-sm">{formatDate(connection.patExpiresAt)}</Typography>
                      </Box>
                    )}
                  </>
                )}
                <Box>
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    Connected At
                  </Typography>
                  <Typography level="body-sm">{formatDate(connection.connectedAt)}</Typography>
                </Box>
              </Box>

              {/* PAT Expiry Warning */}
              {connection.connectionType === 'service_account' &&
                connection.patExpiresAt &&
                (() => {
                  const expiresAt = new Date(connection.patExpiresAt);
                  // eslint-disable-next-line react-hooks/purity -- Date.now() computes PAT expiry for display in JSX; presentational calculation, not rendered state
                  const daysUntilExpiry = Math.ceil((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                  if (daysUntilExpiry <= 7) {
                    return (
                      <Alert
                        color={daysUntilExpiry <= 3 ? 'danger' : 'warning'}
                        variant="outlined"
                        startDecorator={<Schedule />}
                        data-testid="github-pat-expiry-warning"
                      >
                        <Typography level="body-sm">
                          {daysUntilExpiry <= 0
                            ? 'PAT has expired! Please update with a new token.'
                            : `PAT expires in ${daysUntilExpiry} day${daysUntilExpiry !== 1 ? 's' : ''}. Consider rotating soon.`}
                        </Typography>
                      </Alert>
                    );
                  }
                  return null;
                })()}

              {/* Suspension Alert */}
              {connection.suspendedAt && (
                <Alert
                  color="danger"
                  variant="outlined"
                  startDecorator={<LinkOff />}
                  data-testid="github-suspended-alert"
                >
                  <Typography level="body-sm">
                    Installation was suspended on {formatDate(connection.suspendedAt)}. Please check your GitHub App
                    settings.
                  </Typography>
                </Alert>
              )}

              {/* Last Error */}
              {connection.health?.lastError && (
                <Alert
                  color="danger"
                  variant="outlined"
                  startDecorator={<ErrorIcon />}
                  data-testid="github-last-error-alert"
                >
                  {/* Sanitize error message to prevent XSS from legacy errors */}
                  <Typography level="body-sm">{sanitizeErrorMessage(connection.health.lastError)}</Typography>
                </Alert>
              )}
            </Stack>
          </Card>

          {/* Health & Test Connection */}
          <Card variant="outlined">
            <Stack spacing={2} sx={{ p: 2 }}>
              <Typography level="title-md">Connection Health</Typography>
              <Stack direction="row" spacing={2} alignItems="center">
                <Button
                  variant="soft"
                  color="primary"
                  onClick={handleTestConnection}
                  loading={testing}
                  data-testid="github-test-connection-btn"
                >
                  Test Connection
                </Button>
                {connection.health?.lastUsedAt && (
                  <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                    Last used: {formatDate(connection.health.lastUsedAt)}
                    {connection.health.lastLatencyMs && ` (${connection.health.lastLatencyMs}ms)`}
                  </Typography>
                )}
              </Stack>

              {/* Test Result */}
              {testResult && (
                <Alert
                  color={testResult.success ? 'success' : 'danger'}
                  variant="outlined"
                  startDecorator={testResult.success ? <CheckCircle /> : <ErrorIcon />}
                  data-testid="github-test-result-alert"
                >
                  <Stack spacing={0.5}>
                    <Typography level="body-sm" fontWeight="md">
                      {testResult.success ? 'Connection successful' : 'Connection failed'}
                    </Typography>
                    {testResult.success && (
                      <Typography level="body-xs">
                        {testResult.type === 'app'
                          ? `App: ${testResult.appName || testResult.login}`
                          : `User: ${testResult.login}`}
                        {' • '}
                        {testResult.latencyMs}ms
                      </Typography>
                    )}
                    {!testResult.success && testResult.error && (
                      <Typography level="body-xs">{sanitizeErrorMessage(testResult.error)}</Typography>
                    )}
                  </Stack>
                </Alert>
              )}
            </Stack>
          </Card>

          {/* Rate Limit */}
          <Card variant="outlined">
            <Stack spacing={2} sx={{ p: 2 }}>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Speed />
                <Typography level="title-md">Rate Limit</Typography>
                <IconButton
                  size="sm"
                  variant="plain"
                  color="neutral"
                  onClick={fetchRateLimit}
                  disabled={loadingRateLimit}
                  data-testid="github-rate-limit-refresh-btn"
                >
                  <Refresh fontSize="small" />
                </IconButton>
              </Stack>

              {loadingRateLimit ? (
                <CircularProgress size="sm" />
              ) : rateLimit ? (
                <Stack spacing={1.5}>
                  <Box>
                    <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
                      <Typography level="body-sm">
                        {rateLimit.remaining.toLocaleString()} / {rateLimit.limit.toLocaleString()} remaining
                      </Typography>
                      <Typography level="body-sm">{rateLimit.usagePercent}% used</Typography>
                    </Stack>
                    <LinearProgress
                      determinate
                      value={rateLimit.usagePercent}
                      color={rateLimit.isNearLimit ? 'warning' : 'primary'}
                      data-testid="github-rate-limit-progress"
                    />
                  </Box>
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    Resets at {formatDate(rateLimit.resetAt)}
                  </Typography>
                  {rateLimit.isNearLimit && (
                    <Alert color="warning" variant="soft" size="sm" data-testid="github-rate-limit-warning">
                      Rate limit usage is high. Consider reducing API call frequency.
                    </Alert>
                  )}
                </Stack>
              ) : (
                <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                  Click refresh to load rate limit info
                </Typography>
              )}
            </Stack>
          </Card>

          {/* Permissions (GitHub App only) */}
          {connection.connectionType === 'github_app' && connection.permissions && (
            <Card variant="outlined">
              <Stack spacing={2} sx={{ p: 2 }}>
                <Typography level="title-md">Installed Permissions</Typography>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                  {Object.entries(connection.permissions).map(([key, value]) => (
                    <Chip key={key} size="sm" variant="soft" color="neutral">
                      {key}: {value}
                    </Chip>
                  ))}
                </Box>
              </Stack>
            </Card>
          )}

          {/* Allowed Repositories Card */}
          <Card variant="outlined">
            <Stack spacing={2} sx={{ p: 2 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography level="title-md">Allowed Repositories</Typography>
                {!editingRepos && (
                  <Button
                    size="sm"
                    variant="outlined"
                    onClick={() => setEditingRepos(true)}
                    data-testid="github-edit-repos-btn"
                  >
                    Edit
                  </Button>
                )}
              </Stack>

              {allowedRepos.length === 0 ? (
                <Alert color="warning" variant="soft" size="sm">
                  <Typography level="body-sm">
                    <strong>Security:</strong> An empty whitelist blocks ALL repository access (fail-closed). You must
                    add at least one repository for LiveOps Triage and other GitHub features to work.
                  </Typography>
                </Alert>
              ) : (
                <Alert color="success" variant="soft" size="sm">
                  <Typography level="body-sm">
                    <strong>Configured:</strong> {allowedRepos.length}{' '}
                    {allowedRepos.length === 1 ? 'repository' : 'repositories'} allowed for GitHub features.
                  </Typography>
                </Alert>
              )}

              {editingRepos ? (
                <Stack spacing={2}>
                  {/* Loading state */}
                  {loadingRepos && (
                    <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                      <CircularProgress size="sm" />
                    </Box>
                  )}

                  {/* Error state */}
                  {reposError && !loadingRepos && (
                    <Alert color="danger" variant="soft" size="sm">
                      <Typography level="body-sm">Failed to load repositories. Please try again later.</Typography>
                    </Alert>
                  )}

                  {/* Show warning if repos truncated (100+ repos) */}
                  {reposData?.hasMore && (
                    <Alert color="neutral" variant="soft" size="sm">
                      <Typography level="body-sm">
                        Showing first 100 repositories. Configure additional repositories via GitHub App settings.
                      </Typography>
                    </Alert>
                  )}

                  {/* Repository checklist */}
                  {!loadingRepos && reposData?.repositories && reposData.repositories.length > 0 && (
                    <>
                      {/* Search input */}
                      <Input
                        placeholder="Search repositories..."
                        value={repoSearchQuery}
                        onChange={e => setRepoSearchQuery(e.target.value)}
                        startDecorator={<Search />}
                        size="sm"
                        data-testid="github-repo-search-input"
                      />

                      {/* Select All toggle and count */}
                      {(() => {
                        // Filter repos based on search query
                        const filteredRepos = reposData.repositories.filter(repo => {
                          if (!repoSearchQuery.trim()) return true;
                          const query = repoSearchQuery.toLowerCase();
                          return repo.full_name.toLowerCase().includes(query);
                        });

                        const allVisibleSelected =
                          filteredRepos.length > 0 && filteredRepos.every(r => allowedRepos.includes(r.full_name));
                        const someVisibleSelected =
                          filteredRepos.some(r => allowedRepos.includes(r.full_name)) && !allVisibleSelected;

                        return (
                          <>
                            <Stack direction="row" justifyContent="space-between" alignItems="center">
                              <Checkbox
                                label={allVisibleSelected ? 'Deselect All' : 'Select All'}
                                aria-label={
                                  allVisibleSelected
                                    ? `Deselect all ${filteredRepos.length} visible repositories`
                                    : `Select all ${filteredRepos.length} visible repositories`
                                }
                                checked={allVisibleSelected}
                                indeterminate={someVisibleSelected}
                                disabled={filteredRepos.length === 0}
                                onChange={e => {
                                  if (e.target.checked) {
                                    // Add all visible repos (preserve already selected hidden repos)
                                    const visibleNames = filteredRepos.map(r => r.full_name);
                                    const combined = [...new Set([...allowedRepos, ...visibleNames])];
                                    setAllowedRepos(combined);
                                  } else {
                                    // Remove only visible repos (preserve selected hidden repos)
                                    const visibleNames = new Set(filteredRepos.map(r => r.full_name));
                                    setAllowedRepos(allowedRepos.filter(r => !visibleNames.has(r)));
                                  }
                                }}
                                data-testid="github-select-all"
                              />
                              <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                                {allowedRepos.length} of {reposData.repositories.length} selected
                              </Typography>
                            </Stack>

                            <Divider />

                            {/* No search results message */}
                            {filteredRepos.length === 0 && repoSearchQuery.trim() ? (
                              <Typography level="body-sm" sx={{ color: 'text.tertiary', textAlign: 'center', py: 2 }}>
                                No repositories found matching &quot;{repoSearchQuery}&quot;
                              </Typography>
                            ) : (
                              /* Scrollable repository list */
                              <List
                                size="sm"
                                variant="outlined"
                                sx={{
                                  borderRadius: 'sm',
                                  maxHeight: 300,
                                  overflow: 'auto',
                                }}
                              >
                                {filteredRepos.map((repo, index) => (
                                  <Box key={repo.id}>
                                    {index > 0 && <ListDivider />}
                                    <ListItem>
                                      <Checkbox
                                        checked={allowedRepos.includes(repo.full_name)}
                                        onChange={e => {
                                          if (e.target.checked) {
                                            setAllowedRepos([...allowedRepos, repo.full_name]);
                                          } else {
                                            setAllowedRepos(allowedRepos.filter(r => r !== repo.full_name));
                                          }
                                        }}
                                        label={
                                          <Stack direction="row" spacing={1} alignItems="center">
                                            <Typography level="body-sm" sx={{ fontFamily: 'monospace' }}>
                                              {repo.full_name}
                                            </Typography>
                                            <Chip size="sm" variant="soft" color={repo.private ? 'warning' : 'success'}>
                                              {repo.private ? 'Private' : 'Public'}
                                            </Chip>
                                          </Stack>
                                        }
                                        data-testid={`github-repo-checkbox-${repo.id}`}
                                      />
                                    </ListItem>
                                  </Box>
                                ))}
                              </List>
                            )}
                          </>
                        );
                      })()}
                    </>
                  )}

                  {/* No repos found message */}
                  {!loadingRepos && reposData?.repositories && reposData.repositories.length === 0 && (
                    <Typography level="body-sm" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
                      No repositories found. The GitHub App may not have access to any repositories.
                    </Typography>
                  )}

                  <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 2 }}>
                    <Button
                      variant="plain"
                      color="neutral"
                      onClick={() => {
                        setEditingRepos(false);
                        setAllowedRepos(connection.allowedRepositories || []);
                        setRepoSearchQuery('');
                      }}
                      data-testid="github-cancel-repos-btn"
                    >
                      Cancel
                    </Button>
                    <Button onClick={handleSaveRepos} loading={savingRepos} data-testid="github-save-repos-btn">
                      Save
                    </Button>
                  </Stack>
                </Stack>
              ) : allowedRepos.length > 0 ? (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                  {allowedRepos.map(repo => (
                    <Chip key={repo} size="sm" variant="soft" color="neutral">
                      {repo}
                    </Chip>
                  ))}
                </Box>
              ) : (
                <Typography level="body-sm" sx={{ fontStyle: 'italic', color: 'text.tertiary' }}>
                  No repositories configured (all access blocked)
                </Typography>
              )}
            </Stack>
          </Card>

          {/* Actions */}
          <Card variant="outlined">
            <Stack spacing={2} sx={{ p: 2 }}>
              <Typography level="title-md">Actions</Typography>
              <Stack direction="row" spacing={2}>
                {connection.connectionType === 'github_app' && (
                  <Button
                    variant="outlined"
                    color="warning"
                    startDecorator={<VpnKey />}
                    onClick={() => setRotateKeyModalOpen(true)}
                    data-testid="github-rotate-key-btn"
                  >
                    Rotate Private Key
                  </Button>
                )}
                <Button
                  variant="outlined"
                  color="danger"
                  startDecorator={<Delete />}
                  onClick={() => setDisconnectModalOpen(true)}
                  data-testid="github-disconnect-btn"
                >
                  Disconnect
                </Button>
              </Stack>
            </Stack>
          </Card>
        </Stack>
      )}

      {/* Connect GitHub App Modal */}
      <Modal
        open={connectAppModalOpen}
        onClose={() => {
          if (!connecting) {
            // Abort in-flight requests when modal closes
            if (abortControllerRef.current) {
              abortControllerRef.current.abort();
              abortControllerRef.current = null;
            }
            setConnectAppModalOpen(false);
            setAppId('');
            setInstallationId('');
            setPrivateKey('');
            // Clear test result on modal close
            setTestResult(null);
          }
        }}
      >
        <ModalDialog variant="outlined" sx={{ minWidth: 500 }}>
          <DialogTitle>
            <GitHubIcon sx={{ mr: 1 }} />
            Connect GitHub App
          </DialogTitle>
          <DialogContent>
            <Stack spacing={2}>
              <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                Enter your GitHub App credentials. You can find these in your GitHub App settings.
              </Typography>

              <Alert color="neutral" variant="soft" size="sm">
                <Typography level="body-xs">
                  Create a GitHub App at{' '}
                  <a
                    href="https://github.com/settings/apps/new"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'inherit', textDecoration: 'underline' }}
                  >
                    github.com/settings/apps
                  </a>
                  . Required permissions: Issues (Read & Write), Contents (Read).
                </Typography>
              </Alert>

              <FormControl required>
                <FormLabel>App ID</FormLabel>
                <Input
                  placeholder="123456"
                  value={appId}
                  onChange={e => setAppId(e.target.value)}
                  disabled={connecting}
                  slotProps={{ input: { 'data-testid': 'github-app-id-input' } }}
                />
              </FormControl>

              <FormControl required>
                <FormLabel>Installation ID</FormLabel>
                <Input
                  placeholder="12345678"
                  value={installationId}
                  onChange={e => setInstallationId(e.target.value)}
                  disabled={connecting}
                  slotProps={{ input: { 'data-testid': 'github-installation-id-input' } }}
                />
                <Typography level="body-xs" sx={{ mt: 0.5, color: 'text.secondary' }}>
                  Found in Settings → Installations → Configure → URL contains installation ID
                </Typography>
              </FormControl>

              <FormControl required>
                <FormLabel>Private Key (PEM)</FormLabel>
                <Textarea
                  placeholder="-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----"
                  value={privateKey}
                  onChange={e => setPrivateKey(e.target.value)}
                  disabled={connecting}
                  minRows={10}
                  maxRows={8}
                  slotProps={{
                    textarea: {
                      'data-testid': 'github-private-key-input',
                      autoComplete: 'off',
                    },
                  }}
                />
                <Typography level="body-xs" sx={{ mt: 0.5, color: 'text.secondary' }}>
                  Generate in your GitHub App settings → Private keys
                </Typography>
              </FormControl>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              variant="plain"
              color="neutral"
              onClick={() => {
                setConnectAppModalOpen(false);
                setAppId('');
                setInstallationId('');
                setPrivateKey('');
              }}
              disabled={connecting}
              data-testid="github-connect-app-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              color="primary"
              onClick={handleConnectGitHubApp}
              loading={connecting}
              disabled={!appId || !installationId || !privateKey}
              data-testid="github-connect-app-confirm-btn"
            >
              Connect
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>

      {/* Connect PAT Modal */}
      <Modal
        open={connectPatModalOpen}
        onClose={() => {
          if (!connecting) {
            // Abort in-flight requests when modal closes
            if (abortControllerRef.current) {
              abortControllerRef.current.abort();
              abortControllerRef.current = null;
            }
            setConnectPatModalOpen(false);
            setAccessToken('');
            setPatExpiresAt('');
            // Clear test result on modal close
            setTestResult(null);
          }
        }}
      >
        <ModalDialog variant="outlined" sx={{ minWidth: 450 }}>
          <DialogTitle>
            <VpnKey sx={{ mr: 1 }} />
            Connect Service Account PAT
          </DialogTitle>
          <DialogContent>
            <Stack spacing={2}>
              <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                Enter a Fine-grained Personal Access Token from a service account.
              </Typography>

              <Alert color="neutral" variant="soft" size="sm">
                <Typography level="body-xs">
                  Generate a Fine-grained PAT at{' '}
                  <a
                    href="https://github.com/settings/personal-access-tokens/new"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'inherit', textDecoration: 'underline' }}
                  >
                    github.com/settings/personal-access-tokens
                  </a>
                  . Required permissions: Issues (Read & Write), Contents (Read).
                </Typography>
              </Alert>

              <FormControl required>
                <FormLabel>Access Token</FormLabel>
                <Input
                  type="password"
                  placeholder="github_pat_..."
                  value={accessToken}
                  onChange={e => setAccessToken(e.target.value)}
                  disabled={connecting}
                  slotProps={{
                    input: {
                      'data-testid': 'github-pat-input',
                      autoComplete: 'off',
                    },
                  }}
                />
              </FormControl>

              <FormControl>
                <FormLabel>Expiration Date (Optional)</FormLabel>
                <Input
                  type="date"
                  value={patExpiresAt}
                  onChange={e => setPatExpiresAt(e.target.value)}
                  disabled={connecting}
                  slotProps={{ input: { 'data-testid': 'github-pat-expiry-input' } }}
                />
                <Typography level="body-xs" sx={{ mt: 0.5, color: 'text.secondary' }}>
                  Fine-grained PATs have a maximum expiry of 1 year
                </Typography>
              </FormControl>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              variant="plain"
              color="neutral"
              onClick={() => {
                setConnectPatModalOpen(false);
                setAccessToken('');
                setPatExpiresAt('');
              }}
              disabled={connecting}
              data-testid="github-connect-pat-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              color="primary"
              onClick={handleConnectPat}
              loading={connecting}
              disabled={!accessToken}
              data-testid="github-connect-pat-confirm-btn"
            >
              Connect
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>

      {/* Disconnect Confirmation Modal */}
      <Modal
        open={disconnectModalOpen}
        onClose={() => {
          if (!disconnecting) setDisconnectModalOpen(false);
        }}
      >
        <ModalDialog variant="outlined" role="alertdialog">
          <DialogTitle>
            <Warning sx={{ color: 'warning.500', mr: 1 }} />
            Disconnect GitHub
          </DialogTitle>
          <DialogContent>
            <Typography level="body-md">Are you sure you want to disconnect the GitHub connection?</Typography>
            <Typography level="body-sm" sx={{ mt: 1, color: 'text.secondary' }}>
              System automation (LiveOps Triage, scheduled tasks) will no longer be able to access GitHub APIs until a
              new connection is configured.
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button
              variant="plain"
              color="neutral"
              onClick={() => setDisconnectModalOpen(false)}
              disabled={disconnecting}
              data-testid="github-disconnect-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              color="danger"
              onClick={handleDisconnect}
              loading={disconnecting}
              data-testid="github-disconnect-confirm-btn"
            >
              Disconnect
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>

      {/* Rotate Key Modal */}
      <Modal
        open={rotateKeyModalOpen}
        onClose={() => {
          if (!rotatingKey) {
            setRotateKeyModalOpen(false);
            setNewPrivateKey('');
          }
        }}
      >
        <ModalDialog variant="outlined" sx={{ minWidth: 500 }}>
          <DialogTitle>
            <VpnKey sx={{ color: 'warning.500', mr: 1 }} />
            Rotate Private Key
          </DialogTitle>
          <DialogContent>
            <Stack spacing={2}>
              <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                Enter a new private key to replace the current one. The old key will be invalidated immediately.
              </Typography>

              <Alert color="warning" variant="soft" size="sm">
                <Typography level="body-xs">
                  Generate a new private key in your GitHub App settings before rotating. The old key should be revoked
                  in GitHub after rotation.
                </Typography>
              </Alert>

              <FormControl required>
                <FormLabel>New Private Key (PEM)</FormLabel>
                <Textarea
                  placeholder="-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----"
                  value={newPrivateKey}
                  onChange={e => setNewPrivateKey(e.target.value)}
                  disabled={rotatingKey}
                  minRows={10}
                  maxRows={8}
                  slotProps={{
                    textarea: {
                      'data-testid': 'github-new-private-key-input',
                      autoComplete: 'off',
                    },
                  }}
                />
              </FormControl>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              variant="plain"
              color="neutral"
              onClick={() => {
                setRotateKeyModalOpen(false);
                setNewPrivateKey('');
              }}
              disabled={rotatingKey}
              data-testid="github-rotate-key-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              color="warning"
              onClick={handleRotateKey}
              loading={rotatingKey}
              disabled={!newPrivateKey}
              data-testid="github-rotate-key-confirm-btn"
            >
              Rotate Key
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>

      {/* Empty Whitelist Warning Modal */}
      <ConfirmationModal
        open={showEmptyWarningModal}
        onClose={() => setShowEmptyWarningModal(false)}
        onConfirm={async () => {
          await performSaveRepos();
          setShowEmptyWarningModal(false);
        }}
        loading={savingRepos}
        title="Warning: Empty Repository Whitelist"
        description="Saving an empty whitelist will block ALL GitHub repository access. LiveOps Triage and other GitHub features will not work until repositories are added."
        confirmText="Save Empty Whitelist"
        cancelText="Cancel"
        confirmColor="danger"
        showWarningIcon
      />
    </Box>
  );
};

export default GitHubConnectionTab;
