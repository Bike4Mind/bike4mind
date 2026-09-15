import React, { useState, useEffect } from 'react';
import {
  Typography,
  Button,
  Input,
  Stack,
  FormControl,
  FormLabel,
  Alert,
  Box,
  Grid,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  AccordionGroup,
  CircularProgress,
  Chip,
  Card,
  IconButton,
  Modal,
  ModalDialog,
  ModalClose,
  Select,
  Option,
  FormHelperText,
} from '@mui/joy';
import { FieldTooltip } from '@client/app/components/help';
import LinkIcon from '@mui/icons-material/Link';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import Image from 'next/image';
import SquareSlideToggle from '../../SquareSlideToggle';
import { useUser } from '@client/app/contexts/UserContext';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import SectionContainer from '../SectionContainer';
import { useGetJoinedProjects } from '@client/app/hooks/data/projects';
import { IUser, IKeywordRoutingRule } from '@bike4mind/common';
type SlackSettings = NonNullable<IUser['slackSettings']>;
type KeywordRoutingRule = IKeywordRoutingRule;

const AGENTS = [
  { key: 'dev', label: '@dev', emoji: '💻', description: 'Developer' },
  { key: 'pm', label: '@pm', emoji: '📋', description: 'Project Manager' },
  { key: 'analyst', label: '@analyst', emoji: '📊', description: 'Business Analyst' },
  { key: 'researcher', label: '@researcher', emoji: '🔍', description: 'Research Assistant' },
  { key: 'agent', label: '@agent', emoji: '🤖', description: 'General Agent' },
] as const;

