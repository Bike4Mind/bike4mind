/**
 * GitHubConnectionTab - Admin UI for managing system-level GitHub API connection
 *
 * Supports both GitHub App and Service Account PAT authentication methods.
 */

import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Link,
  List,
  ListDivider,
  ListItem,
  Stack,
  Tooltip,
  Typography,
  LinearProgress,
  Textarea,
} from '@mui/joy';
import Refresh from '@mui/icons-material/Refresh';
import ErrorIcon from '@mui/icons-material/Error';
import LinkOff from '@mui/icons-material/LinkOff';
import VpnKey from '@mui/icons-material/VpnKey';
import Schedule from '@mui/icons-material/Schedule';
import Search from '@mui/icons-material/Search';
import GitHubIcon from '@mui/icons-material/GitHub';
import { toast } from 'sonner';
import { isAxiosError } from 'axios';
import { api } from '@client/app/contexts/ApiContext';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { IOrgGitHubConnectionResponse } from '@bike4mind/common';
import { useAdminGitHubRepositories } from '@client/app/hooks/data/useGitHubRepositories';
import { sanitizeErrorMessage } from '@client/app/utils/error';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import {
  ADMIN_REASON_PRESETS,
  ActionDialog,
  AdminDialog,
  AdminPageHeader,
  EmptyState,
  ErrorState,
  Fact,
  LoadingState,
  SectionCard,
  StatusChip,
  UpdatingBar,
} from './shared';
import { ADMIN_DETAIL_MAX_WIDTH, ADMIN_REGION_GAP } from './shared/adminStyles';

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

const LOAD_ERROR = 'The GitHub connection failed to load.';

/** Whole days until a PAT expires; zero or less once it has. */
const daysUntil = (dateString: string) =>
  Math.ceil((new Date(dateString).getTime() - Date.now()) / (1000 * 60 * 60 * 24));

const Mono: React.FC<{ children: ReactNode }> = ({ children }) => (
  <Typography
    component="span"
    level="body-xs"
    sx={{ fontFamily: 'code', color: 'admin.inkMuted', overflowWrap: 'anywhere' }}
  >
    {children}
  </Typography>
);

/** Cancel and commit buttons at the bottom-right of a dialog, as ActionDialog lays them out. */
const DialogFooter: React.FC<{ children: ReactNode }> = ({ children }) => (
  <Stack
    direction="row"
    justifyContent="flex-end"
    gap={1}
    flexWrap="wrap"
    sx={{ pt: 2, mt: 1, borderTop: '1px solid', borderColor: 'admin.border' }}
  >
    {children}
  </Stack>
);

