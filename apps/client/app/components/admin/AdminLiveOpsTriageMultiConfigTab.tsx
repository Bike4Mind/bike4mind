/**
 * LiveOps Triage Multi-Config Admin Tab
 *
 * Provides UI for managing multiple LiveOps triage configurations,
 * each with its own Slack channel source and issue tracker (GitHub or Jira).
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  Box,
  Card,
  Typography,
  Button,
  IconButton,
  Chip,
  Alert,
  CircularProgress,
  FormControl,
  FormLabel,
  FormHelperText,
  Input,
  Select,
  Option,
  Switch,
  Divider,
  Modal,
  ModalDialog,
  ModalClose,
  LinearProgress,
  List,
  ListItem,
  ListItemButton,
  ListItemContent,
  ListItemDecorator,
  RadioGroup,
  Radio,
  Textarea,
  Tooltip,
} from '@mui/joy';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import { getErrorMessage } from '@client/app/utils/error';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { LIVEOPS_TRIAGE_VALIDATION_LIMITS } from '@bike4mind/common';
import { getNextScheduledRun, formatNextRun, getIntervalDescription } from '@client/shared/liveopsScheduleUtils';

// Icons
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import SaveIcon from '@mui/icons-material/Save';
import HealthAndSafetyIcon from '@mui/icons-material/HealthAndSafety';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import WarningIcon from '@mui/icons-material/Warning';
import SettingsIcon from '@mui/icons-material/Settings';
import GitHubIcon from '@mui/icons-material/GitHub';
import BugReportIcon from '@mui/icons-material/BugReport';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import VisibilityIcon from '@mui/icons-material/Visibility';
import RefreshIcon from '@mui/icons-material/Refresh';
import ScheduleIcon from '@mui/icons-material/Schedule';
import TuneIcon from '@mui/icons-material/Tune';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import CodeIcon from '@mui/icons-material/Code';
import ForumIcon from '@mui/icons-material/Forum';

// Components
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

// Template variable docs
import { TEMPLATE_VARIABLE_DOCS } from '@server/services/liveopsTriagePrompt';

// Types
interface LiveopsTriageConfig {
  id: string;
  name: string;
  enabled: boolean;
  slackWorkspaceId?: string;
  slackChannelId: string;
  slackOutputChannelId?: string;
  issueTracker: 'github' | 'jira';
  githubOwner?: string;
  githubRepo?: string;
  jiraProjectKey?: string;
  jiraIssueType?: string;
  runIntervalHours: 6 | 12 | 24;
  modelId: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  promptTemplate?: string;
  maxErrorsPerRun: number;
  regressionLookbackDays: number;
  regressionGracePeriodHours: number;
  autoCreateIssues: boolean;
  postWhenNoErrors: boolean;
  lastRunAt?: string;
  lastRunStartedAt?: string;
  lastRunResult?: {
    status: 'success' | 'failure' | 'skipped';
    errorsProcessed: number;
    issuesCreated: number;
    issuesDeduplicated: number;
    error?: string;
  };
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

interface DryRunSummary {
  totalAlerts: number;
  newIssues: number;
  duplicates: number;
  regressions: number;
  p0Count: number;
  p1Count: number;
  p2Count: number;
  p3Count: number;
  recurringPatterns: string[];
  healthAssessment: string;
}

interface DryRunIssueWouldCreate {
  title: string;
  priority: string;
  category: string;
  body: string;
  labels: string[];
  isRecurring: boolean;
  occurrenceCount: number;
  isRegression: boolean;
}

interface DryRunIssueWouldSkip {
  title: string;
  priority: string;
  matchesExisting: { issueNumber: number; title: string; state?: 'open' | 'closed' };
}

interface DryRunResult {
  status: 'success' | 'failed';
  lookbackHours: number;
  alertsFetched: number;
  alertsToProcess: number;
  existingIssuesFound: number;
  summary: DryRunSummary;
  issuesWouldCreate: DryRunIssueWouldCreate[];
  issuesWouldSkip: DryRunIssueWouldSkip[];
  llmDetails: {
    modelId: string;
    promptLength: number;
    responseLength: number;
    estimatedCost: string;
  };
  error?: string;
}

interface ActiveRun {
  id: string;
  configId: string;
  configName: string;
  runType: 'dry' | 'full';
  source: 'manual' | 'cron';
  status: 'queued' | 'processing' | 'complete' | 'failed';
  progress: number;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: {
    errorsProcessed: number;
    issuesCreated: number;
    issuesDeduplicated: number;
  };
  error?: string;
  dryRunResult?: DryRunResult;
}

interface HealthCheckResult {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  checks: Array<{
    name: string;
    status: 'ok' | 'warning' | 'error';
    message: string;
    details?: Record<string, unknown>;
  }>;
  timestamp: string;
}

interface SlackWorkspace {
  id: string;
  name: string;
  slackTeamId: string;
  isActive: boolean;
}

const getDefaultConfig = (): Partial<LiveopsTriageConfig> => ({
  name: '',
  enabled: false,
  slackChannelId: '',
  issueTracker: 'github',
  runIntervalHours: 12,
  modelId: '',
  temperature: 0.3,
  maxTokens: 1000,
  timeoutMs: 60000,
  maxErrorsPerRun: 50,
  regressionLookbackDays: 30,
  regressionGracePeriodHours: 48,
  autoCreateIssues: false,
  postWhenNoErrors: true,
});

const POLL_INTERVAL_MS = 3000;

// Default prompt template (simplified version for display)
const DEFAULT_PROMPT_TEMPLATE = `You are an expert DevOps engineer analyzing production errors. Review the alerts and triage them.

**Alerts to Triage:**
{{alerts}}

**Existing Open Issues:**
{{existingIssues}}

**Recently Closed Issues (check for regressions):**
{{recentlyClosedIssues}}

**Priority Guidelines:**
{{priorityGuidelines}}

**Repository:** {{repoName}}

For each alert, determine:
1. Priority (P0-P3) based on severity and user impact
2. Whether it matches an existing issue (deduplicate)
3. Whether it matches a recently closed issue (regression)
4. A concise title and description for a new issue if needed`;

export const AdminLiveOpsTriageMultiConfigTab: React.FC = () => {
  const queryClient = useQueryClient();
  const { data: models } = useModelInfo();

  // State
  const [selectedConfigId, setSelectedConfigId] = useState<string | null>(null);
  const [editingConfig, setEditingConfig] = useState<Partial<LiveopsTriageConfig> | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [activeRunsExpanded, setActiveRunsExpanded] = useState(true);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [triggerConfirmOpen, setTriggerConfirmOpen] = useState(false);
  const [triggerDryRun, setTriggerDryRun] = useState(true);
  const [triggerLookbackHours, setTriggerLookbackHours] = useState<number | null>(null);
  const [healthCheckResult, setHealthCheckResult] = useState<HealthCheckResult | null>(null);
  const [healthCheckLoading, setHealthCheckLoading] = useState(false);
  const [defaultTemplateOpen, setDefaultTemplateOpen] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [dryRunResultOpen, setDryRunResultOpen] = useState(false);
  const [dryRunResultData, setDryRunResultData] = useState<{ configName: string; result: DryRunResult } | null>(null);
  const [completedRunIds, setCompletedRunIds] = useState<Set<string>>(new Set());
  const [forcePolling, setForcePolling] = useState(false);

  // Ref for template textarea (click-to-insert)
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Ref for forced polling timeout cleanup
  const forcePollingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const {
    data: configs,
    isLoading: configsLoading,
    error: configsError,
  } = useQuery({
    queryKey: ['liveopsTriageConfigs'],
    queryFn: async () => {
      const response = await api.get('/api/admin/liveops-triage-configs');
      return response.data as LiveopsTriageConfig[];
    },
  });

  // Fetch active runs (poll when there are active runs OR force polling after trigger)
  const { data: runsData, refetch: refetchRuns } = useQuery({
    queryKey: ['liveopsTriageRuns', forcePolling], // Include forcePolling to trigger re-subscribe
    queryFn: async () => {
      const response = await api.get('/api/admin/liveops-triage-configs/runs');
      return response.data as { runs: ActiveRun[]; activeCount: number };
    },
    refetchInterval: query => {
      // Force polling for 30 seconds after trigger
      if (forcePolling) return POLL_INTERVAL_MS;
      // Otherwise, only poll when there are active runs
      const data = query.state.data;
      return data?.activeCount && data.activeCount > 0 ? POLL_INTERVAL_MS : false;
    },
  });

  const { data: workspacesData } = useQuery({
    queryKey: ['slackWorkspaces'],
    queryFn: async () => {
      const response = await api.get('/api/admin/slack-workspaces');
      return response.data as { workspaces: SlackWorkspace[] };
    },
  });

  // Watch for completed dry runs and show results modal
  useEffect(() => {
    if (!runsData?.runs) return;

    for (const run of runsData.runs) {
      // Check if this is a newly completed dry run that we haven't shown yet
      if (run.runType === 'dry' && run.status === 'complete' && run.dryRunResult && !completedRunIds.has(run.id)) {
        // Mark as shown so we don't show it again
        setCompletedRunIds(prev => new Set([...prev, run.id]));
        setDryRunResultData({ configName: run.configName, result: run.dryRunResult });
        setDryRunResultOpen(true);
        toast.success(
          `Dry run complete: ${run.dryRunResult.issuesWouldCreate.length} issues would be created, ${run.dryRunResult.summary.duplicates} duplicates`
        );
        break; // Only show one at a time
      }
    }
  }, [runsData?.runs, completedRunIds]);

  // Reset lookback hours when config changes
  useEffect(() => {
    setTriggerLookbackHours(null);
  }, [selectedConfigId]);

  // Cleanup forced polling timeout on unmount
  useEffect(() => {
    return () => {
      if (forcePollingTimeoutRef.current) {
        clearTimeout(forcePollingTimeoutRef.current);
      }
    };
  }, []);

  const parseApiErrors = (error: unknown): Record<string, string> => {
    const errors: Record<string, string> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const axiosError = error as any;
    const data = axiosError?.response?.data;

    if (data?.validationErrors) {
      // Zod validation errors from API
      Object.entries(data.validationErrors).forEach(([field, messages]) => {
        if (Array.isArray(messages) && messages.length > 0) {
          errors[field] = messages[0] as string;
        }
      });
    } else if (data?.error) {
      // Generic error - try to map to field
      const msg = data.error as string;
      if (msg.includes('GitHub owner')) errors.githubOwner = msg;
      else if (msg.includes('GitHub repo')) errors.githubRepo = msg;
      else if (msg.includes('Jira project key')) errors.jiraProjectKey = msg;
      else if (msg.includes('name already exists')) errors.name = msg;
    }
    return errors;
  };

  const validateConfig = (config: Partial<LiveopsTriageConfig>): Record<string, string> => {
    const errors: Record<string, string> = {};

    if (!config.name?.trim()) {
      errors.name = 'Name is required';
    }

    if (!config.slackChannelId?.trim()) {
      errors.slackChannelId = 'Source Channel ID is required';
    } else if (!/^C[A-Z0-9]+$/.test(config.slackChannelId)) {
      errors.slackChannelId = 'Invalid Slack channel ID format (should start with C)';
    }

    if (!config.modelId) {
      errors.modelId = 'Model is required';
    }

    if (config.issueTracker === 'github') {
      if (!config.githubOwner?.trim()) {
        errors.githubOwner = 'GitHub Owner is required';
      }
      if (!config.githubRepo?.trim()) {
        errors.githubRepo = 'GitHub Repo is required';
      }
    } else if (config.issueTracker === 'jira') {
      if (!config.jiraProjectKey?.trim()) {
        errors.jiraProjectKey = 'Jira Project Key is required';
      } else if (!/^[A-Z][A-Z0-9]*$/.test(config.jiraProjectKey)) {
        errors.jiraProjectKey = 'Must be uppercase letters/numbers starting with a letter';
      }
    }

    return errors;
  };

  const createMutation = useMutation({
    mutationFn: async (data: Partial<LiveopsTriageConfig>) => {
      const response = await api.post('/api/admin/liveops-triage-configs', data);
      return response.data as LiveopsTriageConfig;
    },
    onSuccess: newConfig => {
      toast.success(`Config "${newConfig.name}" created successfully`);
      queryClient.invalidateQueries({ queryKey: ['liveopsTriageConfigs'] });
      setSelectedConfigId(newConfig.id);
      setEditingConfig(newConfig);
      setIsCreating(false);
      setFieldErrors({});
    },
    onError: (error: unknown) => {
      const apiErrors = parseApiErrors(error);
      if (Object.keys(apiErrors).length > 0) {
        setFieldErrors(apiErrors);
        toast.error('Please fix the highlighted errors');
      } else {
        toast.error(`Failed to create config: ${getErrorMessage(error)}`);
      }
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<LiveopsTriageConfig> }) => {
      const response = await api.put(`/api/admin/liveops-triage-configs/${id}`, data);
      return response.data as LiveopsTriageConfig;
    },
    onSuccess: updatedConfig => {
      toast.success(`Config "${updatedConfig.name}" updated successfully`);
      queryClient.invalidateQueries({ queryKey: ['liveopsTriageConfigs'] });
      setEditingConfig(updatedConfig);
      setFieldErrors({});
    },
    onError: (error: unknown) => {
      const apiErrors = parseApiErrors(error);
      if (Object.keys(apiErrors).length > 0) {
        setFieldErrors(apiErrors);
        toast.error('Please fix the highlighted errors');
      } else {
        toast.error(`Failed to update config: ${getErrorMessage(error)}`);
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/admin/liveops-triage-configs/${id}`);
    },
    onSuccess: () => {
      toast.success('Config deleted successfully');
      queryClient.invalidateQueries({ queryKey: ['liveopsTriageConfigs'] });
      setSelectedConfigId(null);
      setEditingConfig(null);
      setDeleteConfirmOpen(false);
    },
    onError: (error: unknown) => {
      toast.error(`Failed to delete config: ${getErrorMessage(error)}`);
    },
  });

  const triggerMutation = useMutation({
    mutationFn: async ({ id, dryRun, lookbackHours }: { id: string; dryRun: boolean; lookbackHours: number }) => {
      const response = await api.post(`/api/admin/liveops-triage-configs/${id}/trigger`, { dryRun, lookbackHours });
      return response.data;
    },
    onSuccess: (_, { dryRun }) => {
      toast.success(`${dryRun ? 'Dry run' : 'Triage run'} queued successfully`);
      setTriggerConfirmOpen(false);

      // Start forced polling for 30 seconds to ensure we catch the new run
      // (run record is created asynchronously by SQS worker after trigger returns)
      setForcePolling(true);
      if (forcePollingTimeoutRef.current) {
        clearTimeout(forcePollingTimeoutRef.current);
      }
      forcePollingTimeoutRef.current = setTimeout(() => {
        setForcePolling(false);
      }, 30000);

      refetchRuns();
    },
    onError: (error: unknown) => {
      toast.error(`Failed to trigger run: ${getErrorMessage(error)}`);
    },
  });

  const checkHealth = useCallback(async (configId: string) => {
    setHealthCheckLoading(true);
    try {
      const response = await api.get(`/api/admin/liveops-triage-configs/${configId}/health`);
      setHealthCheckResult(response.data as HealthCheckResult);
    } catch (error) {
      toast.error(`Health check failed: ${getErrorMessage(error)}`);
    } finally {
      setHealthCheckLoading(false);
    }
  }, []);

  const handleSelectConfig = useCallback(
    (configId: string) => {
      const config = configs?.find(c => c.id === configId);
      if (config) {
        setSelectedConfigId(configId);
        setEditingConfig({ ...config });
        setIsCreating(false);
        setHealthCheckResult(null);
        setFieldErrors({});
        // Auto-fetch health for existing configs
        checkHealth(configId);
      }
    },
    [configs, checkHealth]
  );

  const handleStartCreate = useCallback(() => {
    setSelectedConfigId(null);
    setEditingConfig(getDefaultConfig());
    setIsCreating(true);
    setHealthCheckResult(null);
    setFieldErrors({});
  }, []);

  const handleSave = useCallback(() => {
    if (!editingConfig) return;

    const errors = validateConfig(editingConfig);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      toast.error('Please fix the highlighted errors');
      return;
    }

    setFieldErrors({});
    if (isCreating) {
      createMutation.mutate(editingConfig);
    } else if (selectedConfigId) {
      updateMutation.mutate({ id: selectedConfigId, data: editingConfig });
    }
  }, [editingConfig, isCreating, selectedConfigId, createMutation, updateMutation]);

  // Insert template variable at cursor position
  const handleInsertVariable = useCallback(
    (variable: string) => {
      const textarea = textareaRef.current;
      if (!textarea || !editingConfig) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const currentValue = editingConfig.promptTemplate || '';
      const variableText = `{{${variable}}}`;
      const newValue = currentValue.substring(0, start) + variableText + currentValue.substring(end);

      setEditingConfig({ ...editingConfig, promptTemplate: newValue });

      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + variableText.length;
        textarea.focus();
      }, 0);
    },
    [editingConfig]
  );

  const textModels = models?.filter(m => m.type === 'text') || [];
  const modelsByProvider = textModels.reduce(
    (acc, model) => {
      const provider = model.backend || 'unknown';
      if (!acc[provider]) acc[provider] = [];
      acc[provider].push(model);
      return acc;
    },
    {} as Record<string, typeof textModels>
  );

  const L = LIVEOPS_TRIAGE_VALIDATION_LIMITS;

  // Check for unsaved changes
  const selectedConfig = configs?.find(c => c.id === selectedConfigId);
  const isDirty = isCreating || (selectedConfig && JSON.stringify(editingConfig) !== JSON.stringify(selectedConfig));

  // Effective lookback hours for trigger modal (use state value or default to config interval)
  const effectiveLookbackHours = triggerLookbackHours ?? selectedConfig?.runIntervalHours ?? 12;

  // Active runs for display
  const activeRuns = runsData?.runs.filter(r => r.status === 'queued' || r.status === 'processing') || [];
  const recentRuns = runsData?.runs.filter(r => r.status === 'complete' || r.status === 'failed').slice(0, 5) || [];

  if (configsLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (configsError) {
    return (
      <Alert color="danger" variant="outlined" sx={{ m: 2 }}>
        Failed to load configurations. Please try again.
      </Alert>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', p: 2, gap: 2 }}>
      {/* Active Runs Panel */}
      <Card variant="outlined" sx={{ p: 2 }}>
        <Box
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
          onClick={() => setActiveRunsExpanded(!activeRunsExpanded)}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography level="title-sm">Active Runs</Typography>
            {activeRuns.length > 0 && (
              <Chip size="sm" color="primary" variant="solid">
                {activeRuns.length}
              </Chip>
            )}
          </Box>
          <IconButton size="sm" variant="plain">
            {activeRunsExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
        </Box>

        {activeRunsExpanded && (
          <Box sx={{ mt: 2 }}>
            {activeRuns.length === 0 && recentRuns.length === 0 ? (
              <Typography level="body-sm" sx={{ color: 'text.secondary', textAlign: 'center', py: 2 }}>
                No active or recent runs
              </Typography>
            ) : (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {activeRuns.map(run => (
                  <Box
                    key={run.id}
                    sx={{
                      p: 1.5,
                      borderRadius: 'sm',
                      bgcolor: 'primary.softBg',
                      border: '1px solid',
                      borderColor: 'primary.outlinedBorder',
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Typography level="body-sm" fontWeight="lg">
                          {run.configName}
                        </Typography>
                        <Chip size="sm" variant="outlined" color={run.runType === 'dry' ? 'neutral' : 'success'}>
                          {run.runType === 'dry' ? 'Dry Run' : 'Full Run'}
                        </Chip>
                      </Box>
                      <Chip size="sm" color="primary">
                        {run.status === 'queued' ? 'Queued' : 'Processing'}
                      </Chip>
                    </Box>
                    <LinearProgress determinate value={run.progress} />
                    <Typography level="body-xs" sx={{ color: 'text.secondary', mt: 0.5 }}>
                      {run.progress}% complete
                    </Typography>
                  </Box>
                ))}
                {recentRuns.map(run => (
                  <Box
                    key={run.id}
                    sx={{
                      p: 1.5,
                      borderRadius: 'sm',
                      bgcolor: run.status === 'complete' ? 'success.softBg' : 'danger.softBg',
                      border: '1px solid',
                      borderColor: run.status === 'complete' ? 'success.outlinedBorder' : 'danger.outlinedBorder',
                      opacity: 0.7,
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Typography level="body-sm" fontWeight="lg">
                          {run.configName}
                        </Typography>
                        <Chip size="sm" variant="outlined" color={run.runType === 'dry' ? 'neutral' : 'success'}>
                          {run.runType === 'dry' ? 'Dry Run' : 'Full Run'}
                        </Chip>
                      </Box>
                      <Chip size="sm" color={run.status === 'complete' ? 'success' : 'danger'}>
                        {run.status === 'complete' ? 'Complete' : 'Failed'}
                      </Chip>
                    </Box>
                    {run.result && (
                      <Typography level="body-xs" sx={{ color: 'text.secondary', mt: 0.5 }}>
                        {run.result.errorsProcessed} errors processed, {run.result.issuesCreated} issues created
                      </Typography>
                    )}
                    {run.error && (
                      <Typography level="body-xs" sx={{ color: 'danger.500', mt: 0.5 }}>
                        Error: {run.error}
                      </Typography>
                    )}
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        )}
      </Card>

      {/* Main Content - List + Detail */}
      <Box sx={{ display: 'flex', gap: 2, flex: 1, minHeight: 0 }}>
        {/* Config List */}
        <Card variant="outlined" sx={{ width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography level="title-sm">Configurations</Typography>
              <Button size="sm" variant="soft" startDecorator={<AddIcon />} onClick={handleStartCreate}>
                Add
              </Button>
            </Box>
          </Box>
          <List sx={{ flex: 1, overflow: 'auto', py: 0 }}>
            {configs?.map(config => (
              <ListItem key={config.id}>
                <ListItemButton
                  selected={selectedConfigId === config.id}
                  onClick={() => handleSelectConfig(config.id)}
                  sx={{ borderRadius: 'sm' }}
                >
                  <ListItemDecorator>
                    {config.issueTracker === 'github' ? (
                      <GitHubIcon sx={{ fontSize: 18 }} />
                    ) : (
                      <BugReportIcon sx={{ fontSize: 18, color: 'primary.500' }} />
                    )}
                  </ListItemDecorator>
                  <ListItemContent>
                    <Typography level="body-sm" fontWeight={selectedConfigId === config.id ? 'lg' : 'md'}>
                      {config.name}
                    </Typography>
                    <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                      {config.issueTracker === 'github' ? 'GitHub' : 'Jira'} · {config.runIntervalHours}hr
                    </Typography>
                  </ListItemContent>
                  <Chip
                    size="sm"
                    variant="outlined"
                    color={config.enabled ? 'success' : 'neutral'}
                    sx={{ ml: 1, minWidth: 'auto' }}
                  >
                    {config.enabled ? 'On' : 'Off'}
                  </Chip>
                </ListItemButton>
              </ListItem>
            ))}
            {configs?.length === 0 && (
              <Box sx={{ p: 2, textAlign: 'center' }}>
                <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                  No configurations yet
                </Typography>
              </Box>
            )}
          </List>
        </Card>

        {/* Config Detail */}
        <Card variant="outlined" sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {!editingConfig ? (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
              <Box sx={{ textAlign: 'center' }}>
                <SettingsIcon sx={{ fontSize: 48, color: 'text.tertiary', mb: 2 }} />
                <Typography level="body-md" sx={{ color: 'text.secondary' }}>
                  Select a configuration to edit
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
                  or create a new one
                </Typography>
              </Box>
            </Box>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              {/* Header */}
              <Box
                sx={{
                  p: 2,
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography level="title-md">{isCreating ? 'New Configuration' : editingConfig.name}</Typography>
                  <ContextHelpButton helpId="admin/liveops-triage" tooltipText="LiveOps Triage Help" />
                </Box>
                <Box sx={{ display: 'flex', gap: 1 }}>
                  {!isCreating && selectedConfigId && (
                    <>
                      <Button
                        size="sm"
                        variant="outlined"
                        startDecorator={<PlayArrowIcon />}
                        onClick={() => {
                          setTriggerDryRun(true);
                          setTriggerConfirmOpen(true);
                        }}
                      >
                        Dry Run
                      </Button>
                      <Tooltip title="Creates real issues - use with caution" placement="top">
                        <Button
                          size="sm"
                          variant="solid"
                          color="success"
                          startDecorator={<PlayArrowIcon />}
                          onClick={() => {
                            setTriggerDryRun(false);
                            setTriggerConfirmOpen(true);
                          }}
                        >
                          Run Now
                        </Button>
                      </Tooltip>
                    </>
                  )}
                </Box>
              </Box>

              {/* Form */}
              <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {/* System Health Section - inside scrollable area */}
                  {!isCreating && (
                    <Box>
                      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <HealthAndSafetyIcon sx={{ fontSize: 20 }} />
                          <Typography level="title-sm">System Health</Typography>
                          {healthCheckResult && (
                            <Chip
                              size="sm"
                              variant="outlined"
                              color={
                                healthCheckResult.overall === 'healthy'
                                  ? 'success'
                                  : healthCheckResult.overall === 'degraded'
                                    ? 'warning'
                                    : 'danger'
                              }
                            >
                              {healthCheckResult.overall.toUpperCase()}
                            </Chip>
                          )}
                        </Box>
                        <IconButton
                          size="sm"
                          variant="outlined"
                          onClick={() => selectedConfigId && checkHealth(selectedConfigId)}
                          disabled={healthCheckLoading}
                        >
                          {healthCheckLoading ? <CircularProgress size="sm" /> : <RefreshIcon />}
                        </IconButton>
                      </Box>

                      {healthCheckLoading && !healthCheckResult && (
                        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                          <CircularProgress size="sm" />
                        </Box>
                      )}

                      {healthCheckResult && (
                        <Box
                          sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 2 }}
                        >
                          {healthCheckResult.checks.map((check, idx) => (
                            <Box
                              key={idx}
                              sx={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: 1.5,
                                p: 1.5,
                                borderRadius: 'sm',
                                border: '1px solid',
                                borderColor:
                                  check.status === 'ok'
                                    ? 'success.400'
                                    : check.status === 'warning'
                                      ? 'warning.400'
                                      : 'danger.400',
                                bgcolor: 'background.surface',
                              }}
                            >
                              {check.status === 'ok' ? (
                                <CheckCircleIcon sx={{ fontSize: 20, color: 'success.500', mt: 0.25 }} />
                              ) : check.status === 'warning' ? (
                                <WarningIcon sx={{ fontSize: 20, color: 'warning.500', mt: 0.25 }} />
                              ) : (
                                <ErrorIcon sx={{ fontSize: 20, color: 'danger.500', mt: 0.25 }} />
                              )}
                              <Box sx={{ flex: 1, minWidth: 0 }}>
                                <Typography
                                  level="body-sm"
                                  fontWeight="lg"
                                  sx={{
                                    color:
                                      check.status === 'ok'
                                        ? 'success.700'
                                        : check.status === 'warning'
                                          ? 'warning.700'
                                          : 'danger.700',
                                  }}
                                >
                                  {check.name}
                                </Typography>
                                <Typography
                                  level="body-xs"
                                  sx={{
                                    color: 'text.secondary',
                                    wordBreak: 'break-word',
                                  }}
                                >
                                  {check.message}
                                </Typography>
                              </Box>
                            </Box>
                          ))}
                        </Box>
                      )}
                    </Box>
                  )}

                  {/* Basic Settings */}
                  <Box>
                    <Typography level="title-sm" sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                      <SettingsIcon fontSize="small" />
                      Basic Settings
                    </Typography>
                    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(2, 1fr)' }}>
                      <FormControl required error={!!fieldErrors.name}>
                        <FormLabel>Name</FormLabel>
                        <Input
                          value={editingConfig.name || ''}
                          onChange={e => {
                            setEditingConfig({ ...editingConfig, name: e.target.value });
                            if (fieldErrors.name) setFieldErrors(prev => ({ ...prev, name: '' }));
                          }}
                          placeholder="e.g., Production Errors"
                          color={fieldErrors.name ? 'danger' : undefined}
                        />
                        <FormHelperText>{fieldErrors.name || 'Unique identifier for this config'}</FormHelperText>
                      </FormControl>

                      <FormControl>
                        <FormLabel>Status</FormLabel>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, height: 40 }}>
                          <Switch
                            checked={editingConfig.enabled || false}
                            onChange={e => setEditingConfig({ ...editingConfig, enabled: e.target.checked })}
                            color={editingConfig.enabled ? 'success' : 'neutral'}
                          />
                          <Typography level="body-sm">{editingConfig.enabled ? 'Enabled' : 'Disabled'}</Typography>
                        </Box>
                      </FormControl>
                    </Box>
                  </Box>

                  <Divider />

                  {/* Issue Tracker */}
                  <Box>
                    <Typography level="title-sm" sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                      <BugReportIcon fontSize="small" />
                      Issue Tracker
                    </Typography>
                    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(2, 1fr)' }}>
                      <FormControl required>
                        <FormLabel>Type</FormLabel>
                        <RadioGroup
                          orientation="horizontal"
                          value={editingConfig.issueTracker || 'github'}
                          onChange={e =>
                            setEditingConfig({
                              ...editingConfig,
                              issueTracker: e.target.value as 'github' | 'jira',
                            })
                          }
                          sx={{ gap: 2 }}
                        >
                          <Box
                            component="label"
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 1,
                              cursor: 'pointer',
                              pr: 1,
                            }}
                          >
                            <Radio value="github" />
                            <Typography level="body-sm">GitHub</Typography>
                          </Box>
                          <Box
                            component="label"
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 1,
                              cursor: 'pointer',
                              pr: 1,
                            }}
                          >
                            <Radio value="jira" />
                            <Typography level="body-sm">Jira</Typography>
                          </Box>
                        </RadioGroup>
                      </FormControl>
                    </Box>

                    {/* GitHub Fields */}
                    {editingConfig.issueTracker === 'github' && (
                      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(2, 1fr)', mt: 2 }}>
                        <FormControl required error={!!fieldErrors.githubOwner}>
                          <FormLabel>GitHub Owner</FormLabel>
                          <Input
                            value={editingConfig.githubOwner || ''}
                            onChange={e => {
                              setEditingConfig({ ...editingConfig, githubOwner: e.target.value });
                              if (fieldErrors.githubOwner) setFieldErrors(prev => ({ ...prev, githubOwner: '' }));
                            }}
                            placeholder="e.g., YourOrg"
                            color={fieldErrors.githubOwner ? 'danger' : undefined}
                          />
                          {fieldErrors.githubOwner && <FormHelperText>{fieldErrors.githubOwner}</FormHelperText>}
                        </FormControl>
                        <FormControl required error={!!fieldErrors.githubRepo}>
                          <FormLabel>GitHub Repo</FormLabel>
                          <Input
                            value={editingConfig.githubRepo || ''}
                            onChange={e => {
                              setEditingConfig({ ...editingConfig, githubRepo: e.target.value });
                              if (fieldErrors.githubRepo) setFieldErrors(prev => ({ ...prev, githubRepo: '' }));
                            }}
                            placeholder="e.g., your-repo"
                            color={fieldErrors.githubRepo ? 'danger' : undefined}
                          />
                          {fieldErrors.githubRepo && <FormHelperText>{fieldErrors.githubRepo}</FormHelperText>}
                        </FormControl>
                      </Box>
                    )}

                    {/* Jira Fields */}
                    {editingConfig.issueTracker === 'jira' && (
                      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(2, 1fr)', mt: 2 }}>
                        <FormControl required error={!!fieldErrors.jiraProjectKey}>
                          <FormLabel>Jira Project Key</FormLabel>
                          <Input
                            value={editingConfig.jiraProjectKey || ''}
                            onChange={e => {
                              setEditingConfig({ ...editingConfig, jiraProjectKey: e.target.value.toUpperCase() });
                              if (fieldErrors.jiraProjectKey) setFieldErrors(prev => ({ ...prev, jiraProjectKey: '' }));
                            }}
                            placeholder="e.g., PROJ"
                            color={fieldErrors.jiraProjectKey ? 'danger' : undefined}
                          />
                          <FormHelperText>
                            {fieldErrors.jiraProjectKey || 'Must be uppercase letters/numbers'}
                          </FormHelperText>
                        </FormControl>
                        <FormControl>
                          <FormLabel>Issue Type</FormLabel>
                          <Input
                            value={editingConfig.jiraIssueType || 'Bug'}
                            onChange={e => setEditingConfig({ ...editingConfig, jiraIssueType: e.target.value })}
                            placeholder="Bug"
                          />
                        </FormControl>
                      </Box>
                    )}
                  </Box>

                  <Divider />

                  {/* Slack Settings */}
                  <Box>
                    <Typography level="title-sm" sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                      <ForumIcon fontSize="small" />
                      Slack Integration
                    </Typography>
                    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(2, 1fr)' }}>
                      <FormControl>
                        <FormLabel>Workspace</FormLabel>
                        <Select
                          value={editingConfig.slackWorkspaceId || ''}
                          onChange={(_, value) =>
                            setEditingConfig({ ...editingConfig, slackWorkspaceId: value || undefined })
                          }
                          placeholder="Select workspace..."
                        >
                          {workspacesData?.workspaces.map(ws => (
                            <Option key={ws.id} value={ws.id}>
                              {ws.name || ws.slackTeamId}
                            </Option>
                          ))}
                        </Select>
                      </FormControl>
                      <FormControl required error={!!fieldErrors.slackChannelId}>
                        <FormLabel>Source Channel ID</FormLabel>
                        <Input
                          value={editingConfig.slackChannelId || ''}
                          onChange={e => {
                            setEditingConfig({ ...editingConfig, slackChannelId: e.target.value });
                            if (fieldErrors.slackChannelId) setFieldErrors(prev => ({ ...prev, slackChannelId: '' }));
                          }}
                          placeholder="e.g., C06CWQNTSAH"
                          color={fieldErrors.slackChannelId ? 'danger' : undefined}
                        />
                        {fieldErrors.slackChannelId && <FormHelperText>{fieldErrors.slackChannelId}</FormHelperText>}
                      </FormControl>
                      <FormControl>
                        <FormLabel>Output Channel ID</FormLabel>
                        <Input
                          value={editingConfig.slackOutputChannelId || ''}
                          onChange={e =>
                            setEditingConfig({ ...editingConfig, slackOutputChannelId: e.target.value || undefined })
                          }
                          placeholder="Same as source if empty"
                        />
                      </FormControl>
                    </Box>
                    {workspacesData && workspacesData.workspaces.length === 0 && (
                      <Alert color="warning" size="sm" sx={{ mt: 2 }}>
                        No Slack workspaces found. Configure via Admin → Slack Workspaces.
                      </Alert>
                    )}
                  </Box>

                  <Divider />

                  {/* Schedule */}
                  <Box>
                    <Typography level="title-sm" sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                      <ScheduleIcon fontSize="small" />
                      Schedule
                    </Typography>
                    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(2, 1fr)' }}>
                      <FormControl>
                        <FormLabel>Run Interval</FormLabel>
                        <Select
                          value={editingConfig.runIntervalHours || 12}
                          onChange={(_, value) => {
                            if (value) setEditingConfig({ ...editingConfig, runIntervalHours: value });
                          }}
                        >
                          <Option value={6}>Every 6 hours</Option>
                          <Option value={12}>Every 12 hours</Option>
                          <Option value={24}>Every 24 hours</Option>
                        </Select>
                        <FormHelperText>{getIntervalDescription(editingConfig.runIntervalHours ?? 12)}</FormHelperText>
                      </FormControl>
                      {!isCreating && (
                        <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                          <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                            Next scheduled run:
                          </Typography>
                          <Typography level="body-sm" fontWeight="lg">
                            {formatNextRun(getNextScheduledRun(editingConfig.runIntervalHours ?? 12))}
                          </Typography>
                        </Box>
                      )}
                      <FormControl sx={{ gridColumn: 'span 2' }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                          <Switch
                            checked={editingConfig.postWhenNoErrors ?? true}
                            onChange={e => setEditingConfig({ ...editingConfig, postWhenNoErrors: e.target.checked })}
                          />
                          <Box>
                            <Typography level="body-sm">Post to Slack when no errors found</Typography>
                            <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                              Confirms system is working, especially useful with frequent intervals
                            </Typography>
                          </Box>
                        </Box>
                      </FormControl>
                    </Box>
                  </Box>

                  <Divider />

                  {/* LLM Settings */}
                  <Box>
                    <Typography level="title-sm" sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                      <SmartToyIcon fontSize="small" />
                      LLM Configuration
                    </Typography>
                    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(2, 1fr)' }}>
                      <FormControl required error={!!fieldErrors.modelId}>
                        <FormLabel>Model</FormLabel>
                        <Select
                          value={editingConfig.modelId || null}
                          onChange={(_, value) => {
                            if (value && !value.startsWith('__header_')) {
                              setEditingConfig({ ...editingConfig, modelId: value });
                              if (fieldErrors.modelId) setFieldErrors(prev => ({ ...prev, modelId: '' }));
                            }
                          }}
                          placeholder="Choose a model..."
                          color={fieldErrors.modelId ? 'danger' : undefined}
                        >
                          {Object.entries(modelsByProvider).map(([provider, providerModels]) => (
                            <React.Fragment key={provider}>
                              <Option value={`__header_${provider}`} disabled>
                                <Typography level="body-xs" sx={{ textTransform: 'uppercase', fontWeight: 'bold' }}>
                                  {provider}
                                </Typography>
                              </Option>
                              {providerModels.map(model => (
                                <Option key={model.id} value={model.id}>
                                  {model.name}
                                </Option>
                              ))}
                            </React.Fragment>
                          ))}
                        </Select>
                        {fieldErrors.modelId && <FormHelperText>{fieldErrors.modelId}</FormHelperText>}
                      </FormControl>
                      <FormControl>
                        <FormLabel>Temperature</FormLabel>
                        <Input
                          type="number"
                          value={editingConfig.temperature ?? 0.3}
                          onChange={e =>
                            setEditingConfig({ ...editingConfig, temperature: parseFloat(e.target.value) || 0.3 })
                          }
                          slotProps={{ input: { min: L.temperature.min, max: L.temperature.max, step: 0.1 } }}
                        />
                        <FormHelperText>
                          Range: {L.temperature.min}-{L.temperature.max} (lower = more consistent)
                        </FormHelperText>
                      </FormControl>
                      <FormControl>
                        <FormLabel>Max Tokens</FormLabel>
                        <Input
                          type="number"
                          value={editingConfig.maxTokens ?? 1000}
                          onChange={e =>
                            setEditingConfig({ ...editingConfig, maxTokens: parseInt(e.target.value) || 1000 })
                          }
                          slotProps={{ input: { min: L.maxTokens.min, max: L.maxTokens.max } }}
                        />
                        <FormHelperText>
                          Range: {L.maxTokens.min.toLocaleString()}-{L.maxTokens.max.toLocaleString()}
                        </FormHelperText>
                      </FormControl>
                      <FormControl>
                        <FormLabel>Timeout (seconds)</FormLabel>
                        <Input
                          type="number"
                          value={Math.round((editingConfig.timeoutMs ?? 60000) / 1000)}
                          onChange={e =>
                            setEditingConfig({ ...editingConfig, timeoutMs: (parseInt(e.target.value) || 60) * 1000 })
                          }
                          slotProps={{ input: { min: L.timeoutMs.min / 1000, max: L.timeoutMs.max / 1000 } }}
                        />
                        <FormHelperText>
                          LLM call timeout. Range: {L.timeoutMs.min / 1000}-{L.timeoutMs.max / 1000} seconds
                        </FormHelperText>
                      </FormControl>
                    </Box>
                  </Box>

                  <Divider />

                  {/* Triage Settings */}
                  <Box>
                    <Typography level="title-sm" sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                      <TuneIcon fontSize="small" />
                      Triage Settings
                    </Typography>
                    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(2, 1fr)' }}>
                      <FormControl>
                        <FormLabel>Max Errors Per Run</FormLabel>
                        <Input
                          type="number"
                          value={editingConfig.maxErrorsPerRun ?? 50}
                          onChange={e =>
                            setEditingConfig({ ...editingConfig, maxErrorsPerRun: parseInt(e.target.value) || 50 })
                          }
                          slotProps={{ input: { min: L.maxErrorsPerRun.min, max: L.maxErrorsPerRun.max } }}
                        />
                        <FormHelperText>
                          Range: {L.maxErrorsPerRun.min}-{L.maxErrorsPerRun.max}
                        </FormHelperText>
                      </FormControl>
                      <FormControl>
                        <FormLabel>Regression Lookback Days</FormLabel>
                        <Input
                          type="number"
                          value={editingConfig.regressionLookbackDays ?? 30}
                          onChange={e =>
                            setEditingConfig({
                              ...editingConfig,
                              regressionLookbackDays: parseInt(e.target.value) || 30,
                            })
                          }
                          slotProps={{
                            input: { min: L.regressionLookbackDays.min, max: L.regressionLookbackDays.max },
                          }}
                        />
                        <FormHelperText>
                          How far back to check for closed issues. Range: {L.regressionLookbackDays.min}-
                          {L.regressionLookbackDays.max} days
                        </FormHelperText>
                      </FormControl>
                      <FormControl>
                        <FormLabel>Regression Grace Period (hours)</FormLabel>
                        <Input
                          type="number"
                          value={editingConfig.regressionGracePeriodHours ?? L.regressionGracePeriodHours.default}
                          onChange={e =>
                            setEditingConfig({
                              ...editingConfig,
                              regressionGracePeriodHours:
                                parseInt(e.target.value) || L.regressionGracePeriodHours.default,
                            })
                          }
                          slotProps={{
                            input: { min: L.regressionGracePeriodHours.min, max: L.regressionGracePeriodHours.max },
                          }}
                        />
                        <FormHelperText>
                          Skip alerts matching issues closed within this period. Range:{' '}
                          {L.regressionGracePeriodHours.min}-{L.regressionGracePeriodHours.max} hours
                        </FormHelperText>
                      </FormControl>
                      <FormControl sx={{ gridColumn: 'span 2' }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                          <Switch
                            checked={editingConfig.autoCreateIssues ?? false}
                            onChange={e => setEditingConfig({ ...editingConfig, autoCreateIssues: e.target.checked })}
                          />
                          <Box>
                            <Typography level="body-sm">Auto-create Issues</Typography>
                            <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                              Automatically create issues for new errors
                            </Typography>
                          </Box>
                        </Box>
                      </FormControl>
                    </Box>
                  </Box>

                  <Divider />

                  {/* Custom Prompt Template */}
                  <Box>
                    <Typography level="title-sm" sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                      <CodeIcon fontSize="small" />
                      Custom Prompt Template (Optional)
                    </Typography>

                    {/* Available Variables */}
                    <Box sx={{ mb: 2 }}>
                      <Typography level="body-xs" sx={{ color: 'text.secondary', mb: 1 }}>
                        Available variables:
                      </Typography>
                      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                        {Object.entries(TEMPLATE_VARIABLE_DOCS).map(([variable, description]) => (
                          <Tooltip key={variable} title={description}>
                            <Chip
                              size="sm"
                              variant="outlined"
                              onClick={() => handleInsertVariable(variable)}
                              sx={{ fontFamily: 'monospace', cursor: 'pointer' }}
                              endDecorator={
                                <IconButton
                                  size="sm"
                                  variant="plain"
                                  onClick={e => {
                                    e.stopPropagation();
                                    navigator.clipboard.writeText(`{{${variable}}}`);
                                    toast.success(`Copied {{${variable}}} to clipboard`);
                                  }}
                                >
                                  <ContentCopyIcon sx={{ fontSize: 14 }} />
                                </IconButton>
                              }
                            >
                              {`{{${variable}}}`}
                            </Chip>
                          </Tooltip>
                        ))}
                      </Box>
                    </Box>

                    {/* Template Input */}
                    <FormControl>
                      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                        <FormLabel sx={{ mb: 0 }}>Prompt Template</FormLabel>
                        <Button
                          size="sm"
                          variant="outlined"
                          startDecorator={<VisibilityIcon />}
                          onClick={() => setDefaultTemplateOpen(true)}
                        >
                          View Default Template
                        </Button>
                      </Box>
                      <Textarea
                        slotProps={{
                          textarea: {
                            ref: textareaRef,
                          },
                        }}
                        minRows={4}
                        maxRows={10}
                        value={editingConfig.promptTemplate || ''}
                        onChange={e =>
                          setEditingConfig({ ...editingConfig, promptTemplate: e.target.value || undefined })
                        }
                        placeholder="Leave empty to use the default template..."
                        sx={{ fontFamily: 'monospace', fontSize: 'sm' }}
                      />
                      <FormHelperText>
                        Customize the prompt used for error triage. Leave empty to use the default template.
                      </FormHelperText>
                    </FormControl>
                  </Box>
                </Box>
              </Box>

              {/* Footer */}
              <Box
                sx={{
                  p: 2,
                  borderTop: '1px solid',
                  borderColor: 'divider',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <Box>
                  {!isCreating && (
                    <Button
                      variant="outlined"
                      color="danger"
                      startDecorator={<DeleteIcon />}
                      onClick={() => setDeleteConfirmOpen(true)}
                    >
                      Delete
                    </Button>
                  )}
                </Box>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                  {isDirty && (
                    <Chip color="warning" variant="outlined" size="sm">
                      Unsaved changes
                    </Chip>
                  )}
                  {!isCreating && (
                    <Button
                      variant="outlined"
                      color="neutral"
                      size="sm"
                      disabled={!isDirty}
                      onClick={() => {
                        if (selectedConfig) {
                          setEditingConfig({ ...selectedConfig });
                        }
                      }}
                    >
                      Reset
                    </Button>
                  )}
                  <Button
                    variant="solid"
                    color="primary"
                    size="sm"
                    startDecorator={
                      createMutation.isPending || updateMutation.isPending ? (
                        <CircularProgress size="sm" />
                      ) : (
                        <SaveIcon />
                      )
                    }
                    onClick={handleSave}
                    disabled={createMutation.isPending || updateMutation.isPending || !isDirty}
                  >
                    {isCreating ? 'Create' : 'Save'}
                  </Button>
                </Box>
              </Box>
            </Box>
          )}
        </Card>
      </Box>

      {/* Delete Confirmation Modal */}
      <Modal open={deleteConfirmOpen} onClose={() => setDeleteConfirmOpen(false)}>
        <ModalDialog variant="outlined" sx={{ maxWidth: 400 }}>
          <ModalClose />
          <Typography level="h4" sx={{ mb: 2 }}>
            Delete Configuration?
          </Typography>
          <Typography level="body-sm" sx={{ mb: 3 }}>
            Are you sure you want to delete &ldquo;{editingConfig?.name}&rdquo;? This action cannot be undone.
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
            <Button variant="plain" color="neutral" onClick={() => setDeleteConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="solid"
              color="danger"
              startDecorator={deleteMutation.isPending ? <CircularProgress size="sm" /> : <DeleteIcon />}
              onClick={() => selectedConfigId && deleteMutation.mutate(selectedConfigId)}
              disabled={deleteMutation.isPending}
            >
              Delete
            </Button>
          </Box>
        </ModalDialog>
      </Modal>

      {/* Trigger Confirmation Modal */}
      <Modal open={triggerConfirmOpen} onClose={() => setTriggerConfirmOpen(false)}>
        <ModalDialog variant="outlined" sx={{ maxWidth: 400 }}>
          <ModalClose />
          <Typography level="h4" sx={{ mb: 2 }}>
            {triggerDryRun ? 'Run Dry Test?' : 'Run Triage Now?'}
          </Typography>
          <Typography level="body-sm" sx={{ mb: 2 }}>
            {triggerDryRun
              ? 'This will analyze errors without creating any issues.'
              : editingConfig?.autoCreateIssues
                ? 'This will create real issues for any new errors found. This action cannot be undone.'
                : 'This will analyze errors and post a triage summary to Slack. No issues will be auto-created since that setting is disabled.'}
          </Typography>
          <FormControl sx={{ mb: 2 }}>
            <FormLabel id="lookback-hours-label">Lookback Period</FormLabel>
            <RadioGroup
              aria-labelledby="lookback-hours-label"
              value={effectiveLookbackHours}
              onChange={e => setTriggerLookbackHours(Number(e.target.value))}
              sx={{ gap: 1 }}
            >
              <Radio value={6} label="Last 6 hours" data-testid="lookback-6h-radio" />
              <Radio
                value={selectedConfig?.runIntervalHours ?? 12}
                label={`Last ${selectedConfig?.runIntervalHours ?? 12} hours (matches schedule)`}
                data-testid="lookback-config-radio"
              />
              <Radio value={24} label="Last 24 hours" data-testid="lookback-24h-radio" />
              <Radio value={48} label="Last 48 hours" data-testid="lookback-48h-radio" />
            </RadioGroup>
            <FormHelperText>How far back to search for Slack alerts</FormHelperText>
          </FormControl>
          {!triggerDryRun && editingConfig?.autoCreateIssues && (
            <Alert color="warning" variant="outlined" sx={{ mb: 2 }}>
              <Typography level="body-sm">Real issues will be created in {editingConfig?.issueTracker}!</Typography>
            </Alert>
          )}
          <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
            <Button variant="plain" color="neutral" onClick={() => setTriggerConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="solid"
              color={triggerDryRun ? 'primary' : 'success'}
              startDecorator={triggerMutation.isPending ? <CircularProgress size="sm" /> : <PlayArrowIcon />}
              onClick={() =>
                selectedConfigId &&
                triggerMutation.mutate({
                  id: selectedConfigId,
                  dryRun: triggerDryRun,
                  lookbackHours: effectiveLookbackHours,
                })
              }
              disabled={triggerMutation.isPending}
            >
              {triggerDryRun ? 'Run Dry Test' : 'Run Now'}
            </Button>
          </Box>
        </ModalDialog>
      </Modal>

      {/* Default Template Modal */}
      <Modal open={defaultTemplateOpen} onClose={() => setDefaultTemplateOpen(false)}>
        <ModalDialog variant="outlined" sx={{ maxWidth: 700, maxHeight: '80vh' }}>
          <ModalClose />
          <Typography level="h4" sx={{ mb: 2 }}>
            Default Prompt Template
          </Typography>
          <Box
            sx={{
              p: 2,
              bgcolor: 'background.level1',
              borderRadius: 'sm',
              overflow: 'auto',
              maxHeight: '60vh',
            }}
          >
            <Typography
              level="body-sm"
              sx={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            >
              {DEFAULT_PROMPT_TEMPLATE}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', mt: 2 }}>
            <Button
              variant="outlined"
              startDecorator={<ContentCopyIcon />}
              onClick={() => {
                navigator.clipboard.writeText(DEFAULT_PROMPT_TEMPLATE);
                toast.success('Template copied to clipboard');
              }}
            >
              Copy
            </Button>
            <Button variant="solid" onClick={() => setDefaultTemplateOpen(false)}>
              Close
            </Button>
          </Box>
        </ModalDialog>
      </Modal>

      {/* Dry Run Results Modal */}
      <Modal open={dryRunResultOpen} onClose={() => setDryRunResultOpen(false)}>
        <ModalDialog variant="outlined" sx={{ maxWidth: 900, maxHeight: '90vh', overflow: 'auto' }}>
          <ModalClose />
          <Typography level="h4" sx={{ mb: 1 }}>
            Dry Run Results
          </Typography>
          {dryRunResultData && (
            <>
              <Typography level="body-sm" sx={{ color: 'text.secondary', mb: 2 }}>
                {dryRunResultData.configName} • Last {dryRunResultData.result.lookbackHours} hours
              </Typography>

              {/* Status Alert */}
              <Alert
                color={dryRunResultData.result.status === 'success' ? 'success' : 'danger'}
                variant="outlined"
                sx={{ mb: 2 }}
              >
                {dryRunResultData.result.status === 'success'
                  ? 'Dry run completed successfully'
                  : `Dry run failed: ${dryRunResultData.result.error || 'Unknown error'}`}
              </Alert>

              {/* Summary Stats */}
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 2, mb: 3 }}>
                <Card variant="outlined" sx={{ p: 2, textAlign: 'center' }}>
                  <Typography level="h3">{dryRunResultData.result.alertsFetched}</Typography>
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    Alerts Fetched
                  </Typography>
                </Card>
                <Card variant="outlined" sx={{ p: 2, textAlign: 'center' }}>
                  <Typography level="h3" sx={{ color: 'success.500' }}>
                    {dryRunResultData.result.issuesWouldCreate.length}
                  </Typography>
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    Would Create
                  </Typography>
                </Card>
                <Card variant="outlined" sx={{ p: 2, textAlign: 'center' }}>
                  <Typography level="h3" sx={{ color: 'neutral.500' }}>
                    {dryRunResultData.result.summary.duplicates}
                  </Typography>
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    Would Skip
                  </Typography>
                </Card>
                <Card variant="outlined" sx={{ p: 2, textAlign: 'center' }}>
                  <Typography level="h3">{dryRunResultData.result.existingIssuesFound}</Typography>
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    Existing Issues
                  </Typography>
                </Card>
              </Box>

              {/* Priority Breakdown */}
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 3 }}>
                <Chip color="danger" variant="solid" size="sm">
                  P0: {dryRunResultData.result.summary.p0Count}
                </Chip>
                <Chip color="warning" variant="solid" size="sm">
                  P1: {dryRunResultData.result.summary.p1Count}
                </Chip>
                <Chip color="primary" variant="solid" size="sm">
                  P2: {dryRunResultData.result.summary.p2Count}
                </Chip>
                <Chip color="success" variant="solid" size="sm">
                  P3: {dryRunResultData.result.summary.p3Count}
                </Chip>
                {dryRunResultData.result.summary.regressions > 0 && (
                  <Chip color="danger" variant="outlined" size="sm">
                    Regressions: {dryRunResultData.result.summary.regressions}
                  </Chip>
                )}
              </Box>

              {/* Issues Would Create */}
              {dryRunResultData.result.issuesWouldCreate.length > 0 && (
                <Box sx={{ mb: 3 }}>
                  <Typography level="title-sm" sx={{ mb: 1 }}>
                    Issues That Would Be Created ({dryRunResultData.result.issuesWouldCreate.length})
                  </Typography>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 200, overflow: 'auto' }}>
                    {dryRunResultData.result.issuesWouldCreate.map((issue, idx) => (
                      <Box
                        key={idx}
                        sx={{
                          p: 1.5,
                          borderRadius: 'sm',
                          border: '1px solid',
                          borderColor: 'divider',
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 1,
                        }}
                      >
                        <Chip
                          size="sm"
                          color={
                            issue.priority === 'P0'
                              ? 'danger'
                              : issue.priority === 'P1'
                                ? 'warning'
                                : issue.priority === 'P2'
                                  ? 'primary'
                                  : 'success'
                          }
                        >
                          {issue.priority}
                        </Chip>
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography level="body-sm" fontWeight="lg" sx={{ wordBreak: 'break-word' }}>
                            {issue.title}
                          </Typography>
                          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
                            {issue.isRegression && (
                              <Chip size="sm" color="danger" variant="outlined">
                                Regression
                              </Chip>
                            )}
                            {issue.occurrenceCount > 1 && (
                              <Chip size="sm" variant="outlined">
                                {issue.occurrenceCount}x
                              </Chip>
                            )}
                            <Chip size="sm" variant="soft">
                              {issue.category}
                            </Chip>
                          </Box>
                        </Box>
                      </Box>
                    ))}
                  </Box>
                </Box>
              )}

              {/* Issues Would Skip */}
              {dryRunResultData.result.issuesWouldSkip.length > 0 && (
                <Box sx={{ mb: 3 }}>
                  <Typography level="title-sm" sx={{ mb: 1 }}>
                    Issues That Would Be Skipped ({dryRunResultData.result.issuesWouldSkip.length})
                  </Typography>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 150, overflow: 'auto' }}>
                    {dryRunResultData.result.issuesWouldSkip.map((issue, idx) => (
                      <Box
                        key={idx}
                        sx={{
                          p: 1.5,
                          borderRadius: 'sm',
                          bgcolor: 'background.level1',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1,
                        }}
                      >
                        <Chip size="sm" variant="outlined">
                          {issue.priority}
                        </Chip>
                        <Typography level="body-sm" sx={{ flex: 1, minWidth: 0 }}>
                          {issue.title}
                        </Typography>
                        <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                          → #{issue.matchesExisting.issueNumber}
                        </Typography>
                      </Box>
                    ))}
                  </Box>
                </Box>
              )}

              {/* LLM Details */}
              <Box sx={{ mb: 3 }}>
                <Typography level="title-sm" sx={{ mb: 1 }}>
                  LLM Details
                </Typography>
                <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                  <Typography level="body-sm">
                    <strong>Model:</strong> {dryRunResultData.result.llmDetails.modelId}
                  </Typography>
                  <Typography level="body-sm">
                    <strong>Est. Cost:</strong> {dryRunResultData.result.llmDetails.estimatedCost}
                  </Typography>
                  <Typography level="body-sm">
                    <strong>Prompt:</strong> {dryRunResultData.result.llmDetails.promptLength.toLocaleString()} chars
                  </Typography>
                  <Typography level="body-sm">
                    <strong>Response:</strong> {dryRunResultData.result.llmDetails.responseLength.toLocaleString()}{' '}
                    chars
                  </Typography>
                </Box>
              </Box>

              {/* Health Assessment */}
              {dryRunResultData.result.summary.healthAssessment && (
                <Box sx={{ mb: 2 }}>
                  <Typography level="title-sm" sx={{ mb: 1 }}>
                    Health Assessment
                  </Typography>
                  <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap' }}>
                    {dryRunResultData.result.summary.healthAssessment}
                  </Typography>
                </Box>
              )}

              <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="solid" onClick={() => setDryRunResultOpen(false)}>
                  Close
                </Button>
              </Box>
            </>
          )}
        </ModalDialog>
      </Modal>
    </Box>
  );
};

export default AdminLiveOpsTriageMultiConfigTab;