const SlackIntegrationSection = () => {
  const { currentUser } = useUser();
  const queryClient = useQueryClient();

  const [slackUserId, setSlackUserId] = useState(currentUser?.slackSettings?.slackUserId || '');
  const [defaultNotebookId, setDefaultNotebookId] = useState(currentUser?.slackSettings?.defaultNotebookId || '');
  const [autoCreateNotebook, setAutoCreateNotebook] = useState(
    currentUser?.slackSettings?.autoCreateNotebook !== false
  );
  const [notebookNamePrefix, setNotebookNamePrefix] = useState(
    currentUser?.slackSettings?.notebookNamePrefix || 'Slack Chat'
  );
  const [defaultProjectId, setDefaultProjectId] = useState(currentUser?.slackSettings?.defaultProjectId || '');
  const [isLinking, setIsLinking] = useState(false);
  // Track server-saved Slack ID separately from input field value
  // This allows immediate UI updates on unlink while not showing "linked" when typing
  const [savedSlackUserId, setSavedSlackUserId] = useState(currentUser?.slackSettings?.slackUserId || '');

  // Agent notebook routing state
  const [agentNotebookRouting, setAgentNotebookRouting] = useState<Record<string, string | undefined>>(
    currentUser?.slackSettings?.agentNotebookRouting || {}
  );

  // Keyword routing state
  const [keywordRouting, setKeywordRouting] = useState<KeywordRoutingRule[]>(
    currentUser?.slackSettings?.keywordRouting || []
  );
  const [isRuleModalOpen, setIsRuleModalOpen] = useState(false);
  const [editingRuleIndex, setEditingRuleIndex] = useState<number | null>(null);
  const [ruleKeywords, setRuleKeywords] = useState('');
  const [ruleNotebookId, setRuleNotebookId] = useState('');

  // Custom agent state
  const [customAgentId, setCustomAgentId] = useState(
    (currentUser?.slackSettings as SlackSettings | undefined)?.customAgentId || ''
  );

  // Fetch user's projects for dropdown
  const { data: projectsData } = useGetJoinedProjects(currentUser?.id || '');

  // Fetch user's custom agents for @agent selector
  const { data: agentsData } = useQuery({
    queryKey: ['user-agents-for-slack', currentUser?.id],
    queryFn: async () => {
      const response = await api.get(`/api/users/${currentUser?.id}/agents`);
      return response.data as { agents: Array<{ id: string; name: string; description: string }> };
    },
    enabled: Boolean(currentUser?.id),
  });

  const customAgents = agentsData?.agents || [];

  // Sync state when currentUser updates (e.g., after OAuth linking)
  useEffect(() => {
    if (currentUser?.slackSettings) {
      const slackSettings = currentUser.slackSettings as SlackSettings;
      setSlackUserId(slackSettings.slackUserId || '');
      setSavedSlackUserId(slackSettings.slackUserId || '');
      setDefaultNotebookId(slackSettings.defaultNotebookId || '');
      setAutoCreateNotebook(slackSettings.autoCreateNotebook !== false);
      setNotebookNamePrefix(slackSettings.notebookNamePrefix || 'Slack Chat');
      setDefaultProjectId(slackSettings.defaultProjectId || '');
      setAgentNotebookRouting(slackSettings.agentNotebookRouting || {});
      setKeywordRouting(slackSettings.keywordRouting || []);
      setCustomAgentId(slackSettings.customAgentId || '');
    }
  }, [currentUser?.slackSettings]);

  // Fetch user's notebooks for keyword routing dropdown
  const { data: notebooksData } = useQuery({
    queryKey: ['user-notebooks-for-routing'],
    queryFn: async () => {
      const response = await api.get('/api/sessions', { params: { limit: 100 } });
      return response.data as { data: Array<{ id: string; name: string }>; hasMore: boolean };
    },
    enabled: Boolean(currentUser?.id),
  });

  const notebooks = notebooksData?.data || [];

  // Check if OAuth is configured (any workspace with OAuth credentials)
  const { data: workspacesData, isLoading: isLoadingWorkspaces } = useQuery({
    queryKey: ['slack-oauth-workspaces'],
    queryFn: async () => {
      const response = await api.get('/api/slack/oauth/workspaces');
      return response.data as { workspaces: { id: string; name: string }[] };
    },
  });

  const hasOAuthConfigured = (workspacesData?.workspaces?.length ?? 0) > 0;

  // Handle OAuth result from URL params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('slack_linked') === 'true') {
      toast.success('Slack account linked successfully!');
      queryClient.invalidateQueries({ queryKey: ['user'] });
      // Clean URL but preserve tab param
      params.delete('slack_linked');
      const newSearch = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${newSearch ? `?${newSearch}` : ''}`);
    }
    if (params.get('slack_error')) {
      const errorMessages: Record<string, string> = {
        invalid_state: 'Security validation failed. Please try again.',
        session_expired: 'Session expired. Please try again.',
        already_linked: 'This Slack account is already linked to another user.',
        access_denied: 'You denied access to your Slack account.',
        token_exchange_failed: 'Failed to connect to Slack. Please try again.',
        workspace_not_found: 'Workspace not found or not configured.',
        workspace_not_connected:
          'Your Slack workspace is not connected to this app. Please contact your administrator.',
        no_oauth_configured: 'No Slack workspace has OAuth configured. Please contact your administrator.',
        auth_required: 'Please log in first.',
        no_user_id: 'Could not retrieve your Slack ID. Please try again.',
        server_error: 'Server error occurred. Please try again.',
        init_failed: 'Failed to start Slack connection. Please try again.',
      };
      const error = params.get('slack_error') || 'unknown';
      toast.error(errorMessages[error] || `Slack error: ${error}`);
      // Clean URL but preserve tab param
      params.delete('slack_error');
      const newSearch = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${newSearch ? `?${newSearch}` : ''}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount - OAuth redirect causes full page reload

  // Handle OAuth connect - get OAuth URL via API (sends JWT), then redirect
  const handleConnectSlack = async () => {
    setIsLinking(true);
    try {
      const response = await api.get('/api/slack/oauth/user-link/initiate');
      window.location.href = response.data.redirectUrl;
    } catch (error: any) {
      console.error('Failed to initiate Slack OAuth:', error);
      toast.error(error.response?.data?.error || 'Failed to connect to Slack. Please try again.');
      setIsLinking(false);
    }
  };

  const updateSlackSettings = useMutation({
    mutationFn: async (settings: SlackSettings) => {
      const response = await api.patch(`/api/users/${currentUser?.id}/slack-settings`, settings);
      return response.data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['user'] });
      // Update savedSlackUserId to reflect the saved value (for manual entry)
      if (variables.slackUserId !== undefined) {
        setSavedSlackUserId(variables.slackUserId);
      }
      toast.success('Slack settings updated successfully!');
    },
    onError: (error: any) => {
      console.error('Failed to update Slack settings:', error);

      // Check if it's a duplicate Slack ID error (409 Conflict)
      if (error?.response?.status === 409) {
        toast.error(error.response.data.error || 'This Slack Member ID is already in use by another account.');
      } else {
        toast.error('Failed to update Slack settings');
      }
    },
  });

  const unlinkSlackAccount = useMutation({
    mutationFn: async () => {
      const response = await api.patch(`/api/users/${currentUser?.id}/slack-settings`, {
        slackUserId: undefined,
        defaultNotebookId: undefined,
        autoCreateNotebook: true,
        notebookNamePrefix: 'Slack Chat',
        agentNotebookRouting: {},
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user'] });
      setSlackUserId('');
      setSavedSlackUserId('');
      setDefaultNotebookId('');
      setAutoCreateNotebook(true);
      setNotebookNamePrefix('Slack Chat');
      toast.success('Slack account unlinked successfully!');
    },
    onError: error => {
      console.error('Failed to unlink Slack account:', error);
      toast.error('Failed to unlink Slack account');
    },
  });

  const handleSave = () => {
    const agentRoutingToSave = Object.fromEntries(
      Object.entries(agentNotebookRouting).filter(([_, value]) => value !== undefined && value !== '')
    );

    updateSlackSettings.mutate({
      slackUserId: slackUserId || undefined,
      defaultNotebookId: defaultNotebookId || undefined,
      autoCreateNotebook,
      notebookNamePrefix,
      defaultProjectId: defaultProjectId || undefined,
      agentNotebookRouting: agentRoutingToSave,
      keywordRouting: keywordRouting.length > 0 ? keywordRouting : undefined,
      customAgentId: customAgentId || undefined,
    });
  };

  const openAddRuleModal = () => {
    setEditingRuleIndex(null);
    setRuleKeywords('');
    setRuleNotebookId('');
    setIsRuleModalOpen(true);
  };

  const openEditRuleModal = (index: number) => {
    const rule = keywordRouting[index];
    setEditingRuleIndex(index);
    setRuleKeywords(rule.keywords.join(', '));
    setRuleNotebookId(rule.notebookId);
    setIsRuleModalOpen(true);
  };

  const closeRuleModal = () => {
    setIsRuleModalOpen(false);
    setEditingRuleIndex(null);
    setRuleKeywords('');
    setRuleNotebookId('');
  };

  const handleSaveKeywordRule = () => {
    if (ruleKeywords && ruleNotebookId) {
      const keywords = ruleKeywords
        .split(',')
        .map(k => k.trim().toLowerCase())
        .filter(k => k.length > 0);

      if (keywords.length > 0) {
        if (editingRuleIndex !== null) {
          // Edit existing rule
          setKeywordRouting(
            keywordRouting.map((rule, i) => (i === editingRuleIndex ? { keywords, notebookId: ruleNotebookId } : rule))
          );
        } else {
          // Add new rule
          setKeywordRouting([...keywordRouting, { keywords, notebookId: ruleNotebookId }]);
        }
        closeRuleModal();
      }
    }
  };

  const handleRemoveKeywordRule = (index: number) => {
    setKeywordRouting(keywordRouting.filter((_, i) => i !== index));
  };

  // Use savedSlackUserId for UI state - updated on save/unlink, not while typing
  const isLinked = Boolean(savedSlackUserId);

  return (
    <SectionContainer
      helpId="features/slack-multi-workspace-oauth"
      helpTooltip="Learn about Slack Integration"
      title={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Image src="/icons/Slack_Logo.svg" alt="Slack" width={32} height={32} style={{ marginTop: '2px' }} />
          <Typography level="h4" sx={{ fontSize: '16px' }}>
            Slack Integration
          </Typography>
        </Box>
      }
      subtitle={isLinked ? 'Account linked' : 'Connect your Slack account to send messages to notebooks'}
      action={
        <>
          {isLinked && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <span
                style={{
                  color: 'var(--joy-palette-text-primary)',
                  opacity: 0.5,
                  textDecoration: 'underline',
                  cursor: 'pointer',
                  fontSize: '13px',
                }}
                onClick={() => {
                  unlinkSlackAccount.mutate();
                }}
              >
                Unlink
              </span>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <FieldTooltip
                  ariaLabel="Help: Auto-create Notebooks"
                  content="Automatically create new notebooks when sending messages from Slack"
                  placement="bottom"
                />
                <Typography level="title-md" sx={{ fontSize: '13px', color: 'text.primary' }}>
                  Auto-create Notebooks
                </Typography>
                <SquareSlideToggle
                  checked={autoCreateNotebook}
                  onChange={e => setAutoCreateNotebook(e.target.checked)}
                />
              </Box>
            </Box>
          )}
        </>
      }
    >
      <Stack spacing={3}>
        {/* Loading state while checking OAuth availability */}
        {!isLinked && isLoadingWorkspaces && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CircularProgress size="sm" />
            <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
              Loading...
            </Typography>
          </Box>
        )}

        {/* OAuth Connect Section - Only show when not linked and OAuth is configured */}
        {!isLinked && !isLoadingWorkspaces && hasOAuthConfigured && (
          <Box>
            <Stack spacing={2}>
              <Typography level="body-sm" sx={{ color: 'text.tertiary', mb: 1 }}>
                Link your Slack account to chat with AI directly from any Slack channel or DM.
              </Typography>

              {/* Connect Button - Slack handles workspace selection */}
              <Button
                startDecorator={<LinkIcon />}
                onClick={handleConnectSlack}
                loading={isLinking}
                sx={{ alignSelf: 'flex-start' }}
              >
                Connect with Slack
              </Button>

              {/* Manual Entry Fallback - collapsed by default */}
              <AccordionGroup sx={{ mt: 1 }}>
                <Accordion defaultExpanded={false}>
                  <AccordionSummary indicator={<ExpandMoreIcon />}>
                    <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                      Having trouble? Enter Member ID manually
                    </Typography>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Stack spacing={2} sx={{ pt: 1 }}>
                      <FormControl>
                        <FormLabel sx={{ userSelect: 'text', color: 'text.primary', opacity: 0.5 }}>
                          Slack Member ID
                        </FormLabel>
                        <Input
                          placeholder="U0123456789"
                          value={slackUserId}
                          onChange={e => setSlackUserId(e.target.value)}
                          sx={{
                            maxWidth: 300,
                            backgroundColor: theme => theme.palette.loginRegister.inputFieldBg,
                            '& input': {
                              backgroundColor: 'transparent',
                              color: 'text.primary',
                              fontSize: '14px',
                              '&::placeholder': {
                                color: 'text.primary',
                                opacity: 0.5,
                                fontSize: '14px',
                              },
                            },
                          }}
                        />
                        <Typography level="body-xs" sx={{ mt: 0.5, color: 'primary.500' }}>
                          Slack Profile → Three dot button → Copy Member ID
                        </Typography>
                      </FormControl>
                      <Button
                        size="sm"
                        onClick={handleSave}
                        loading={updateSlackSettings.isPending}
                        disabled={!slackUserId}
                        sx={{ alignSelf: 'flex-start' }}
                      >
                        Save Member ID
                      </Button>
                    </Stack>
                  </AccordionDetails>
                </Accordion>
              </AccordionGroup>
            </Stack>
          </Box>
        )}

        {/* Fallback when no OAuth configured - show manual entry as primary */}
        {!isLinked && !isLoadingWorkspaces && !hasOAuthConfigured && (
          <Alert
            color="primary"
            variant="soft"
            sx={theme => ({
              backgroundColor: theme.palette.mode === 'light' ? '#F7F9FB' : undefined,
              alignSelf: 'flex-start',
              width: 'fit-content',
              p: 2,
            })}
          >
            <Box>
              <Typography level="body-sm" sx={{ color: 'text.primary', opacity: 0.5, mb: 1.5, fontWeight: 'bold' }}>
                Setup Instructions:
              </Typography>
              <Stack spacing={1}>
                <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                  1. Find your Slack Member ID in your Slack profile
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                  2. Enter it below to link your account
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                  3. Use <code>/notebook</code> commands in Slack to manage your notebooks
                </Typography>
              </Stack>
            </Box>
          </Alert>
        )}

        {/* Input Fields Row - Only show when linked OR no OAuth configured (after loading) */}
        {(isLinked || (!isLoadingWorkspaces && !hasOAuthConfigured)) && (
          <Grid container spacing={2}>
            {/* Slack User ID Input */}
            <Grid xs={12} md={4}>
              <FormControl>
                <FormLabel sx={{ userSelect: 'text', color: 'text.primary', opacity: 0.5 }}>Slack Member ID</FormLabel>
                <Input
                  placeholder="U0123456789"
                  value={slackUserId}
                  onChange={e => setSlackUserId(e.target.value)}
                  disabled={isLinked}
                  sx={{
                    width: '100%',
                    overflow: 'hidden',
                    backgroundColor: theme => theme.palette.loginRegister.inputFieldBg,
                    '& input': {
                      backgroundColor: 'transparent',
                      color: 'text.primary',
                      fontSize: '14px',
                      '&::placeholder': {
                        color: 'text.primary',
                        opacity: 0.5,
                        fontSize: '14px',
                      },
                    },
                    '&:-webkit-autofill, & input:-webkit-autofill': {
                      WebkitBackgroundClip: 'text',
                      boxShadow: theme =>
                        theme.palette.mode === 'dark'
                          ? 'inset 0 0 20px 20px rgba(70, 90, 126, 0.4)'
                          : 'inset 0 0 20px 20px #e8f0fe',
                      backgroundColor: 'transparent',
                      borderRadius: '10px',
                    },
                  }}
                />
                {!isLinked && (
                  <Typography level="body-xs" sx={{ mt: 0.5, color: 'primary.500' }}>
                    Slack Profile → Three dot button → Copy Member ID
                  </Typography>
                )}
              </FormControl>
            </Grid>

            {/* Default Notebook */}
            <Grid xs={12} md={4}>
              <FormControl>
                <FormLabel sx={{ userSelect: 'text', color: 'text.primary', opacity: 0.5 }}>
                  Default Notebook ID (Optional)
                </FormLabel>
                <Input
                  placeholder="Leave empty for auto-creation"
                  value={defaultNotebookId}
                  onChange={e => setDefaultNotebookId(e.target.value)}
                  sx={{
                    width: '100%',
                    overflow: 'hidden',
                    backgroundColor: theme => theme.palette.loginRegister.inputFieldBg,
                    '& input': {
                      backgroundColor: 'transparent',
                      color: 'text.primary',
                      fontSize: '14px',
                      '&::placeholder': {
                        color: 'text.primary',
                        opacity: 0.5,
                        fontSize: '14px',
                      },
                    },
                    '&:-webkit-autofill, & input:-webkit-autofill': {
                      WebkitBackgroundClip: 'text',
                      boxShadow: theme =>
                        theme.palette.mode === 'dark'
                          ? 'inset 0 0 20px 20px rgba(70, 90, 126, 0.4)'
                          : 'inset 0 0 20px 20px #e8f0fe',
                      backgroundColor: 'transparent',
                      borderRadius: '10px',
                    },
                  }}
                />
                <Typography level="body-xs" sx={{ mt: 0.5, color: 'primary.500' }}>
                  Specific notebook ID to send Slack messages to.
                </Typography>
              </FormControl>
            </Grid>

            {/* Notebook Name Prefix */}
            {autoCreateNotebook && (
              <Grid xs={12} md={4}>
                <FormControl>
                  <FormLabel sx={{ userSelect: 'text', color: 'text.primary', opacity: 0.5 }}>
                    Auto-created Notebook Name Prefix
                  </FormLabel>
                  <Input
                    value={notebookNamePrefix}
                    onChange={e => setNotebookNamePrefix(e.target.value)}
                    sx={{
                      width: '100%',
                      overflow: 'hidden',
                      backgroundColor: theme => theme.palette.loginRegister.inputFieldBg,
                      '& input': {
                        backgroundColor: 'transparent',
                      },
                      '&:-webkit-autofill, & input:-webkit-autofill': {
                        WebkitBackgroundClip: 'text',
                        boxShadow: theme =>
                          theme.palette.mode === 'dark'
                            ? 'inset 0 0 20px 20px rgba(70, 90, 126, 0.4)'
                            : 'inset 0 0 20px 20px #e8f0fe',
                        backgroundColor: 'transparent',
                        borderRadius: '10px',
                      },
                    }}
                  />
                  <Typography level="body-xs" sx={{ mt: 0.5, color: 'primary.500' }}>
                    (e.g., &quot;Slack Chat - 12/25/2024&quot;)
                  </Typography>
                </FormControl>
              </Grid>
            )}
          </Grid>
        )}

        {/* Default Project for Auto-created Notebooks */}
        {autoCreateNotebook && isLinked && (
          <Box>
            <Typography level="h4" sx={{ fontSize: '14px', mb: 1.5, color: 'text.primary', opacity: 0.7 }}>
              Default Project for Slack Notebooks (Optional)
            </Typography>
            <Typography level="body-sm" sx={{ mb: 2, color: 'text.primary', opacity: 0.6 }}>
              When set, auto-created notebooks from Slack will be added to this project.
            </Typography>
            <FormControl sx={{ maxWidth: 400 }}>
              <Select
                placeholder="Select project (optional)"
                value={defaultProjectId || null}
                onChange={(_, newValue) => {
                  setDefaultProjectId(newValue || '');
                }}
                sx={{
                  backgroundColor: theme => theme.palette.loginRegister.inputFieldBg,
                  '& .MuiSelect-button': {
                    color: 'text.primary',
                    fontSize: '14px',
                  },
                }}
              >
                <Option value={null as any}>No project (default)</Option>
                {projectsData?.map((project: any) => (
                  <Option key={project.id} value={project.id}>
                    {project.name || 'Untitled Project'}
                  </Option>
                ))}
              </Select>
              <Typography level="body-xs" sx={{ mt: 0.5, color: 'primary.500' }}>
                Leave empty to create notebooks without a project assignment
              </Typography>
            </FormControl>
          </Box>
        )}

        {/* Custom Agent for @agent Command (Optional) */}
        {isLinked && (
          <Box>
            <Typography level="h4" sx={{ fontSize: '14px', mb: 1.5, color: 'text.primary', opacity: 0.7 }}>
              Custom Agent for @agent Command (Optional)
            </Typography>
            <Typography level="body-sm" sx={{ mb: 2, color: 'text.primary', opacity: 0.6 }}>
              When set, @agent commands will use your selected custom agent instead of the default general-purpose
              agent.
            </Typography>
            <FormControl sx={{ maxWidth: 400 }}>
              <Select
                data-testid="slack-custom-agent-select"
                placeholder="Use default general-purpose agent"
                value={customAgentId || null}
                onChange={(_, newValue) => {
                  setCustomAgentId(newValue || '');
                }}
                sx={{
                  backgroundColor: theme => theme.palette.loginRegister.inputFieldBg,
                  '& .MuiSelect-button': {
                    color: 'text.primary',
                    fontSize: '14px',
                  },
                }}
              >
                <Option value={null as any}>Use default general-purpose agent</Option>
                {customAgents.map(agent => (
                  <Option key={agent.id} value={agent.id}>
                    {agent.name}
                  </Option>
                ))}
              </Select>
              <Typography level="body-xs" sx={{ mt: 0.5, color: 'primary.500' }}>
                {customAgents.length === 0
                  ? 'Create custom agents in the Agents tab to select one here'
                  : 'Select a custom agent or leave empty for default behavior'}
              </Typography>
            </FormControl>
          </Box>
        )}

        {/* Agent Notebook Routing (Optional) */}
        <Box>
          <Typography level="h4" sx={{ fontSize: '14px', mb: 1.5, color: 'text.primary', opacity: 0.7 }}>
            Agent Notebook Routing (Optional)
          </Typography>
          <Typography level="body-sm" sx={{ mb: 2, color: 'text.primary', opacity: 0.6 }}>
            Route messages from different agents to specific notebooks. Leave empty to use default behavior.
          </Typography>

          <Grid container spacing={2}>
            {AGENTS.map(agent => (
              <Grid xs={12} md={6} key={agent.key}>
                <FormControl>
                  <FormLabel sx={{ userSelect: 'text', color: 'text.primary', opacity: 0.5 }}>
                    {agent.emoji} {agent.label} - {agent.description}
                  </FormLabel>
                  <Select
                    placeholder="Use default routing"
                    value={agentNotebookRouting[agent.key] || null}
                    onChange={(_, newValue) => {
                      setAgentNotebookRouting(prev => ({
                        ...prev,
                        [agent.key]: newValue || undefined,
                      }));
                    }}
                    sx={{
                      backgroundColor: theme => theme.palette.loginRegister.inputFieldBg,
                      '& .MuiSelect-button': {
                        color: 'text.primary',
                        fontSize: '14px',
                      },
                    }}
                  >
                    <Option value={null as any}>Use default routing</Option>
                    {notebooks.map(notebook => (
                      <Option key={notebook.id} value={notebook.id}>
                        {notebook.name || 'Untitled Notebook'}
                      </Option>
                    ))}
                  </Select>
                </FormControl>
              </Grid>
            ))}
          </Grid>
        </Box>
        {/* Keyword Routing Rules Section - Only show when linked */}
        {isLinked && (
          <Box sx={{ mt: 2 }}>
            <Typography level="title-sm" sx={{ mb: 0.5, color: 'text.primary' }}>
              Keyword Routing Rules (Optional)
            </Typography>
            <Typography level="body-xs" sx={{ mb: 2, color: 'text.tertiary' }}>
              Route messages containing specific keywords to designated notebooks. First matching rule wins.
            </Typography>

            {/* Existing Rules List */}
            {keywordRouting.length > 0 && (
              <Stack spacing={1} sx={{ mb: 2 }}>
                {keywordRouting.map((rule, index) => (
                  <Card key={`${rule.notebookId}-${rule.keywords.join(',')}`} variant="outlined" sx={{ p: 1.5 }}>
                    <Stack direction="row" alignItems="center" justifyContent="space-between">
                      <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: 'wrap', flex: 1 }}>
                        {rule.keywords.map((kw, kwIndex) => (
                          <Chip key={kwIndex} size="sm" variant="soft" color="primary">
                            {kw}
                          </Chip>
                        ))}
                        <Typography level="body-xs" sx={{ mx: 1, color: 'text.tertiary' }}>
                          →
                        </Typography>
                        <Typography level="body-sm">
                          {notebooks.find(n => n.id === rule.notebookId)?.name || rule.notebookId}
                        </Typography>
                      </Stack>
                      <Stack direction="row" spacing={0.5}>
                        <IconButton size="sm" variant="plain" color="neutral" onClick={() => openEditRuleModal(index)}>
                          <EditIcon />
                        </IconButton>
                        <IconButton
                          size="sm"
                          variant="plain"
                          color="danger"
                          onClick={() => handleRemoveKeywordRule(index)}
                        >
                          <DeleteIcon />
                        </IconButton>
                      </Stack>
                    </Stack>
                  </Card>
                ))}
              </Stack>
            )}

            {/* Add Rule Button */}
            <Button
              size="sm"
              variant="outlined"
              startDecorator={<AddIcon />}
              onClick={openAddRuleModal}
              disabled={keywordRouting.length >= 10}
            >
              Add Rule
            </Button>
            {keywordRouting.length >= 10 && (
              <Typography level="body-xs" sx={{ mt: 0.5, color: 'warning.500' }}>
                Maximum 10 rules reached
              </Typography>
            )}
          </Box>
        )}

        {/* Add/Edit Rule Modal */}
        <Modal open={isRuleModalOpen} onClose={closeRuleModal}>
          <ModalDialog sx={{ maxWidth: 450 }}>
            <ModalClose />
            <Typography level="title-md">
              {editingRuleIndex !== null ? 'Edit Keyword Routing Rule' : 'Add Keyword Routing Rule'}
            </Typography>

            <FormControl sx={{ mt: 2 }}>
              <FormLabel>Keywords (comma-separated)</FormLabel>
              <Input
                placeholder="lumina5, lumina, bike4mind"
                value={ruleKeywords}
                onChange={e => setRuleKeywords(e.target.value)}
              />
              <FormHelperText>Messages containing any of these keywords will be routed</FormHelperText>
            </FormControl>

            <FormControl sx={{ mt: 2 }}>
              <FormLabel>Route to Notebook</FormLabel>
              {notebooks.length === 0 ? (
                <Alert color="warning" variant="soft" size="sm">
                  No notebooks found. Create a notebook first to set up routing rules.
                </Alert>
              ) : (
                <Select
                  value={ruleNotebookId}
                  onChange={(_, value) => setRuleNotebookId(value as string)}
                  placeholder="Select notebook..."
                >
                  {notebooks.map(notebook => (
                    <Option key={notebook.id} value={notebook.id}>
                      {notebook.name}
                    </Option>
                  ))}
                </Select>
              )}
            </FormControl>

            <Button
              sx={{ mt: 2 }}
              onClick={handleSaveKeywordRule}
              disabled={!ruleKeywords || !ruleNotebookId || notebooks.length === 0}
            >
              {editingRuleIndex !== null ? 'Save Changes' : 'Add Rule'}
            </Button>
          </ModalDialog>
        </Modal>

        {/* Usage Instructions - Only show when linked */}
        {isLinked && (
          <Alert
            color="primary"
            variant="soft"
            sx={theme => ({
              backgroundColor: theme.palette.mode === 'light' ? '#F7F9FB' : undefined,
              alignSelf: 'flex-start',
              width: 'fit-content',
              p: 2,
            })}
          >
            <Box>
              <Typography level="body-sm" sx={{ color: 'text.primary', opacity: 0.5, mb: 1.5, fontWeight: 'bold' }}>
                How to use:
              </Typography>
              <Stack spacing={1}>
                <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                  • Mention the bot in any channel: <code>@YourBot Hello there!</code>
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                  • Send direct messages to the bot
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                  • Use <code>/notebook status</code> to see current settings
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                  • Use <code>/notebook list</code> to see your notebooks
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                  • Use <code>/notebook create [name]</code> to create a new notebook
                </Typography>
              </Stack>
            </Box>
          </Alert>
        )}

        {/* Save Button - hide when OAuth is available but user not linked (accordion has its own save) */}
        {(isLinked || !hasOAuthConfigured) && (
          <Button onClick={handleSave} loading={updateSlackSettings.isPending} sx={{ alignSelf: 'flex-start' }}>
            Save Slack Settings
          </Button>
        )}
      </Stack>
    </SectionContainer>
  );
};

export default SlackIntegrationSection;