const GitHubConnectionTab: React.FC = () => {
  const [loading, setLoading] = useState(true);
  // After the first load a refetch keeps the page on screen under UpdatingBar.
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
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
  const [rateLimitFailed, setRateLimitFailed] = useState(false);

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
    refetch: refetchRepos,
  } = useAdminGitHubRepositories(connected && editingRepos);

  const fetchConnection = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get('/api/admin/github/connection');
      setConnected(response.data.connected);
      setConnection(response.data.connection || null);
      setLoadError(null);
    } catch (error) {
      console.error('Error fetching GitHub connection:', error);
      setLoadError(LOAD_ERROR);
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  }, []);

  const fetchRateLimit = useCallback(async () => {
    // Check connected state to prevent race condition
    if (!connected) {
      setRateLimit(null);
      return;
    }
    setLoadingRateLimit(true);
    setRateLimitFailed(false);
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
      setRateLimitFailed(true);
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

  const getHealthStatus = (): { tone: AdminStatusTone; text: string } | null => {
    if (!connection?.health) return null;
    const { lastUsedAt, lastError, lastLatencyMs } = connection.health;

    // Check suspension first - takes precedence over other status
    if (connection.suspendedAt) {
      return { tone: 'bad', text: 'Suspended' };
    }
    if (lastError) {
      return { tone: 'bad', text: 'Error' };
    }
    if (lastLatencyMs && lastLatencyMs > 2000) {
      return { tone: 'warn', text: 'Slow' };
    }
    if (lastUsedAt) {
      return { tone: 'good', text: 'Healthy' };
    }
    return { tone: 'neutral', text: 'Unknown' };
  };

  const closeConnectAppDialog = () => {
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
  };

  const closeConnectPatDialog = () => {
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
  };

  const showConnection = loadedOnce && !loadError && connected && connection !== null;
  const isApp = connection?.connectionType === 'github_app';
  const health = getHealthStatus();
  const patDaysLeft =
    connection?.connectionType === 'service_account' && connection.patExpiresAt
      ? daysUntil(connection.patExpiresAt)
      : null;
  const expiryAlert =
    patDaysLeft !== null && patDaysLeft <= 7 ? (
      <Alert
        color={patDaysLeft <= 3 ? 'danger' : 'warning'}
        startDecorator={<Schedule />}
        data-testid="github-pat-expiry-warning"
      >
        {patDaysLeft <= 0
          ? 'PAT has expired! Please update with a new token.'
          : `PAT expires in ${patDaysLeft} day${patDaysLeft !== 1 ? 's' : ''}. Consider rotating soon.`}
      </Alert>
    ) : null;

  const repositories = reposData?.repositories ?? [];
  const filteredRepos = repositories.filter(repo => {
    if (!repoSearchQuery.trim()) return true;
    const query = repoSearchQuery.toLowerCase();
    return repo.full_name.toLowerCase().includes(query);
  });
  const allVisibleSelected = filteredRepos.length > 0 && filteredRepos.every(r => allowedRepos.includes(r.full_name));
  const someVisibleSelected = filteredRepos.some(r => allowedRepos.includes(r.full_name)) && !allVisibleSelected;

  let body: ReactNode = null;
  if (!loadedOnce) body = <LoadingState label="Loading GitHub connection" />;
  else if (loadError) body = <ErrorState message={loadError} onRetry={fetchConnection} retrying={loading} />;
  else if (!connected)
    body = (
      <EmptyState
        title="No GitHub connection"
        description="Connect a GitHub App or a service account token so system automation can call the GitHub API."
        action={
          <Stack direction="row" gap={1} flexWrap="wrap" justifyContent="center">
            <Button
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
        }
      />
    );
  else if (connection)
    body = (
      <>
        <UpdatingBar active={loading} testId="github-connection-updating" />

        {(expiryAlert || connection.suspendedAt || connection.health?.lastError) && (
          <Stack gap={2}>
            {expiryAlert}
            {connection.suspendedAt && (
              <Alert color="danger" startDecorator={<LinkOff />} data-testid="github-suspended-alert">
                Installation was suspended on {formatDate(connection.suspendedAt)}. Please check your GitHub App
                settings.
              </Alert>
            )}
            {connection.health?.lastError && (
              <Alert color="danger" startDecorator={<ErrorIcon />} data-testid="github-last-error-alert">
                {/* Sanitize error message to prevent XSS from legacy errors */}
                {sanitizeErrorMessage(connection.health.lastError)}
              </Alert>
            )}
          </Stack>
        )}

        <SectionCard
          title={isApp ? 'GitHub App' : 'Service account PAT'}
          action={
            health ? (
              <StatusChip tone={health.tone} label={health.text} dot data-testid="github-health-status-chip" />
            ) : (
              <StatusChip tone="good" label="Connected" dot data-testid="github-connection-status-chip" />
            )
          }
          data-testid="github-connection-details"
        >
          {isApp && (
            <>
              <Fact label="App ID">{connection.appId && <Mono>{connection.appId}</Mono>}</Fact>
              <Fact label="Installation ID">
                {connection.installationId && <Mono>{connection.installationId}</Mono>}
              </Fact>
              {connection.repositorySelection && (
                <Fact label="Repository access">
                  {connection.repositorySelection === 'all' ? 'All repositories' : 'Selected repositories'}
                </Fact>
              )}
              {connection.privateKeyMasked && (
                <Fact label="Private key">
                  <Mono>{connection.privateKeyMasked}</Mono>
                </Fact>
              )}
            </>
          )}
          {connection.connectionType === 'service_account' && (
            <>
              {connection.accessTokenMasked && (
                <Fact label="Access token">
                  <Mono>{connection.accessTokenMasked}</Mono>
                </Fact>
              )}
              {connection.patExpiresAt && <Fact label="Token expires">{formatDate(connection.patExpiresAt)}</Fact>}
            </>
          )}
          <Fact label="Connected at">{formatDate(connection.connectedAt)}</Fact>
        </SectionCard>

        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' } }}>
          <SectionCard title="Connection health" body="custom" data-testid="github-connection-health">
            <Stack gap={2} sx={{ p: 2 }}>
              <Stack direction="row" gap={2} alignItems="center" flexWrap="wrap">
                <Button
                  variant="outlined"
                  color="neutral"
                  onClick={handleTestConnection}
                  loading={testing}
                  data-testid="github-test-connection-btn"
                >
                  Test connection
                </Button>
                {connection.health?.lastUsedAt && (
                  <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
                    Last used: {formatDate(connection.health.lastUsedAt)}
                    {connection.health.lastLatencyMs && ` (${connection.health.lastLatencyMs}ms)`}
                  </Typography>
                )}
              </Stack>

              {testResult && (
                <Alert
                  color={testResult.success ? 'success' : 'danger'}
                  startDecorator={testResult.success ? undefined : <ErrorIcon />}
                  data-testid="github-test-result-alert"
                >
                  <Stack gap={0.5} sx={{ minWidth: 0 }}>
                    <Typography level="title-sm">
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
          </SectionCard>

          <SectionCard
            title="Rate limit"
            body="custom"
            action={
              <Tooltip title="Refresh rate limit">
                <IconButton
                  size="sm"
                  variant="plain"
                  aria-label="Refresh rate limit"
                  onClick={fetchRateLimit}
                  disabled={loadingRateLimit}
                  data-testid="github-rate-limit-refresh-btn"
                >
                  <Refresh />
                </IconButton>
              </Tooltip>
            }
            data-testid="github-rate-limit"
          >
            {loadingRateLimit ? (
              <LoadingState label="Loading rate limit" />
            ) : rateLimit ? (
              <Stack gap={1.5} sx={{ p: 2 }}>
                <Box>
                  <Stack direction="row" justifyContent="space-between" gap={1} flexWrap="wrap" sx={{ mb: 0.5 }}>
                    <Typography level="body-sm" sx={{ color: 'admin.ink' }}>
                      {rateLimit.remaining.toLocaleString()} / {rateLimit.limit.toLocaleString()} remaining
                    </Typography>
                    <Typography level="body-sm" sx={{ color: 'admin.ink' }}>
                      {rateLimit.usagePercent}% used
                    </Typography>
                  </Stack>
                  <LinearProgress
                    determinate
                    value={rateLimit.usagePercent}
                    color={rateLimit.isNearLimit ? 'warning' : 'primary'}
                    data-testid="github-rate-limit-progress"
                  />
                </Box>
                <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                  Resets at {formatDate(rateLimit.resetAt)}
                </Typography>
                {rateLimit.isNearLimit && (
                  <Alert color="warning" size="sm" data-testid="github-rate-limit-warning">
                    Rate limit usage is high. Consider reducing API call frequency.
                  </Alert>
                )}
              </Stack>
            ) : rateLimitFailed ? (
              <ErrorState message="The rate limit failed to load." onRetry={fetchRateLimit} />
            ) : (
              <EmptyState
                title="No rate limit loaded"
                description="Load the current GitHub API rate limit."
                action={
                  <Button
                    variant="outlined"
                    color="neutral"
                    onClick={fetchRateLimit}
                    data-testid="github-rate-limit-load-btn"
                  >
                    Load rate limit
                  </Button>
                }
              />
            )}
          </SectionCard>
        </Box>

        {isApp && connection.permissions && (
          <SectionCard title="Installed permissions" body="custom" data-testid="github-permissions">
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, p: 2 }}>
              {Object.entries(connection.permissions).map(([key, value]) => (
                <Chip key={key} size="sm" variant="soft" color="neutral">
                  {key}: {value}
                </Chip>
              ))}
            </Box>
          </SectionCard>
        )}

        <SectionCard
          title="Allowed repositories"
          body="custom"
          action={
            !editingRepos && (
              <Button
                size="sm"
                variant="plain"
                color="neutral"
                onClick={() => setEditingRepos(true)}
                data-testid="github-edit-repos-btn"
              >
                Edit
              </Button>
            )
          }
          data-testid="github-allowed-repos"
        >
          <Stack gap={2} sx={{ p: 2 }}>
            {allowedRepos.length === 0 ? (
              <Alert color="warning" size="sm" data-testid="github-repos-empty-alert">
                <Typography level="body-sm">
                  <strong>Security:</strong> An empty whitelist blocks ALL repository access (fail-closed). You must add
                  at least one repository for LiveOps Triage and other GitHub features to work.
                </Typography>
              </Alert>
            ) : (
              <Typography level="body-sm" sx={{ color: 'admin.ink' }} data-testid="github-repos-count">
                {allowedRepos.length} {allowedRepos.length === 1 ? 'repository' : 'repositories'} allowed for GitHub
                features.
              </Typography>
            )}

            {editingRepos ? (
              <Stack gap={2}>
                {loadingRepos && <LoadingState label="Loading repositories" />}

                {reposError && !loadingRepos && (
                  <ErrorState message="Repositories failed to load." onRetry={() => void refetchRepos()} />
                )}

                {/* Show warning if repos truncated (100+ repos) */}
                {reposData?.hasMore && (
                  <Alert color="neutral" size="sm">
                    Showing first 100 repositories. Configure additional repositories via GitHub App settings.
                  </Alert>
                )}

                {!loadingRepos && repositories.length > 0 && (
                  <>
                    <Input
                      placeholder="Search repositories..."
                      value={repoSearchQuery}
                      onChange={e => setRepoSearchQuery(e.target.value)}
                      startDecorator={<Search />}
                      size="sm"
                      data-testid="github-repo-search-input"
                    />

                    <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
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
                      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                        {allowedRepos.length} of {repositories.length} selected
                      </Typography>
                    </Stack>

                    {filteredRepos.length === 0 && repoSearchQuery.trim() ? (
                      <Typography level="body-sm" sx={{ color: 'admin.inkMuted', textAlign: 'center', py: 2 }}>
                        No repositories found matching &quot;{repoSearchQuery}&quot;
                      </Typography>
                    ) : (
                      <List
                        size="sm"
                        sx={{
                          maxHeight: '18rem',
                          overflow: 'auto',
                          borderTop: '1px solid',
                          borderBottom: '1px solid',
                          borderColor: 'admin.border',
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
                                  <Stack direction="row" gap={1} alignItems="center">
                                    <Typography level="body-sm" sx={{ fontFamily: 'code', color: 'admin.ink' }}>
                                      {repo.full_name}
                                    </Typography>
                                    <Chip size="sm" variant="soft" color="neutral">
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
                )}

                {!loadingRepos && reposData?.repositories && reposData.repositories.length === 0 && (
                  <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
                    No repositories found. The GitHub App may not have access to any repositories.
                  </Typography>
                )}

                <Stack direction="row" gap={1} justifyContent="flex-end">
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
              <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
                No repositories configured (all access blocked)
              </Typography>
            )}
          </Stack>
        </SectionCard>
      </>
    );

  return (
    <Stack
      gap={ADMIN_REGION_GAP}
      sx={{ minWidth: 0, maxWidth: ADMIN_DETAIL_MAX_WIDTH }}
      data-testid="github-connection-tab"
    >
      <AdminPageHeader
        title="GitHub connection"
        description="The system GitHub API connection that automation such as LiveOps triage and scheduled tasks uses."
        actions={
          <>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              startDecorator={<Refresh />}
              loading={loading && loadedOnce}
              onClick={() => {
                fetchConnection();
                if (connected) fetchRateLimit();
              }}
              data-testid="github-connection-refresh-btn"
            >
              Refresh
            </Button>
            {showConnection && isApp && (
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                startDecorator={<VpnKey />}
                onClick={() => setRotateKeyModalOpen(true)}
                data-testid="github-rotate-key-btn"
              >
                Rotate private key
              </Button>
            )}
            {showConnection && (
              <Button
                size="sm"
                variant="outlined"
                color="danger"
                startDecorator={<LinkOff />}
                onClick={() => setDisconnectModalOpen(true)}
                data-testid="github-disconnect-btn"
              >
                Disconnect
              </Button>
            )}
            <ContextHelpButton helpId="admin/github-connection" tooltipText="GitHub connection help" />
          </>
        }
      />

      {body}

      <AdminDialog
        open={connectAppModalOpen}
        onClose={closeConnectAppDialog}
        title="Connect GitHub App"
        width={560}
        data-testid="github-connect-app-dialog"
      >
        <Stack gap={2}>
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            Enter your GitHub App credentials. You can find these in your GitHub App settings.
          </Typography>

          <Alert color="neutral" size="sm">
            <Typography level="body-xs">
              Create a GitHub App at{' '}
              <Link href="https://github.com/settings/apps/new" target="_blank" rel="noopener noreferrer">
                github.com/settings/apps
              </Link>
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
            <Typography level="body-xs" sx={{ mt: 0.5, color: 'admin.inkMuted' }}>
              Found in Settings {'→'} Installations {'→'} Configure {'→'} URL contains installation ID
            </Typography>
          </FormControl>

          <FormControl required>
            <FormLabel>Private key (PEM)</FormLabel>
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
            <Typography level="body-xs" sx={{ mt: 0.5, color: 'admin.inkMuted' }}>
              Generate in your GitHub App settings {'→'} Private keys
            </Typography>
          </FormControl>
        </Stack>
        <DialogFooter>
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
            onClick={handleConnectGitHubApp}
            loading={connecting}
            disabled={!appId || !installationId || !privateKey}
            data-testid="github-connect-app-confirm-btn"
          >
            Connect
          </Button>
        </DialogFooter>
      </AdminDialog>

      <AdminDialog
        open={connectPatModalOpen}
        onClose={closeConnectPatDialog}
        title="Connect service account PAT"
        width={480}
        data-testid="github-connect-pat-dialog"
      >
        <Stack gap={2}>
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            Enter a Fine-grained Personal Access Token from a service account.
          </Typography>

          <Alert color="neutral" size="sm">
            <Typography level="body-xs">
              Generate a Fine-grained PAT at{' '}
              <Link
                href="https://github.com/settings/personal-access-tokens/new"
                target="_blank"
                rel="noopener noreferrer"
              >
                github.com/settings/personal-access-tokens
              </Link>
              . Required permissions: Issues (Read & Write), Contents (Read).
            </Typography>
          </Alert>

          <FormControl required>
            <FormLabel>Access token</FormLabel>
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
            <FormLabel>Expiration date (optional)</FormLabel>
            <Input
              type="date"
              value={patExpiresAt}
              onChange={e => setPatExpiresAt(e.target.value)}
              disabled={connecting}
              slotProps={{ input: { 'data-testid': 'github-pat-expiry-input' } }}
            />
            <Typography level="body-xs" sx={{ mt: 0.5, color: 'admin.inkMuted' }}>
              Fine-grained PATs have a maximum expiry of 1 year
            </Typography>
          </FormControl>
        </Stack>
        <DialogFooter>
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
            onClick={handleConnectPat}
            loading={connecting}
            disabled={!accessToken}
            data-testid="github-connect-pat-confirm-btn"
          >
            Connect
          </Button>
        </DialogFooter>
      </AdminDialog>

      <ActionDialog
        open={disconnectModalOpen}
        onClose={() => {
          if (!disconnecting) setDisconnectModalOpen(false);
        }}
        title="Disconnect GitHub"
        description="System automation (LiveOps Triage, scheduled tasks) will no longer be able to access GitHub APIs until a new connection is configured."
        reasonPresets={ADMIN_REASON_PRESETS.githubDisconnect}
        reasonAudited={false}
        confirmLabel="Disconnect GitHub"
        tone="danger"
        pending={disconnecting}
        onConfirm={handleDisconnect}
        data-testid="github-disconnect-dialog"
        testIds={{ confirm: 'github-disconnect-confirm-btn' }}
      />

      <ActionDialog
        open={rotateKeyModalOpen}
        onClose={() => {
          if (!rotatingKey) {
            setRotateKeyModalOpen(false);
            setNewPrivateKey('');
          }
        }}
        title="Rotate private key"
        description="Enter a new private key to replace the current one. The old key will be invalidated immediately."
        reasonPresets={ADMIN_REASON_PRESETS.githubKeyRotate}
        reasonAudited={false}
        confirmLabel="Rotate key"
        tone="danger"
        pending={rotatingKey}
        blockedReason={newPrivateKey ? null : 'Paste the new private key to rotate.'}
        onConfirm={handleRotateKey}
        data-testid="github-rotate-key-dialog"
        testIds={{ confirm: 'github-rotate-key-confirm-btn' }}
      >
        <Alert color="warning" size="sm">
          Generate a new private key in your GitHub App settings before rotating. The old key should be revoked in
          GitHub after rotation.
        </Alert>
        <FormControl required>
          <FormLabel>New private key (PEM)</FormLabel>
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
      </ActionDialog>

      <ActionDialog
        open={showEmptyWarningModal}
        onClose={() => setShowEmptyWarningModal(false)}
        title="Save an empty repository whitelist"
        description="Saving an empty whitelist will block ALL GitHub repository access. LiveOps Triage and other GitHub features will not work until repositories are added."
        reasonPresets={ADMIN_REASON_PRESETS.githubRepoAccess}
        reasonAudited={false}
        confirmLabel="Save empty whitelist"
        tone="danger"
        pending={savingRepos}
        onConfirm={async () => {
          await performSaveRepos();
          setShowEmptyWarningModal(false);
        }}
        data-testid="github-empty-repos-dialog"
      />
    </Stack>
  );
};

export default GitHubConnectionTab;
