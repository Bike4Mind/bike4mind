import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Typography,
  Button,
  Box,
  Chip,
  Stack,
  Modal,
  ModalDialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Checkbox,
  Input,
} from '@mui/joy';
import { CheckCircle, GitHub as GitHubIcon, Warning, Search, CallSplit } from '@mui/icons-material';
import { toast } from 'sonner';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { gray } from '../../../utils/themes/colors';
import SectionContainer from '../SectionContainer';
import { mcpServerKeys } from '@client/app/hooks/data/mcpServers';
import { useUser } from '@client/app/contexts/UserContext';
import GitHubNotificationsSection from './GitHubNotificationsSection';
import { api } from '@client/app/contexts/ApiContext';

interface GitHubIntegrationProps {
  userId: string;
}

interface GitHubStatus {
  connected: boolean;
  githubLogin?: string;
  connectedAt?: string;
}

interface GitHubRepository {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  fork: boolean;
  description: string | null;
  url: string;
  updatedAt: string;
  permissions: {
    admin: boolean;
    push: boolean;
    pull: boolean;
  };
}

const GitHubIntegrationSection = ({ userId }: GitHubIntegrationProps) => {
  const { currentUser } = useUser();
  const isSlackLinked = Boolean(currentUser?.slackSettings?.slackUserId);
  const [status, setStatus] = useState<GitHubStatus>({ connected: false });
  const [connecting, setConnecting] = useState(false);
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [savingSelection, setSavingSelection] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const toastShownRef = useRef(false);
  const sectionRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const checkGitHubConnection = useCallback(async () => {
    try {
      const { data } = await api.post('/api/mcp/github/status');
      setStatus({
        connected: data.connected,
        githubLogin: data.githubLogin,
        connectedAt: data.connectedAt,
      });
    } catch (err) {
      console.error('Failed to check GitHub connection', err);
      setStatus({ connected: false });
    }
  }, []);

  const fetchRepositories = useCallback(async () => {
    if (!status.connected) return;

    try {
      setLoadingRepos(true);
      const { data } = await api.post('/api/mcp/github/repositories');
      setRepositories(data.repositories || []);
      setSelectedRepos(data.selectedRepositories || []);
    } catch (err) {
      console.error('Failed to fetch repositories', err);
      setRepositories([]);
    } finally {
      setLoadingRepos(false);
    }
  }, [status.connected]);

  useEffect(() => {
    checkGitHubConnection();
  }, [checkGitHubConnection]);

  useEffect(() => {
    if (status.connected) {
      fetchRepositories();
    }
  }, [status.connected, fetchRepositories]);

  // Handle OAuth callback via query parameters
  useEffect(() => {
    // Prevent showing toast multiple times if component remounts
    if (toastShownRef.current) return;

    const params = new URLSearchParams(window.location.search);
    const githubOauth = params.get('github_oauth');
    const error = params.get('error');

    if (githubOauth === 'success') {
      toastShownRef.current = true;
      toast.success('GitHub successfully connected!');
      checkGitHubConnection();

      // Invalidate MCP servers cache to show GitHub in the list immediately
      queryClient.invalidateQueries({ queryKey: mcpServerKeys.list() });

      setTimeout(() => {
        sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 300);

      // Clean up URL using Tanstack Router
      const currentParams = new URLSearchParams(window.location.search);
      currentParams.delete('github_oauth');
      currentParams.delete('error');
      const cleanedSearch: Record<string, string> = {};
      currentParams.forEach((value, key) => {
        cleanedSearch[key] = value;
      });

      navigate({
        search: cleanedSearch as any,
        replace: true,
      });
    } else if (githubOauth === 'error' && error) {
      toastShownRef.current = true;
      const errorMessages: Record<string, string> = {
        missing_code: 'Authorization code missing',
        missing_state: 'State parameter missing',
        invalid_state: 'Invalid or expired authorization',
        user_not_found: 'User account not found',
        oauth_not_configured: 'GitHub OAuth not configured. Contact administrator.',
        no_token: 'No access token received from GitHub',
        callback_failed: 'Authorization failed. Please try again.',
        auth_code_reused: 'GitHub already connected. Please refresh the page.',
        bad_verification_code: 'Authorization expired. Please try connecting again.',
      };
      toast.error(errorMessages[error] || 'An unknown error occurred');

      setTimeout(() => {
        sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 300);

      // Clean up URL using Tanstack Router
      const currentParams = new URLSearchParams(window.location.search);
      currentParams.delete('github_oauth');
      currentParams.delete('error');
      const cleanedSearch: Record<string, string> = {};
      currentParams.forEach((value, key) => {
        cleanedSearch[key] = value;
      });

      navigate({
        search: cleanedSearch as any,
        replace: true,
      });
    }
  }, [checkGitHubConnection, navigate]);

  const handleConnect = async () => {
    try {
      setConnecting(true);

      const { data } = await api.post('/api/auth/github/authorize');

      window.location.href = data.authUrl;
    } catch (err) {
      console.error('Failed to connect GitHub', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to connect to GitHub. Please try again.';
      toast.error(errorMessage);
      setConnecting(false);
    }
  };

  const handleSaveSelection = async () => {
    try {
      setSavingSelection(true);
      await api.patch('/api/mcp/github/repositories', {
        selectedRepositories: selectedRepos,
      });
      toast.success('Repository selection saved!');
    } catch (err) {
      console.error('Failed to save selection', err);
      toast.error('Failed to save selection');
    } finally {
      setSavingSelection(false);
    }
  };

  const handleDisconnect = async () => {
    setShowDisconnectModal(false);

    try {
      setConnecting(true);

      await api.post('/api/auth/github/disconnect');

      toast.success('GitHub disconnected successfully');

      // Invalidate MCP servers cache to remove GitHub from UI immediately
      queryClient.invalidateQueries({ queryKey: mcpServerKeys.list() });
      queryClient.invalidateQueries({ queryKey: ['github-connection-status', userId] });

      setStatus({ connected: false });
      setRepositories([]);
      setSelectedRepos([]);
    } catch (err) {
      console.error('Failed to disconnect GitHub', err);
      toast.error('Failed to disconnect GitHub. Please try again.');
    } finally {
      setConnecting(false);
    }
  };

  const filteredRepositories = repositories.filter(repo => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    return (
      repo.fullName.toLowerCase().includes(query) ||
      repo.name.toLowerCase().includes(query) ||
      repo.owner.toLowerCase().includes(query) ||
      (repo.description && repo.description.toLowerCase().includes(query))
    );
  });

  // Computed states for bulk selection
  const allVisibleSelected =
    filteredRepositories.length > 0 && filteredRepositories.every(repo => selectedRepos.includes(repo.fullName));
  const someVisibleSelected =
    filteredRepositories.some(repo => selectedRepos.includes(repo.fullName)) && !allVisibleSelected;

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      // Add all visible repos to selection (preserve already selected hidden repos)
      const visibleFullNames = filteredRepositories.map(r => r.fullName);
      const newSelection = [...new Set([...selectedRepos, ...visibleFullNames])];
      setSelectedRepos(newSelection);
    } else {
      // Remove only visible repos from selection (preserve selected hidden repos)
      const visibleFullNames = new Set(filteredRepositories.map(r => r.fullName));
      setSelectedRepos(selectedRepos.filter(r => !visibleFullNames.has(r)));
    }
  };

  return (
    <Box ref={sectionRef} id="github-integration" sx={{ scrollMarginTop: '20px' }}>
      <SectionContainer
        helpId="features/github-slack-notifications"
        helpTooltip="Learn about GitHub Notifications"
        title={
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <GitHubIcon />
            <Typography level="h4">GitHub Integration</Typography>
          </Box>
        }
        subtitle="Connect your GitHub account to create issues, pull requests, and search code directly from Slack using natural language commands."
        action={
          status.connected && (
            <Chip color="success" size="sm" startDecorator={<CheckCircle />}>
              Connected
            </Chip>
          )
        }
      >
        <Stack spacing={2}>
          {/* Connected State */}
          {status.connected && (
            <Box
              sx={theme => ({
                backgroundColor: theme.palette.mode === 'light' ? '#F7F9FB' : gray[850],
                p: 2,
                borderRadius: 'sm',
              })}
            >
              <Stack spacing={1}>
                <Typography level="body-sm" fontWeight="bold">
                  Connected Account
                </Typography>
                <Typography level="body-sm">
                  GitHub: <strong>@{status.githubLogin || 'Connected'}</strong>
                </Typography>
                {status.connectedAt && (
                  <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                    Connected on {new Date(status.connectedAt).toLocaleDateString()}
                  </Typography>
                )}
              </Stack>
            </Box>
          )}

          {/* Repository Selection */}
          {status.connected && (loadingRepos || repositories.length > 0) && (
            <Box
              sx={theme => ({
                backgroundColor: theme.palette.mode === 'light' ? '#F7F9FB' : gray[850],
                p: 2,
                borderRadius: 'sm',
              })}
            >
              <Stack spacing={2}>
                <Box>
                  <Typography level="body-sm" fontWeight="bold" sx={{ mb: 0.5 }}>
                    Select Repositories for Integration
                  </Typography>
                  <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                    Choose which repositories can be used to create issues from Slack
                  </Typography>
                </Box>

                {loadingRepos ? (
                  <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                    Loading repositories...
                  </Typography>
                ) : (
                  <>
                    {/* Search Input */}
                    <Input
                      placeholder="Search repositories..."
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      startDecorator={<Search />}
                      size="sm"
                      data-testid="repo-search-input"
                    />

                    {/* Bulk selection controls */}
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Checkbox
                          checked={allVisibleSelected}
                          indeterminate={someVisibleSelected}
                          onChange={e => handleSelectAll(e.target.checked)}
                          disabled={filteredRepositories.length === 0}
                          data-testid="repo-select-all-checkbox"
                          slotProps={{ input: { 'aria-label': 'Select all visible repositories' } }}
                        />
                        <Typography level="body-sm">{allVisibleSelected ? 'Deselect All' : 'Select All'}</Typography>
                      </Box>
                      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                        {selectedRepos.length} of {repositories.length} selected
                      </Typography>
                    </Box>

                    <Box
                      sx={{
                        maxHeight: '300px',
                        overflowY: 'auto',
                      }}
                    >
                      <Stack spacing={1}>
                        {filteredRepositories.length === 0 && searchQuery.trim() ? (
                          <Typography level="body-sm" sx={{ color: 'text.tertiary', textAlign: 'center', py: 2 }}>
                            No repositories found matching &quot;{searchQuery}&quot;
                          </Typography>
                        ) : (
                          filteredRepositories.map(repo => (
                            <Box
                              key={repo.id}
                              sx={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 1.5,
                                p: 1,
                                borderRadius: 'sm',
                                '&:hover': {
                                  bgcolor: 'background.level2',
                                },
                              }}
                            >
                              <Checkbox
                                checked={selectedRepos.includes(repo.fullName)}
                                onChange={e => {
                                  if (e.target.checked) {
                                    setSelectedRepos([...selectedRepos, repo.fullName]);
                                  } else {
                                    setSelectedRepos(selectedRepos.filter(r => r !== repo.fullName));
                                  }
                                }}
                                data-testid={`repo-checkbox-${repo.fullName}`}
                              />
                              <Box sx={{ flex: 1 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                  <Typography level="body-sm">{repo.fullName}</Typography>
                                  {repo.fork && (
                                    <Chip
                                      size="sm"
                                      variant="soft"
                                      color="neutral"
                                      startDecorator={<CallSplit sx={{ fontSize: 14 }} />}
                                      data-testid={`repo-fork-chip-${repo.fullName}`}
                                    >
                                      Fork
                                    </Chip>
                                  )}
                                  {repo.private && (
                                    <Chip size="sm" variant="soft" color="warning">
                                      Private
                                    </Chip>
                                  )}
                                </Box>
                                {repo.description && (
                                  <Typography level="body-xs" sx={{ color: 'text.tertiary', mt: 0.5 }}>
                                    {repo.description}
                                  </Typography>
                                )}
                              </Box>
                            </Box>
                          ))
                        )}
                      </Stack>
                    </Box>

                    <Button
                      onClick={handleSaveSelection}
                      loading={savingSelection}
                      size="sm"
                      sx={{ alignSelf: 'flex-start' }}
                    >
                      Save Selection ({selectedRepos.length} {selectedRepos.length === 1 ? 'repo' : 'repos'})
                    </Button>
                  </>
                )}
              </Stack>
            </Box>
          )}

          {/* Not Connected State */}
          {!status.connected && (
            <Box sx={{ bgcolor: 'background.level1', p: 2, borderRadius: 'sm' }}>
              <Stack spacing={1.5}>
                <Typography level="body-sm" fontWeight="bold">
                  How it works:
                </Typography>
                <Stack spacing={0.5}>
                  <Typography level="body-xs" startDecorator="1.">
                    Click &quot;Connect with GitHub&quot; below
                  </Typography>
                  <Typography level="body-xs" startDecorator="2.">
                    Authorize B4M to access your repositories
                  </Typography>
                  <Typography level="body-xs" startDecorator="3.">
                    Use GitHub commands in Slack (e.g., &quot;@dev create issue&quot;)
                  </Typography>
                </Stack>
                <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                  ✓ Secure OAuth authentication
                  <br />
                  ✓ You control which repos to share
                  <br />✓ Revoke access anytime from GitHub settings
                </Typography>
              </Stack>
            </Box>
          )}

          {/* Actions */}
          <Box sx={{ display: 'flex', gap: 1 }}>
            {!status.connected ? (
              <Button
                color="primary"
                onClick={handleConnect}
                loading={connecting}
                startDecorator={<GitHubIcon />}
                fullWidth
              >
                Connect with GitHub
              </Button>
            ) : (
              <>
                <Button
                  variant="outlined"
                  color="neutral"
                  onClick={() => window.open('https://github.com/settings/connections/applications', '_blank')}
                  size="sm"
                >
                  Manage on GitHub
                </Button>
                <Button
                  variant="outlined"
                  color="danger"
                  onClick={() => setShowDisconnectModal(true)}
                  loading={connecting}
                  size="sm"
                >
                  Disconnect
                </Button>
              </>
            )}
          </Box>
          {/* GitHub Notifications - show when connected */}
          {status.connected && (
            <GitHubNotificationsSection githubLogin={status.githubLogin} isSlackLinked={isSlackLinked} />
          )}
        </Stack>
      </SectionContainer>

      {/* Disconnect Confirmation Modal */}
      <Modal open={showDisconnectModal} onClose={() => setShowDisconnectModal(false)}>
        <ModalDialog variant="outlined" role="alertdialog">
          <DialogTitle>
            <Warning color="warning" sx={{ mr: 1 }} />
            Disconnect GitHub?
          </DialogTitle>
          <DialogContent>
            Are you sure you want to disconnect GitHub? You will lose access to GitHub tools in Slack.
          </DialogContent>
          <DialogActions>
            <Button variant="outlined" color="neutral" onClick={() => setShowDisconnectModal(false)}>
              Cancel
            </Button>
            <Button variant="solid" color="danger" onClick={handleDisconnect} loading={connecting}>
              Disconnect
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </Box>
  );
};

export default GitHubIntegrationSection;
