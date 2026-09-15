/**
 * OrgGitHubConnectionTab - UI for managing organization-level GitHub API connection
 *
 * Supports both GitHub App and Service Account PAT authentication methods.
 * Includes allowed repositories management, PAT rotation, and connection health monitoring.
 */

import { useState, useEffect } from 'react';
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
  List,
  ListItem,
  ListDivider,
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
import {
  useGetOrgGitHubConnection,
  useCreateOrgGitHubConnection,
  useUpdateOrgGitHubConnection,
  useDeleteOrgGitHubConnection,
  useTestOrgGitHubConnection,
  useGetOrgGitHubRateLimit,
  useRotateOrgGitHubKey,
  useRotateOrgGitHubPAT,
} from '@client/app/hooks/data/useOrgGitHubConnection';
import { useOrgGitHubRepositories } from '@client/app/hooks/data/useGitHubRepositories';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { sanitizeErrorMessage } from '@client/app/utils/error';

interface OrgGitHubConnectionTabProps {
  orgId: string;
}

interface TestConnectionResult {
  success: boolean;
  type?: 'user' | 'app';
  login?: string;
  appName?: string;
  error?: string;
  latencyMs: number;
}

const OrgGitHubConnectionTab: React.FC<OrgGitHubConnectionTabProps> = ({ orgId }) => {
  // Query hooks
  const { data: connectionData, isLoading, refetch } = useGetOrgGitHubConnection(orgId);
  const {
    data: rateLimit,
    isLoading: loadingRateLimit,
    refetch: refetchRateLimit,
  } = useGetOrgGitHubRateLimit(orgId, connectionData?.connected ?? false);

  // Mutation hooks
  const createConnection = useCreateOrgGitHubConnection();
  const updateConnection = useUpdateOrgGitHubConnection();
  const deleteConnection = useDeleteOrgGitHubConnection();
  const testConnection = useTestOrgGitHubConnection();
  const rotateKey = useRotateOrgGitHubKey();
  const rotatePAT = useRotateOrgGitHubPAT();

  // Derived state
  const connected = connectionData?.connected ?? false;
  const connection = connectionData?.connection;

  // Days until PAT expiry
  const [daysUntilExpiry, setDaysUntilExpiry] = useState<number | null>(null);
  useEffect(() => {
    if (connection?.connectionType === 'service_account' && connection.patExpiresAt) {
      const expiresAt = new Date(connection.patExpiresAt);
      const days = Math.ceil((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      setDaysUntilExpiry(days);
    } else {
      setDaysUntilExpiry(null);
    }
  }, [connection?.connectionType, connection?.patExpiresAt]);

  // Modal states
  const [connectAppModalOpen, setConnectAppModalOpen] = useState(false);
  const [connectPatModalOpen, setConnectPatModalOpen] = useState(false);
  const [disconnectModalOpen, setDisconnectModalOpen] = useState(false);
  const [rotateKeyModalOpen, setRotateKeyModalOpen] = useState(false);
  const [rotatePatModalOpen, setRotatePatModalOpen] = useState(false);

  // Form states - GitHub App
  const [appId, setAppId] = useState('');
  const [installationId, setInstallationId] = useState('');
  const [privateKey, setPrivateKey] = useState('');

  // Form states - PAT
  const [accessToken, setAccessToken] = useState('');
  const [patExpiresAt, setPatExpiresAt] = useState('');

  // Rotation form states
  const [newPrivateKey, setNewPrivateKey] = useState('');
  const [newAccessToken, setNewAccessToken] = useState('');
  const [newPatExpiresAt, setNewPatExpiresAt] = useState('');

  // Allowed repositories state
  const [allowedRepos, setAllowedRepos] = useState<string[]>([]);
  const [editingRepos, setEditingRepos] = useState(false);
  const [repoSearchQuery, setRepoSearchQuery] = useState('');

  // Fetch accessible repositories for checklist (only when editing)
  const {
    data: reposData,
    isLoading: loadingRepos,
    error: reposError,
  } = useOrgGitHubRepositories(orgId, connected && editingRepos);

  // Test result state
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);

  // Sync allowed repos from connection. connection?.id is in the deps so the list
  // resets when the connection itself changes.
  useEffect(() => {
    if (connection?.allowedRepositories) {
      setAllowedRepos(connection.allowedRepositories);
    } else {
      setAllowedRepos([]);
    }
  }, [connection?.id, connection?.allowedRepositories]);

  // Clear form states when modals close
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

  useEffect(() => {
    if (!rotatePatModalOpen) {
      setNewAccessToken('');
      setNewPatExpiresAt('');
    }
  }, [rotatePatModalOpen]);

  const handleConnectGitHubApp = async () => {
    if (!appId || !installationId || !privateKey) return;

    createConnection.mutate(
      {
        orgId,
        data: {
          connectionType: 'github_app',
          appId,
          installationId,
          privateKey,
          allowedRepositories: allowedRepos.length > 0 ? allowedRepos : undefined,
        },
      },
      {
        onSuccess: () => {
          setConnectAppModalOpen(false);
          setAllowedRepos([]);
        },
      }
    );
  };

  const handleConnectPat = async () => {
    if (!accessToken) return;

    createConnection.mutate(
      {
        orgId,
        data: {
          connectionType: 'service_account',
          accessToken,
          patExpiresAt: patExpiresAt ? new Date(patExpiresAt).toISOString() : undefined,
          allowedRepositories: allowedRepos.length > 0 ? allowedRepos : undefined,
        },
      },
      {
        onSuccess: () => {
          setConnectPatModalOpen(false);
          setAllowedRepos([]);
        },
      }
    );
  };

  const handleDisconnect = async () => {
    // Clear test result immediately when starting disconnect
    setTestResult(null);
    deleteConnection.mutate(orgId, {
      onSuccess: () => {
        setDisconnectModalOpen(false);
      },
    });
  };

  const handleRotateKey = async () => {
    if (!newPrivateKey) return;

    rotateKey.mutate(
      { orgId, data: { privateKey: newPrivateKey } },
      {
        onSuccess: () => {
          setRotateKeyModalOpen(false);
        },
      }
    );
  };

  const handleRotatePAT = async () => {
    if (!newAccessToken) return;

    rotatePAT.mutate(
      {
        orgId,
        data: {
          accessToken: newAccessToken,
          patExpiresAt: newPatExpiresAt ? new Date(newPatExpiresAt).toISOString() : undefined,
        },
      },
      {
        onSuccess: () => {
          setRotatePatModalOpen(false);
        },
      }
    );
  };

  const handleTestConnection = async () => {
    setTestResult(null);
    testConnection.mutate(orgId, {
      onSuccess: data => {
        setTestResult(data as TestConnectionResult);
      },
      onError: error => {
        setTestResult({
          success: false,
          error: sanitizeErrorMessage(error instanceof Error ? error.message : 'Connection test failed'),
          latencyMs: 0,
        });
      },
    });
  };

  const handleSaveRepos = () => {
    updateConnection.mutate(
      { orgId, data: { allowedRepositories: allowedRepos } },
      {
        onSuccess: () => {
          setEditingRepos(false);
          setRepoSearchQuery('');
        },
      }
    );
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

  if (isLoading) {
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
          <Typography level="h3">GitHub API</Typography>
          <ContextHelpButton helpId="organizations/github-connection" tooltipText="GitHub Connection Help" />
          <Chip
            size="sm"
            variant="soft"
            color={connected ? 'success' : 'neutral'}
            data-testid="org-github-connection-status-chip"
          >
            {connected ? 'Connected' : 'Not Connected'}
          </Chip>
        </Stack>
        <Button
          variant="outlined"
          color="neutral"
          startDecorator={<Refresh />}
          onClick={() => {
            refetch();
            if (connected) refetchRateLimit();
          }}
          size="sm"
          data-testid="org-github-connection-refresh-btn"
        >
          Refresh
        </Button>
      </Stack>

      {/* Description */}
      <Typography level="body-sm" sx={{ mb: 3, color: 'text.secondary' }}>
        Configure your organization&apos;s GitHub API connection for features like PR summaries, code context retrieval,
        and repository integration. Team members with access to this organization will benefit from this connection.
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
            Connect a GitHub App (recommended) or Service Account PAT to enable GitHub features for your organization.
          </Typography>
          <Stack direction="row" spacing={2} justifyContent="center">
            <Button
              variant="solid"
              color="primary"
              startDecorator={<GitHubIcon />}
              onClick={() => setConnectAppModalOpen(true)}
              data-testid="org-github-connect-app-btn"
            >
              Connect GitHub App (Recommended)
            </Button>
            <Button
              variant="outlined"
              color="neutral"
              startDecorator={<VpnKey />}
              onClick={() => setConnectPatModalOpen(true)}
              data-testid="org-github-connect-pat-btn"
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
                      data-testid="org-github-health-status-chip"
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
              {connection.connectionType === 'service_account' && daysUntilExpiry !== null && daysUntilExpiry <= 7 && (
                <Alert
                  color={daysUntilExpiry <= 3 ? 'danger' : 'warning'}
                  variant="outlined"
                  startDecorator={<Schedule />}
                  data-testid="org-github-pat-expiry-warning"
                >
                  <Typography level="body-sm">
                    {daysUntilExpiry <= 0
                      ? 'PAT has expired! Please update with a new token.'
                      : `PAT expires in ${daysUntilExpiry} day${daysUntilExpiry !== 1 ? 's' : ''}. Consider rotating soon.`}
                  </Typography>
                </Alert>
              )}

              {/* Suspension Alert */}
              {connection.suspendedAt && (
                <Alert
                  color="danger"
                  variant="outlined"
                  startDecorator={<LinkOff />}
                  data-testid="org-github-suspended-alert"
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
                  data-testid="org-github-last-error-alert"
                >
                  <Typography level="body-sm">{sanitizeErrorMessage(connection.health.lastError)}</Typography>
                </Alert>
              )}
            </Stack>
          </Card>

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
                    data-testid="org-github-edit-repos-btn"
                  >
                    Edit
                  </Button>
                )}
              </Stack>

              <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                Restrict GitHub API access to specific repositories. Leave empty to allow access to all repositories the
                connection has permissions for.
              </Typography>

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
                        data-testid="org-github-repo-search-input"
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
                                data-testid="org-github-select-all"
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
                                        data-testid={`org-github-repo-checkbox-${repo.id}`}
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
                      data-testid="org-github-cancel-repos-btn"
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={handleSaveRepos}
                      loading={updateConnection.isPending}
                      data-testid="org-github-save-repos-btn"
                    >
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
                  All accessible repositories (no restrictions)
                </Typography>
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
                  loading={testConnection.isPending}
                  data-testid="org-github-test-connection-btn"
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
                  data-testid="org-github-test-result-alert"
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
                        {' - '}
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
                  onClick={() => refetchRateLimit()}
                  disabled={loadingRateLimit}
                  data-testid="org-github-rate-limit-refresh-btn"
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
                      data-testid="org-github-rate-limit-progress"
                    />
                  </Box>
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    Resets at {formatDate(rateLimit.resetAt)}
                  </Typography>
                  {rateLimit.isNearLimit && (
                    <Alert color="warning" variant="soft" size="sm" data-testid="org-github-rate-limit-warning">
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
                    data-testid="org-github-rotate-key-btn"
                  >
                    Rotate Private Key
                  </Button>
                )}
                {connection.connectionType === 'service_account' && (
                  <Button
                    variant="outlined"
                    color="warning"
                    startDecorator={<VpnKey />}
                    onClick={() => setRotatePatModalOpen(true)}
                    data-testid="org-github-rotate-pat-btn"
                  >
                    Rotate PAT
                  </Button>
                )}
                <Button
                  variant="outlined"
                  color="danger"
                  startDecorator={<Delete />}
                  onClick={() => setDisconnectModalOpen(true)}
                  data-testid="org-github-disconnect-btn"
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
          if (!createConnection.isPending) {
            setConnectAppModalOpen(false);
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

              <Alert color="success" variant="soft" size="sm">
                <Typography level="body-xs">
                  <strong>Recommended:</strong> GitHub Apps have higher rate limits, better security, and do not depend
                  on a user account.
                </Typography>
              </Alert>

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
                  disabled={createConnection.isPending}
                  slotProps={{ input: { 'data-testid': 'org-github-app-id-input' } }}
                />
              </FormControl>

              <FormControl required>
                <FormLabel>Installation ID</FormLabel>
                <Input
                  placeholder="12345678"
                  value={installationId}
                  onChange={e => setInstallationId(e.target.value)}
                  disabled={createConnection.isPending}
                  slotProps={{ input: { 'data-testid': 'org-github-installation-id-input' } }}
                />
                <Typography level="body-xs" sx={{ mt: 0.5, color: 'text.secondary' }}>
                  Found in Settings - Installations - Configure - URL contains installation ID
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
                  disabled={createConnection.isPending}
                  minRows={6}
                  maxRows={8}
                  slotProps={{
                    textarea: {
                      'data-testid': 'org-github-private-key-input',
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
              onClick={() => setConnectAppModalOpen(false)}
              disabled={createConnection.isPending}
              data-testid="org-github-connect-app-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              color="primary"
              onClick={handleConnectGitHubApp}
              loading={createConnection.isPending}
              disabled={!appId || !installationId || !privateKey}
              data-testid="org-github-connect-app-confirm-btn"
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
          if (!createConnection.isPending) {
            setConnectPatModalOpen(false);
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

              <Alert color="warning" variant="soft" size="sm">
                <Typography level="body-xs">
                  PATs are tied to a user account and have lower rate limits than GitHub Apps. Consider using a GitHub
                  App for production use.
                </Typography>
              </Alert>

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
                  disabled={createConnection.isPending}
                  slotProps={{
                    input: {
                      'data-testid': 'org-github-pat-input',
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
                  disabled={createConnection.isPending}
                  slotProps={{ input: { 'data-testid': 'org-github-pat-expiry-input' } }}
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
              onClick={() => setConnectPatModalOpen(false)}
              disabled={createConnection.isPending}
              data-testid="org-github-connect-pat-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              color="primary"
              onClick={handleConnectPat}
              loading={createConnection.isPending}
              disabled={!accessToken}
              data-testid="org-github-connect-pat-confirm-btn"
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
          if (!deleteConnection.isPending) setDisconnectModalOpen(false);
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
              GitHub features (PR summaries, code context, etc.) will no longer work for this organization until a new
              connection is configured.
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button
              variant="plain"
              color="neutral"
              onClick={() => setDisconnectModalOpen(false)}
              disabled={deleteConnection.isPending}
              data-testid="org-github-disconnect-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              color="danger"
              onClick={handleDisconnect}
              loading={deleteConnection.isPending}
              data-testid="org-github-disconnect-confirm-btn"
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
          if (!rotateKey.isPending) {
            setRotateKeyModalOpen(false);
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
                  disabled={rotateKey.isPending}
                  minRows={6}
                  maxRows={8}
                  slotProps={{
                    textarea: {
                      'data-testid': 'org-github-new-private-key-input',
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
              onClick={() => setRotateKeyModalOpen(false)}
              disabled={rotateKey.isPending}
              data-testid="org-github-rotate-key-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              color="warning"
              onClick={handleRotateKey}
              loading={rotateKey.isPending}
              disabled={!newPrivateKey}
              data-testid="org-github-rotate-key-confirm-btn"
            >
              Rotate Key
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>

      {/* Rotate PAT Modal */}
      <Modal
        open={rotatePatModalOpen}
        onClose={() => {
          if (!rotatePAT.isPending) {
            setRotatePatModalOpen(false);
          }
        }}
      >
        <ModalDialog variant="outlined" sx={{ minWidth: 450 }}>
          <DialogTitle>
            <VpnKey sx={{ color: 'warning.500', mr: 1 }} />
            Rotate Personal Access Token
          </DialogTitle>
          <DialogContent>
            <Stack spacing={2}>
              <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                Enter a new Personal Access Token to replace the current one. The old token will be invalidated
                immediately.
              </Typography>

              <Alert color="warning" variant="soft" size="sm">
                <Typography level="body-xs">
                  Generate a new Fine-grained PAT in GitHub settings before rotating. The old token should be revoked in
                  GitHub after rotation.
                </Typography>
              </Alert>

              <FormControl required>
                <FormLabel>New Access Token</FormLabel>
                <Input
                  type="password"
                  placeholder="github_pat_..."
                  value={newAccessToken}
                  onChange={e => setNewAccessToken(e.target.value)}
                  disabled={rotatePAT.isPending}
                  slotProps={{
                    input: {
                      'data-testid': 'org-github-new-pat-input',
                      autoComplete: 'off',
                    },
                  }}
                />
              </FormControl>

              <FormControl>
                <FormLabel>New Expiration Date (Optional)</FormLabel>
                <Input
                  type="date"
                  value={newPatExpiresAt}
                  onChange={e => setNewPatExpiresAt(e.target.value)}
                  disabled={rotatePAT.isPending}
                  slotProps={{ input: { 'data-testid': 'org-github-new-pat-expiry-input' } }}
                />
              </FormControl>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              variant="plain"
              color="neutral"
              onClick={() => setRotatePatModalOpen(false)}
              disabled={rotatePAT.isPending}
              data-testid="org-github-rotate-pat-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              color="warning"
              onClick={handleRotatePAT}
              loading={rotatePAT.isPending}
              disabled={!newAccessToken}
              data-testid="org-github-rotate-pat-confirm-btn"
            >
              Rotate Token
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </Box>
  );
};

export default OrgGitHubConnectionTab;
