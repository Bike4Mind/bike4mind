import { useState, type ReactNode } from 'react';
import { isAxiosError } from 'axios';
import {
  Box,
  Typography,
  Stack,
  Select,
  Option,
  Input,
  Button,
  Grid,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  AccordionGroup,
  Tooltip,
  Switch,
  Alert,
  DialogContent,
  Divider,
  FormControl,
  FormLabel,
  Textarea,
  IconButton,
  List,
  ListItem,
  FormHelperText,
} from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AnalyticsIcon from '@mui/icons-material/Analytics';
import GitHubIcon from '@mui/icons-material/GitHub';
import LinkIcon from '@mui/icons-material/Link';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import TokenDistributionBar from '@client/app/components/common/TokenDistributionBar';
import {
  ContextTelemetryAlertsSchema,
  type ContextTelemetry,
  type AnomalySeverity,
  type PrimaryAnomaly,
  type ContextTelemetryAlerts,
  type RecommendedAction,
  type SubagentTelemetry,
  type ToolTelemetry,
} from '@bike4mind/common';
import {
  useContextTelemetry,
  useAnalyzeTelemetry,
  useCreateTelemetryIssue,
  useIntegrationStatus,
  useDryRunResults,
  useTestConfig,
  type ContextTelemetryEntry,
  type TelemetryAnalysis,
  type HistoricalBaselines,
  type IntegrationHealthResponse,
  type HealthCheckItem,
  type DryRunResult,
} from '@client/app/hooks/useContextTelemetry';
import { useGetSettingsValue, useUpdateSettings } from '@client/app/hooks/data/settings';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import {
  AdminDialog,
  AdminDialogFooter,
  AdminPageHeader,
  DataTable,
  EmptyState,
  ErrorState,
  Fact,
  FilterChip,
  FilterInputLabel,
  FilterToolbar,
  InlineBar,
  LoadingState,
  SectionCard,
  SettingsSection,
  StatStrip,
  StatTile,
  StatusChip,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';
import { SettingsDraftProvider, useSettingsDraft } from './SettingsDraftProvider';

interface SlackWorkspace {
  id: string;
  name: string;
  slackTeamId: string;
  isActive: boolean;
}

// Default settings derived from schema (module-level to avoid re-parsing on every render)
const DEFAULT_ALERT_SETTINGS = ContextTelemetryAlertsSchema.parse({});

// One tone per severity across the page, on the guide's risk scale (DESIGN_GUIDE section 2, "Status
// tones": high risk is bad, medium risk is warn, low risk is neutral).
const SEVERITY_TONE: Partial<Record<string, AdminStatusTone>> = {
  critical: 'bad',
  high: 'bad',
  medium: 'warn',
  low: 'neutral',
};
const severityTone = (severity: string): AdminStatusTone => SEVERITY_TONE[severity] ?? 'neutral';
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const RECOMMENDED_ACTIONS: Record<RecommendedAction, { label: string; tone: AdminStatusTone }> = {
  no_action: { label: 'No action needed', tone: 'good' },
  monitor: { label: 'Monitor', tone: 'neutral' },
  investigate_soon: { label: 'Investigate soon', tone: 'warn' },
  immediate_action: { label: 'Immediate action', tone: 'bad' },
};

const PRIORITY_TONE: Partial<Record<string, AdminStatusTone>> = { P0: 'bad', P1: 'warn', P2: 'warn', P3: 'neutral' };

const HEALTH_CHECK_STATUS: Record<HealthCheckItem['status'], { label: string; tone: AdminStatusTone }> = {
  ok: { label: 'OK', tone: 'good' },
  warning: { label: 'Warning', tone: 'warn' },
  error: { label: 'Error', tone: 'bad' },
};

const OVERALL_HEALTH: Record<IntegrationHealthResponse['overall'], { label: string; tone: AdminStatusTone }> = {
  healthy: { label: 'Healthy', tone: 'good' },
  degraded: { label: 'Degraded', tone: 'warn' },
  unhealthy: { label: 'Unhealthy', tone: 'bad' },
};

const SEVERITIES: AnomalySeverity[] = ['critical', 'high', 'medium', 'low'];

const ANOMALY_TYPES: { value: PrimaryAnomaly; label: string }[] = [
  { value: 'context_overflow', label: 'Context overflow' },
  { value: 'high_utilization', label: 'High utilization' },
  { value: 'high_truncation', label: 'High truncation' },
  { value: 'tool_failure', label: 'Tool failure' },
  { value: 'subagent_timeout', label: 'Subagent timeout' },
  { value: 'slow_response', label: 'Slow response' },
  { value: 'multiple', label: 'Multiple' },
];

// Unset means the server default, which leaves out entries scoring 0.
const MIN_SCORE_OPTIONS = [
  { value: '0', label: 'Any, including 0' },
  { value: '30', label: '30+' },
  { value: '50', label: '50+' },
  { value: '70', label: '70+' },
];

// Benign turns are stored as severity 'low' (there is no benign tier), so they are labelled
// separately rather than sharing the real low-severity chip.
const SeverityChip = ({ severity, benign }: { severity: AnomalySeverity; benign?: boolean }) => (
  <StatusChip
    tone={benign ? 'neutral' : severityTone(severity)}
    label={benign ? 'Benign' : `${capitalize(severity)} severity`}
    data-testid="context-inspector-severity-chip"
  />
);

const AnomalyIndicators = ({ anomalies }: { anomalies: ContextTelemetry['anomalies'] }) => {
  const activeAnomalies = [
    anomalies.contextOverflow && 'Context overflow',
    anomalies.criticalUtilization && 'Critical utilization (95%+)',
    anomalies.highUtilization && !anomalies.criticalUtilization && 'High utilization (90%+)',
    anomalies.criticalTruncation && 'Critical truncation (75%+)',
    anomalies.highTruncation && !anomalies.criticalTruncation && 'High truncation (50%+)',
    anomalies.toolFailureSpike && 'Tool failure spike',
    anomalies.toolTimeout && 'Tool timeout',
    anomalies.subagentTimeout && 'Subagent timeout',
    anomalies.slowTotalResponse && 'Slow response',
    anomalies.slowFirstToken && 'Slow first token',
  ].filter((x): x is string => Boolean(x));

  if (activeAnomalies.length === 0) {
    return <StatusChip tone="good" label="No anomalies" data-testid="context-inspector-anomaly-chip" />;
  }

  return (
    <Stack direction="row" gap={0.5} flexWrap="wrap">
      {activeAnomalies.map(anomaly => (
        <StatusChip key={anomaly} tone="warn" label={anomaly} data-testid="context-inspector-anomaly-chip" />
      ))}
    </Stack>
  );
};

// Analysis Modal Component
const AnalysisModal = ({
  open,
  onClose,
  analysis,
  isLoading,
  error,
  baselines,
  analysisSource,
  cached,
  cachedAt,
  onReanalyze,
}: {
  open: boolean;
  onClose: () => void;
  analysis: TelemetryAnalysis | null;
  isLoading: boolean;
  error: Error | null;
  baselines?: HistoricalBaselines | null;
  analysisSource?: 'llm' | 'rule-based';
  cached?: boolean;
  cachedAt?: string;
  onReanalyze?: () => void;
}) => {
  const summaryTone = analysis ? severityTone(analysis.severity) : 'neutral';
  return (
    <AdminDialog
      open={open}
      onClose={onClose}
      title="Anomaly analysis"
      width={640}
      data-testid="context-inspector-analysis-dialog"
    >
      <DialogContent sx={{ gap: 2 }}>
        {isLoading && <LoadingState label="Analyzing the entry" testId="context-inspector-analysis-loading" />}

        {error && <Alert color="danger">Failed to analyze: {error.message}</Alert>}

        {analysis && (
          <>
            <Alert
              color={summaryTone === 'bad' ? 'danger' : summaryTone === 'warn' ? 'warning' : 'neutral'}
              data-testid="context-inspector-analysis-summary"
            >
              {analysis.summary}
            </Alert>

            <Box>
              <Stack direction="row" gap={1} flexWrap="wrap">
                <StatusChip
                  tone={summaryTone}
                  label={`${capitalize(analysis.severity)} severity`}
                  data-testid="context-inspector-analysis-severity"
                />
                {analysis.recommendedAction && (
                  <StatusChip
                    tone={RECOMMENDED_ACTIONS[analysis.recommendedAction].tone}
                    label={RECOMMENDED_ACTIONS[analysis.recommendedAction].label}
                    data-testid="context-inspector-analysis-action"
                  />
                )}
              </Stack>
              <Typography level="body-sm" sx={{ mt: 1 }}>
                {analysis.estimatedImpact}
              </Typography>
            </Box>

            <SectionCard title="Findings" body="custom" data-testid="context-inspector-findings">
              <List marker="disc" size="sm" sx={{ px: 2, py: 1 }}>
                {analysis.findings.map((finding, idx) => (
                  <ListItem key={`finding-${idx}`}>{finding}</ListItem>
                ))}
              </List>
            </SectionCard>

            <SectionCard title="Recommendations" body="custom" data-testid="context-inspector-recommendations">
              <List marker="disc" size="sm" sx={{ px: 2, py: 1 }}>
                {analysis.recommendations.map((rec, idx) => (
                  <ListItem key={`rec-${idx}`}>{rec}</ListItem>
                ))}
              </List>
            </SectionCard>

            {baselines && (
              <SectionCard
                title="Historical baselines"
                action={
                  <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                    {baselines.windowDays}-day window, N={baselines.sampleCount}
                  </Typography>
                }
                data-testid="context-inspector-baselines"
              >
                <Fact label="Avg response time">{((baselines.avgResponseTimeMs || 0) / 1000).toFixed(1)}s</Fact>
                <Fact label="P95 response time">{((baselines.p95ResponseTimeMs || 0) / 1000).toFixed(1)}s</Fact>
                <Fact label="Normal utilization">
                  {`${baselines.utilizationRange?.low ?? 0}% \u2013 ${baselines.utilizationRange?.high ?? 0}% (mean \u00b1 1\u03c3)`}
                </Fact>
              </SectionCard>
            )}

            {/* Analysis Source & Cache Info */}
            <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
              {analysisSource && (
                <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                  Analysis source: {analysisSource}
                  {cached && cachedAt && ` (cached ${new Date(cachedAt).toLocaleString()})`}
                </Typography>
              )}
              {cached && onReanalyze && (
                <Button
                  size="sm"
                  variant="outlined"
                  color="neutral"
                  onClick={onReanalyze}
                  disabled={isLoading}
                  data-testid="context-inspector-reanalyze-btn"
                >
                  Re-analyze
                </Button>
              )}
            </Stack>
          </>
        )}
      </DialogContent>
    </AdminDialog>
  );
};

// Create Issue Modal Component
const CreateIssueModal = ({
  open,
  onClose,
  entryId,
  onSuccess,
  onDuplicate,
  configuredRepo,
}: {
  open: boolean;
  onClose: () => void;
  entryId: string;
  onSuccess: (url: string) => void;
  onDuplicate: (url: string, issueNumber: number) => void;
  configuredRepo: { owner: string; repo: string } | null;
}) => {
  const [additionalContext, setAdditionalContext] = useState('');
  const createIssue = useCreateTelemetryIssue();

  const repository = configuredRepo ? `${configuredRepo.owner}/${configuredRepo.repo}` : '';

  const handleClose = () => {
    createIssue.reset();
    setAdditionalContext('');
    onClose();
  };

  const handleSubmit = () => {
    if (!repository) return;
    createIssue.mutate(
      { id: entryId, repository, additionalContext: additionalContext || undefined },
      {
        onSuccess: data => {
          onSuccess(data.issue.url);
          handleClose();
        },
        onError: error => {
          if (isAxiosError(error) && error.response?.status === 409) {
            const data = error.response.data as {
              existingIssue?: { number: number; url: string };
            };
            const url = data.existingIssue?.url || '';
            const issueNumber = data.existingIssue?.number || 0;
            onDuplicate(url, issueNumber);
            handleClose();
          }
        },
      }
    );
  };

  return (
    <AdminDialog
      open={open}
      onClose={handleClose}
      title="Create GitHub issue"
      width={500}
      data-testid="context-inspector-create-issue-dialog"
    >
      <DialogContent sx={{ gap: 2 }}>
        {!configuredRepo ? (
          <Alert color="warning" data-testid="context-inspector-no-repo-banner">
            No GitHub repository is configured. Set the GitHub owner and repo under Alert settings, then try again.
          </Alert>
        ) : (
          <>
            <FormControl>
              <FormLabel>Repository</FormLabel>
              <Input value={repository} disabled />
              <FormHelperText>Configured under Alert settings</FormHelperText>
            </FormControl>

            <FormControl>
              <FormLabel>Additional context (optional)</FormLabel>
              <Textarea
                value={additionalContext}
                onChange={e => setAdditionalContext(e.target.value)}
                minRows={3}
                maxRows={6}
                placeholder="Add any additional context or notes about this anomaly..."
                slotProps={{ textarea: { maxLength: 5000 } }}
              />
              <FormHelperText>{additionalContext.length}/5000 characters</FormHelperText>
            </FormControl>

            {createIssue.error && <Alert color="danger">Failed to create issue: {createIssue.error.message}</Alert>}
          </>
        )}
      </DialogContent>
      {configuredRepo && (
        <AdminDialogFooter>
          <Button
            variant="plain"
            color="neutral"
            onClick={handleClose}
            data-testid="context-inspector-create-issue-cancel-btn"
          >
            Cancel
          </Button>
          <Button
            startDecorator={<GitHubIcon />}
            onClick={handleSubmit}
            loading={createIssue.isPending}
            data-testid="context-inspector-create-issue-submit-btn"
          >
            Create issue
          </Button>
        </AdminDialogFooter>
      )}
    </AdminDialog>
  );
};

// Issue Created / Existing Issue Found Modal
const IssueCreatedModal = ({
  open,
  onClose,
  issueUrl,
  isDuplicate,
  issueNumber,
}: {
  open: boolean;
  onClose: () => void;
  issueUrl: string;
  isDuplicate?: boolean;
  issueNumber?: number;
}) => {
  const heading = isDuplicate ? 'Existing issue found' : 'Issue created';
  const description = isDuplicate
    ? `A GitHub issue already exists for this anomaly${issueNumber && issueNumber > 0 ? `: #${issueNumber}` : ''}.`
    : 'The GitHub issue has been created successfully.';
  const buttonLabel = isDuplicate ? 'View existing issue on GitHub' : 'View issue on GitHub';

  return (
    <AdminDialog open={open} onClose={onClose} title={heading} data-testid="context-inspector-issue-created-dialog">
      <DialogContent>
        <Typography level="body-sm">{description}</Typography>
      </DialogContent>
      <AdminDialogFooter>
        <Button
          component="a"
          href={issueUrl}
          target="_blank"
          rel="noopener noreferrer"
          startDecorator={<LinkIcon />}
          data-testid="context-inspector-issue-link"
        >
          {buttonLabel}
        </Button>
      </AdminDialogFooter>
    </AdminDialog>
  );
};

// One integration check: its name, a status chip and the detail line, without a card of its own.
const HealthCheckRow = ({ check }: { check: HealthCheckItem }) => {
  return (
    <Box sx={{ minWidth: 0 }} data-testid="context-inspector-health-check">
      <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
        <Typography level="title-sm" sx={{ color: 'admin.ink' }}>
          {check.name}
        </Typography>
        <StatusChip tone={HEALTH_CHECK_STATUS[check.status].tone} label={HEALTH_CHECK_STATUS[check.status].label} />
      </Stack>
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted', wordBreak: 'break-word' }}>
        {check.message}
      </Typography>
    </Box>
  );
};

const DRY_RUN_COLUMNS: DataColumn<DryRunResult>[] = [
  {
    id: 'source',
    label: 'Source',
    width: '6rem',
    render: result => (
      <StatusChip tone="neutral" label={result.source === 'test' ? 'Test' : 'Real'} data-testid="dry-run-source-chip" />
    ),
  },
  {
    id: 'priority',
    label: 'Priority',
    width: '6rem',
    render: result => (
      <StatusChip
        tone={PRIORITY_TONE[result.action.priority] ?? 'neutral'}
        label={result.action.priority}
        data-testid="dry-run-priority-chip"
      />
    ),
  },
  {
    id: 'anomaly',
    label: 'Anomaly',
    render: result => (
      <Box sx={{ minWidth: 0 }}>
        <Typography level="body-sm" noWrap>
          {result.telemetrySummary.primaryAnomaly} (score: {result.telemetrySummary.anomalyScore})
        </Typography>
        <Typography level="body-xs" noWrap sx={{ color: 'admin.inkMuted' }}>
          {result.telemetrySummary.modelId} &bull; {result.telemetrySummary.provider}
        </Typography>
      </Box>
    ),
  },
  {
    id: 'outcome',
    label: 'Outcome',
    render: result => (
      <Box sx={{ minWidth: 0 }}>
        <Stack direction="row" gap={0.5}>
          {result.action.wouldCreateIssue ? (
            <StatusChip tone="info" label="Would create issue" data-testid="dry-run-create-issue-chip" />
          ) : result.action.isDuplicate ? (
            <StatusChip
              tone="neutral"
              label={`Duplicate of #${result.action.matchedIssueNumber}`}
              data-testid="dry-run-duplicate-chip"
            />
          ) : null}
          {result.action.isRegression && (
            <StatusChip
              tone="bad"
              label={`Regression from #${result.action.regressedFromIssue}`}
              data-testid="dry-run-regression-chip"
            />
          )}
          {result.action.wouldSendSlackAlert && (
            <StatusChip tone="info" label="Would send Slack" data-testid="dry-run-slack-chip" />
          )}
        </Stack>
        {result.action.wouldCreateIssue && result.action.issueTitle && (
          <Typography level="body-xs" noWrap sx={{ color: 'admin.inkMuted', maxWidth: '24rem' }}>
            Title: {result.action.issueTitle}
          </Typography>
        )}
      </Box>
    ),
  },
  {
    id: 'time',
    label: 'Time',
    width: '7rem',
    render: result => (
      <Typography level="body-sm" noWrap>
        {new Date(result.timestamp).toLocaleTimeString()}
      </Typography>
    ),
  },
];

// Dry Run Section Component
const DryRunSection = () => {
  const [selectedSampleType, setSelectedSampleType] = useState<'critical' | 'high' | 'medium' | 'low'>('high');

  const {
    data: dryRunResults,
    isLoading: isLoadingResults,
    isError: isResultsError,
    refetch: refetchResults,
  } = useDryRunResults({ limit: 10 });
  const testConfigMutation = useTestConfig();

  const handleTest = () => {
    testConfigMutation.mutate(
      { useSample: true, sampleType: selectedSampleType },
      {
        onSuccess: () => {
          refetchResults();
        },
      }
    );
  };

  return (
    <>
      <Divider />
      <Stack gap={1.5} data-testid="dry-run-section">
        <Box>
          <Subheading>Dry run testing</Subheading>
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
            Test your configuration without creating actual issues or sending alerts.
          </Typography>
        </Box>

        <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
          <Button
            data-testid="dry-run-test-btn"
            size="sm"
            variant="outlined"
            startDecorator={<PlayArrowIcon />}
            onClick={handleTest}
            loading={testConfigMutation.isPending}
          >
            Test with sample data
          </Button>
          <Select
            data-testid="dry-run-sample-type-select"
            size="sm"
            value={selectedSampleType}
            onChange={(_, v) => v && setSelectedSampleType(v)}
            aria-label="Sample severity"
            sx={{ minWidth: '7.5rem' }}
          >
            <Option value="critical">Critical</Option>
            <Option value="high">High</Option>
            <Option value="medium">Medium</Option>
            <Option value="low">Low</Option>
          </Select>
        </Stack>

        {testConfigMutation.isError && (
          <Alert color="danger">Test failed: {testConfigMutation.error?.message || 'Unknown error'}</Alert>
        )}

        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Subheading>Recent dry run results</Subheading>
          <IconButton
            data-testid="dry-run-refresh-btn"
            size="sm"
            variant="plain"
            aria-label="Refresh dry run results"
            onClick={() => refetchResults()}
          >
            <RefreshIcon />
          </IconButton>
        </Stack>
        <Box data-testid="dry-run-results-panel">
          <DataTable
            label="Recent dry run results"
            rows={dryRunResults?.results ?? []}
            columns={DRY_RUN_COLUMNS}
            getRowId={result => result._id}
            rowTestId={() => 'dry-run-result-card'}
            loading={isLoadingResults}
            error={isResultsError ? 'Could not load dry run results.' : undefined}
            onRetry={() => void refetchResults()}
            empty={
              <EmptyState
                title="No dry run results yet"
                description="Turn on dry run mode and trigger some anomalies, or test with sample data above."
                action={null}
              />
            }
            pagination={false}
            maxHeight="none"
            minWidth="48rem"
            testId="dry-run-results-table"
          />
        </Box>
      </Stack>
    </>
  );
};

// Slack alerts, GitHub issue creation and integration health; the settings form is AlertSettingsSection.
const IntegrationsCard = ({
  integrationStatus,
  onRefreshHealth,
  isRefreshing,
}: {
  integrationStatus: IntegrationHealthResponse | undefined;
  onRefreshHealth: () => void;
  isRefreshing: boolean;
}) => (
  <SectionCard
    title="Alerts and integrations"
    body="custom"
    action={
      <Stack direction="row" alignItems="center" gap={1}>
        {integrationStatus?.overall && (
          <StatusChip
            tone={OVERALL_HEALTH[integrationStatus.overall].tone}
            label={OVERALL_HEALTH[integrationStatus.overall].label}
            data-testid="context-inspector-health-chip"
          />
        )}
        <Tooltip title="Refresh health status">
          <IconButton
            size="sm"
            variant="plain"
            aria-label="Refresh health status"
            onClick={onRefreshHealth}
            disabled={isRefreshing}
            data-testid="context-inspector-health-refresh-btn"
          >
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      </Stack>
    }
    data-testid="context-inspector-integrations-card"
  >
    <Typography
      level="body-sm"
      sx={{ color: 'admin.inkMuted', px: 2, pt: 1.75, pb: integrationStatus?.checks ? 0 : 1.75 }}
    >
      Slack alerts and GitHub issues for context telemetry anomalies. Configure them under Alert settings.
    </Typography>
    {integrationStatus?.checks && (
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 2, p: 2 }}>
        {integrationStatus.checks.map((check, idx) => (
          <HealthCheckRow key={idx} check={check} />
        ))}
      </Box>
    )}
  </SectionCard>
);

// A switch with its label and one-line description beside it.
const SettingSwitch = ({
  label,
  description,
  checked,
  onChange,
  disabled,
  testId,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
  testId: string;
}) => (
  <Stack direction="row" gap={2} alignItems="center">
    <Switch
      data-testid={testId}
      checked={checked}
      onChange={e => onChange(e.target.checked)}
      disabled={disabled}
      slotProps={{ input: { 'aria-label': label } }}
    />
    <Box>
      <Typography level="body-md" sx={{ color: 'admin.ink' }}>
        {label}
      </Typography>
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
        {description}
      </Typography>
    </Box>
  </Stack>
);

// A 15 / 600 subheading inside a card (DESIGN_GUIDE section 5, "Cards").
const Subheading = ({ children, sx }: { children: ReactNode; sx?: { mb: number } }) => (
  <Typography level="title-md" component="h4" sx={{ color: 'admin.ink', ...sx }}>
    {children}
  </Typography>
);

// The contextTelemetryAlerts setting as one staged draft: edits wait for the page SaveBar, which
// sends the whole object in one write, and Discard returns the form to the stored value.
const AlertSettingsSection = ({ alertSettings }: { alertSettings: ContextTelemetryAlerts | undefined }) => {
  const [configExpanded, setConfigExpanded] = useState(false);
  const saveSettings = useUpdateSettings();
  const {
    value: localSettings,
    setValue: setLocalSettings,
    pending: isUpdating,
  } = useSettingsDraft('contextTelemetryAlerts', alertSettings ?? DEFAULT_ALERT_SETTINGS, {
    name: 'Alert settings',
    save: value => saveSettings.mutateAsync({ key: 'contextTelemetryAlerts', value }),
  });

  // Fetch available Slack workspaces (same as LiveOps Triage)
  const { data: workspacesData, isError: isWorkspacesError } = useQuery({
    queryKey: ['slackWorkspaces'],
    queryFn: async () => {
      const response = await api.get('/api/admin/slack-workspaces');
      return response.data as { workspaces: SlackWorkspace[] };
    },
  });

  // Fetch model info for LLM selection
  const { data: models } = useModelInfo();

  // Get text models only and group by provider
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

  return (
    <SettingsSection component="section" sx={{ mb: 0, p: 0 }} data-testid="context-inspector-alert-settings">
      <AccordionGroup sx={{ px: 1, py: 1 }}>
        <Accordion expanded={configExpanded} onChange={() => setConfigExpanded(!configExpanded)}>
          <AccordionSummary
            component="h3"
            indicator={<ExpandMoreIcon />}
            sx={{ m: 0 }}
            slotProps={{ button: { 'data-testid': 'context-inspector-alert-settings-toggle' } }}
          >
            <Typography component="span" level="title-md" sx={{ color: 'admin.ink' }}>
              Alert settings
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Stack spacing={3} sx={{ pt: 1 }}>
              <SettingSwitch
                label={localSettings.enabled ? 'Alerts enabled' : 'Alerts disabled'}
                description="Send alerts to Slack when anomalies are detected"
                checked={localSettings.enabled}
                onChange={enabled => setLocalSettings({ ...localSettings, enabled })}
                disabled={isUpdating}
                testId="context-inspector-alerts-toggle"
              />

              <SettingSwitch
                label="Dry run mode"
                description="Log actions without creating issues or sending alerts"
                checked={localSettings.dryRun ?? false}
                onChange={dryRun => setLocalSettings({ ...localSettings, dryRun })}
                disabled={isUpdating}
                testId="dry-run-mode-toggle"
              />

              <Divider />

              {/* Slack Integration */}
              <Subheading>Slack integration</Subheading>
              <Grid container spacing={2}>
                <Grid xs={12} md={6}>
                  <FormControl>
                    <FormLabel>Slack workspace</FormLabel>
                    {isWorkspacesError ? (
                      <Alert color="danger" size="sm" sx={{ mt: 1 }}>
                        Failed to load Slack workspaces. Check your connection and try again.
                      </Alert>
                    ) : workspacesData?.workspaces.length === 0 ? (
                      <Alert color="warning" size="sm" sx={{ mt: 1 }}>
                        No Slack workspaces found. Configure via Admin → Slack Workspaces.
                      </Alert>
                    ) : (
                      <Select
                        value={localSettings.slackWorkspaceId ?? null}
                        onChange={(_, value) =>
                          setLocalSettings({ ...localSettings, slackWorkspaceId: value || undefined })
                        }
                        placeholder="Select a workspace..."
                        disabled={isUpdating}
                      >
                        {workspacesData?.workspaces.map(workspace => (
                          <Option key={workspace.id} value={workspace.id}>
                            {workspace.name || workspace.slackTeamId}
                          </Option>
                        ))}
                      </Select>
                    )}
                    <FormHelperText>The Slack workspace for posting alerts</FormHelperText>
                  </FormControl>
                </Grid>
                <Grid xs={12} md={6}>
                  <FormControl>
                    <FormLabel>Channel ID</FormLabel>
                    <Input
                      value={localSettings.slackChannelId ?? ''}
                      onChange={e => setLocalSettings({ ...localSettings, slackChannelId: e.target.value })}
                      placeholder="e.g., C06CWQNTSAH"
                      disabled={isUpdating}
                      slotProps={{ input: { 'data-testid': 'context-inspector-slack-channel-input' } }}
                    />
                    <FormHelperText>Slack channel ID for anomaly alerts</FormHelperText>
                  </FormControl>
                </Grid>
              </Grid>

              <Divider />

              {/* GitHub Integration */}
              <Subheading>GitHub integration</Subheading>
              <Grid container spacing={2}>
                <Grid xs={12} md={6}>
                  <FormControl>
                    <FormLabel>GitHub owner</FormLabel>
                    <Input
                      value={localSettings.githubOwner ?? ''}
                      onChange={e => setLocalSettings({ ...localSettings, githubOwner: e.target.value })}
                      placeholder="e.g., YourOrg"
                      disabled={isUpdating}
                    />
                    <FormHelperText>The organization or user that owns the repository</FormHelperText>
                  </FormControl>
                </Grid>
                <Grid xs={12} md={6}>
                  <FormControl>
                    <FormLabel>GitHub repo</FormLabel>
                    <Input
                      value={localSettings.githubRepo ?? ''}
                      onChange={e => setLocalSettings({ ...localSettings, githubRepo: e.target.value })}
                      placeholder="e.g., your-repo"
                      disabled={isUpdating}
                    />
                    <FormHelperText>Repository where issues will be created</FormHelperText>
                  </FormControl>
                </Grid>
                <Grid xs={12}>
                  <SettingSwitch
                    label="Auto-create GitHub issues"
                    description="Automatically create issues for critical anomalies"
                    checked={localSettings.autoCreateIssues ?? false}
                    onChange={autoCreateIssues => setLocalSettings({ ...localSettings, autoCreateIssues })}
                    disabled={isUpdating}
                    testId="context-inspector-auto-issues-toggle"
                  />
                </Grid>
              </Grid>

              <Divider />

              {/* LLM Configuration */}
              <Subheading>LLM configuration</Subheading>
              <Grid container spacing={2}>
                <Grid xs={12} md={6}>
                  <FormControl>
                    <FormLabel>Model</FormLabel>
                    <Select
                      value={localSettings.modelId ?? null}
                      onChange={(_, value) => {
                        if (value && !value.startsWith('__header_')) {
                          setLocalSettings({ ...localSettings, modelId: value });
                        }
                      }}
                      placeholder="Choose a model..."
                      disabled={isUpdating}
                    >
                      {Object.entries(modelsByProvider).map(([provider, providerModels]) => [
                        <Option key={`__header_${provider}`} value={`__header_${provider}`} disabled>
                          <Typography level="body-xs" sx={{ color: 'admin.inkMuted', textTransform: 'uppercase' }}>
                            {provider}
                          </Typography>
                        </Option>,
                        ...providerModels.map(model => (
                          <Option key={model.id} value={model.id}>
                            {model.name}
                          </Option>
                        )),
                      ])}
                    </Select>
                    <FormHelperText>Select the AI model for anomaly analysis</FormHelperText>
                  </FormControl>
                </Grid>
                <Grid xs={12} md={6}>
                  <FormControl>
                    <FormLabel>Temperature</FormLabel>
                    <Input
                      type="number"
                      value={localSettings.temperature ?? 0.3}
                      onChange={e =>
                        setLocalSettings({ ...localSettings, temperature: parseFloat(e.target.value) || 0.3 })
                      }
                      slotProps={{ input: { min: 0, max: 2, step: 0.1 } }}
                      disabled={isUpdating}
                    />
                    <FormHelperText>0-2 (lower = more consistent)</FormHelperText>
                  </FormControl>
                </Grid>
                <Grid xs={12} md={6}>
                  <FormControl>
                    <FormLabel>Max tokens</FormLabel>
                    <Input
                      type="number"
                      value={localSettings.maxTokens ?? 2000}
                      onChange={e =>
                        setLocalSettings({ ...localSettings, maxTokens: parseInt(e.target.value) || 2000 })
                      }
                      slotProps={{ input: { min: 100, max: 10000 } }}
                      disabled={isUpdating}
                    />
                    <FormHelperText>100-10,000 tokens</FormHelperText>
                  </FormControl>
                </Grid>
                <Grid xs={12} md={6}>
                  <FormControl>
                    <FormLabel>Timeout (seconds)</FormLabel>
                    <Input
                      type="number"
                      value={Math.round((localSettings.timeoutMs ?? 60000) / 1000)}
                      onChange={e =>
                        setLocalSettings({ ...localSettings, timeoutMs: (parseInt(e.target.value) || 60) * 1000 })
                      }
                      slotProps={{ input: { min: 30, max: 180 } }}
                      disabled={isUpdating}
                    />
                    <FormHelperText>30-180 seconds</FormHelperText>
                  </FormControl>
                </Grid>
                <Grid xs={12} md={6}>
                  <FormControl>
                    <FormLabel>LLM analysis threshold</FormLabel>
                    <Input
                      type="number"
                      value={localSettings.llmAnalysisThreshold ?? 30}
                      onChange={e =>
                        setLocalSettings({ ...localSettings, llmAnalysisThreshold: parseInt(e.target.value) || 30 })
                      }
                      slotProps={{ input: { min: 0, max: 100 } }}
                      disabled={isUpdating}
                    />
                    <FormHelperText>
                      Minimum anomaly score to use LLM analysis. Lower scores use rule-based analysis (saves cost).
                    </FormHelperText>
                  </FormControl>
                </Grid>
              </Grid>

              <Divider />

              {/* Alert Thresholds */}
              <Subheading>Alert thresholds</Subheading>
              <Grid container spacing={2}>
                <Grid xs={12} md={4}>
                  <FormControl>
                    <FormLabel>Alert threshold</FormLabel>
                    <Input
                      type="number"
                      value={localSettings.alertThreshold}
                      onChange={e =>
                        setLocalSettings({ ...localSettings, alertThreshold: parseInt(e.target.value) || 30 })
                      }
                      slotProps={{ input: { min: 0, max: 100 } }}
                      disabled={isUpdating}
                    />
                    <FormHelperText>Minimum score to trigger alerts (0-100)</FormHelperText>
                  </FormControl>
                </Grid>
                <Grid xs={12} md={4}>
                  <FormControl>
                    <FormLabel>Critical threshold</FormLabel>
                    <Input
                      type="number"
                      value={localSettings.criticalThreshold}
                      onChange={e =>
                        setLocalSettings({ ...localSettings, criticalThreshold: parseInt(e.target.value) || 50 })
                      }
                      slotProps={{ input: { min: 0, max: 100 } }}
                      disabled={isUpdating}
                    />
                    <FormHelperText>Score that triggers @here mentions</FormHelperText>
                  </FormControl>
                </Grid>
                <Grid xs={12} md={4}>
                  <FormControl>
                    <FormLabel>Dedup window (minutes)</FormLabel>
                    <Input
                      type="number"
                      value={localSettings.dedupWindowMinutes}
                      onChange={e =>
                        setLocalSettings({ ...localSettings, dedupWindowMinutes: parseInt(e.target.value) || 5 })
                      }
                      slotProps={{ input: { min: 1, max: 60 } }}
                      disabled={isUpdating}
                    />
                    <FormHelperText>Suppress duplicate alerts</FormHelperText>
                  </FormControl>
                </Grid>
              </Grid>

              <Divider />

              {/* Performance Targets (SLOs) */}
              <Subheading>Performance targets (SLOs)</Subheading>
              <Grid container spacing={2}>
                <Grid xs={12} md={6}>
                  <FormControl>
                    <FormLabel>Response time P95 (seconds)</FormLabel>
                    <Input
                      type="number"
                      value={Math.round((localSettings.sloResponseTimeP95Ms ?? 60000) / 1000)}
                      onChange={e =>
                        setLocalSettings({
                          ...localSettings,
                          sloResponseTimeP95Ms: (parseInt(e.target.value) || 60) * 1000,
                        })
                      }
                      slotProps={{ input: { min: 1, max: 300 } }}
                      disabled={isUpdating}
                    />
                    <FormHelperText>Target P95 total response time (default: 60s)</FormHelperText>
                  </FormControl>
                </Grid>
                <Grid xs={12} md={6}>
                  <FormControl>
                    <FormLabel>First token time (seconds)</FormLabel>
                    <Input
                      type="number"
                      value={Math.round((localSettings.sloFirstTokenTimeMs ?? 5000) / 1000)}
                      onChange={e =>
                        setLocalSettings({
                          ...localSettings,
                          sloFirstTokenTimeMs: (parseInt(e.target.value) || 5) * 1000,
                        })
                      }
                      slotProps={{ input: { min: 1, max: 60 } }}
                      disabled={isUpdating}
                    />
                    <FormHelperText>Target time to first token (default: 5s)</FormHelperText>
                  </FormControl>
                </Grid>
                <Grid xs={12} md={6}>
                  <FormControl>
                    <FormLabel>Error rate (%)</FormLabel>
                    <Input
                      type="number"
                      value={localSettings.sloErrorRatePercent ?? 2}
                      onChange={e =>
                        setLocalSettings({ ...localSettings, sloErrorRatePercent: parseFloat(e.target.value) || 2 })
                      }
                      slotProps={{ input: { min: 0, max: 100, step: 0.5 } }}
                      disabled={isUpdating}
                    />
                    <FormHelperText>Acceptable error rate percentage (default: 2%)</FormHelperText>
                  </FormControl>
                </Grid>
                <Grid xs={12} md={6}>
                  <FormControl>
                    <FormLabel>Context utilization (%)</FormLabel>
                    <Input
                      type="number"
                      value={localSettings.sloContextUtilizationPercent ?? 85}
                      onChange={e =>
                        setLocalSettings({
                          ...localSettings,
                          sloContextUtilizationPercent: parseInt(e.target.value) || 85,
                        })
                      }
                      slotProps={{ input: { min: 50, max: 100 } }}
                      disabled={isUpdating}
                    />
                    <FormHelperText>Max acceptable utilization (default: 85%)</FormHelperText>
                  </FormControl>
                </Grid>
              </Grid>

              <Divider />

              {/* Historical Baselines */}
              <Subheading>Historical baselines</Subheading>
              <Grid container spacing={2}>
                <Grid xs={12} md={6}>
                  <FormControl>
                    <FormLabel>Baseline window (days)</FormLabel>
                    <Input
                      type="number"
                      value={localSettings.baselineWindowDays ?? 7}
                      onChange={e =>
                        setLocalSettings({ ...localSettings, baselineWindowDays: parseInt(e.target.value) || 7 })
                      }
                      slotProps={{ input: { min: 3, max: 30 } }}
                      disabled={isUpdating}
                    />
                    <FormHelperText>
                      Days of history used for baseline computation (min 30 samples required). Default: 7 days.
                    </FormHelperText>
                  </FormControl>
                </Grid>
              </Grid>

              {/* Dry Run Testing - only visible when dryRun is enabled */}
              {localSettings.dryRun && <DryRunSection />}
            </Stack>
          </AccordionDetails>
        </Accordion>
      </AccordionGroup>
    </SettingsSection>
  );
};

// Entries are rows of one card, divided by hairlines rather than each in a card of its own.
const ENTRY_ROW_SX = { px: 2, py: 1.75, minWidth: 0, '& + &': { borderTop: '1px solid', borderColor: 'admin.border' } };

// Rows come from the loaded entry, so these tables never show their error state.
const ignoreRetry = () => undefined;

const MutedDash = () => (
  <Typography
    component="span"
    level="body-sm"
    sx={{ color: 'admin.inkMuted' }}
    data-testid="context-inspector-empty-value"
  >
    -
  </Typography>
);

const TOOL_COLUMNS: DataColumn<ToolTelemetry>[] = [
  {
    id: 'tool',
    label: 'Tool',
    render: tool => (
      <Typography level="body-sm" noWrap>
        {tool.toolName}
      </Typography>
    ),
  },
  { id: 'calls', label: 'Calls', numeric: true, render: tool => tool.invocationCount.toLocaleString() },
  {
    id: 'failures',
    label: 'Failures',
    numeric: true,
    render: tool => (tool.failureCount > 0 ? <StatusChip tone="bad" label={tool.failureCount.toLocaleString()} /> : 0),
  },
  {
    id: 'avgTime',
    label: 'Avg time',
    numeric: true,
    render: tool =>
      tool.invocationCount > 0 ? `${(tool.totalDurationMs / tool.invocationCount).toFixed(0)}ms` : <MutedDash />,
  },
  {
    id: 'lastError',
    label: 'Last error',
    render: tool =>
      tool.lastError ? (
        <Typography level="body-xs" sx={{ maxWidth: '12.5rem' }} noWrap>
          {tool.lastError}
        </Typography>
      ) : (
        <MutedDash />
      ),
  },
];

const SUBAGENT_COLUMNS: DataColumn<SubagentTelemetry>[] = [
  {
    id: 'agent',
    label: 'Agent',
    render: agent => (
      <Typography level="body-sm" noWrap>
        {agent.agentName}
      </Typography>
    ),
  },
  { id: 'delegations', label: 'Delegations', numeric: true, render: agent => agent.delegationCount.toLocaleString() },
  {
    id: 'timeouts',
    label: 'Timeouts',
    numeric: true,
    render: agent =>
      agent.timeoutCount > 0 ? <StatusChip tone="bad" label={agent.timeoutCount.toLocaleString()} /> : 0,
  },
  {
    id: 'totalTime',
    label: 'Total time',
    numeric: true,
    render: agent => `${(agent.totalDurationMs / 1000).toFixed(1)}s`,
  },
  { id: 'tokens', label: 'Tokens', numeric: true, render: agent => agent.totalTokensUsed.toLocaleString() },
];

const Metric = ({ label, children }: { label: string; children: ReactNode }) => (
  <Box>
    <Typography component="dt" level="body-xs" sx={{ color: 'admin.inkMuted' }}>
      {label}
    </Typography>
    <Typography component="dd" level="body-sm" sx={{ m: 0, color: 'admin.ink', fontVariantNumeric: 'tabular-nums' }}>
      {children}
    </Typography>
  </Box>
);

// One telemetry entry, as a row of the entries card
const TelemetryEntryRow = ({
  entry,
  onAnalyze,
  onCreateIssue,
  githubEnabled,
}: {
  entry: ContextTelemetryEntry;
  onAnalyze: (id: string) => void;
  onCreateIssue: (id: string) => void;
  githubEnabled: boolean;
}) => {
  const [expanded, setExpanded] = useState(false);
  const telemetry = entry.telemetry;

  if (!telemetry) {
    return (
      <Box component="article" sx={ENTRY_ROW_SX} data-testid={`context-inspector-entry-${entry.id}`}>
        <EmptyState
          title="No telemetry data"
          description={`This completion (${new Date(entry.timestamp).toLocaleString()}) was saved without context telemetry.`}
          action={null}
        />
      </Box>
    );
  }

  const { model, contextWindow, performance, anomalies, tools, subagents } = telemetry;

  return (
    <Box component="article" sx={ENTRY_ROW_SX} data-testid={`context-inspector-entry-${entry.id}`}>
      <Stack gap={1.5}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
          <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" sx={{ minWidth: 0 }}>
            <Typography level="title-sm" sx={{ color: 'admin.ink' }}>
              {model.modelId}
            </Typography>
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              {model.provider}
            </Typography>
            <SeverityChip severity={anomalies.severity} benign={anomalies.primaryAnomaly === 'none'} />
            {model.fallbackUsed && <StatusChip tone="warn" label="Fallback" />}
          </Stack>
          <Stack direction="row" gap={0.5} alignItems="center">
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted', mr: 0.5 }}>
              {new Date(entry.timestamp).toLocaleString()}
            </Typography>
            <Tooltip title="Analyze anomalies">
              <IconButton
                size="sm"
                variant="plain"
                aria-label="Analyze anomalies"
                onClick={() => onAnalyze(entry.id)}
                data-testid={`context-inspector-analyze-${entry.id}`}
              >
                <AnalyticsIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title={githubEnabled ? 'Create GitHub issue' : 'GitHub not configured'}>
              <span>
                <IconButton
                  size="sm"
                  variant="plain"
                  aria-label="Create GitHub issue"
                  onClick={() => onCreateIssue(entry.id)}
                  disabled={!githubEnabled}
                  data-testid={`context-inspector-create-issue-${entry.id}`}
                >
                  <GitHubIcon />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        </Stack>

        <Box
          component="dl"
          sx={{ m: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(8.75rem, 1fr))', gap: 1.5 }}
        >
          <Metric label="Input tokens">{contextWindow.inputTokens.toLocaleString()}</Metric>
          <Metric label="Utilization">
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
              <InlineBar value={Math.min(contextWindow.utilizationPercentage, 100)} max={100} />
              {contextWindow.utilizationPercentage.toFixed(1)}%
            </Box>
          </Metric>
          <Metric label="Response time">{(performance.totalResponseTimeMs / 1000).toFixed(2)}s</Metric>
          <Metric label="Anomaly score">{anomalies.anomalyScore}/100</Metric>
        </Box>

        <AnomalyIndicators anomalies={anomalies} />

        <Accordion expanded={expanded} onChange={() => setExpanded(!expanded)}>
          <AccordionSummary indicator={<ExpandMoreIcon />}>
            <Typography level="body-sm">Details</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Stack spacing={2}>
              {/* Basic-tier notice: system prompts & feature breakdown require Enhanced */}
              {!telemetry.systemPrompts && (
                <Typography level="body-xs" sx={{ fontStyle: 'italic', color: 'admin.inkMuted' }}>
                  Basic tier — system prompt breakdown and feature details require <strong>Enhanced</strong> telemetry.
                </Typography>
              )}
              {/* Token Distribution */}
              {contextWindow.tokensBySource && (
                <Box>
                  <Subheading sx={{ mb: 1 }}>Token distribution</Subheading>
                  <TokenDistributionBar tokensBySource={contextWindow.tokensBySource} />
                </Box>
              )}

              {/* System Prompt Details */}
              {telemetry.systemPrompts && telemetry.systemPrompts.prompts.length > 0 && (
                <Box>
                  <Subheading sx={{ mb: 1 }}>
                    System prompts ({telemetry.systemPrompts.totalTokens.toLocaleString()} tokens)
                  </Subheading>
                  <Grid container spacing={1}>
                    {telemetry.systemPrompts.prompts.map(prompt => (
                      <Grid key={`${prompt.name}-${prompt.source}`} xs={4} md={2}>
                        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                          {prompt.name} ({prompt.source})
                        </Typography>
                        <Typography level="body-sm">{prompt.tokenCount.toLocaleString()}</Typography>
                      </Grid>
                    ))}
                  </Grid>
                </Box>
              )}

              {/* Tool Failures */}
              {tools && tools.length > 0 && (
                <Box>
                  <Subheading sx={{ mb: 1 }}>Tools ({tools.length})</Subheading>
                  <DataTable
                    label="Tools"
                    rows={tools.slice(0, 10)}
                    columns={TOOL_COLUMNS}
                    getRowId={tool => tool.toolName}
                    onRetry={ignoreRetry}
                    pagination={false}
                    maxHeight="none"
                    testId={`context-inspector-tools-table-${entry.id}`}
                  />
                </Box>
              )}

              {/* Subagents */}
              {subagents && subagents.length > 0 && (
                <Box>
                  <Subheading sx={{ mb: 1 }}>Subagents ({subagents.length})</Subheading>
                  <DataTable
                    label="Subagents"
                    rows={subagents}
                    columns={SUBAGENT_COLUMNS}
                    getRowId={agent => agent.agentName}
                    onRetry={ignoreRetry}
                    pagination={false}
                    maxHeight="none"
                    testId={`context-inspector-subagents-table-${entry.id}`}
                  />
                </Box>
              )}

              {/* Fallback Info */}
              {model.fallbackUsed && (
                <Box>
                  <Subheading sx={{ mb: 1 }}>Fallback details</Subheading>
                  <Typography level="body-sm">Original model: {model.originalModelId ?? 'Unknown'}</Typography>
                  <Typography level="body-sm">Reason: {model.fallbackReason ?? 'Unknown'}</Typography>
                </Box>
              )}
            </Stack>
          </AccordionDetails>
        </Accordion>
      </Stack>
    </Box>
  );
};

// Main Component
export function ContextInspectorTab() {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [provider, setProvider] = useState<string | null>(null);
  const [minAnomalyScore, setMinAnomalyScore] = useState<number | null>(null);
  const [severity, setSeverity] = useState<AnomalySeverity | null>(null);
  const [anomalyType, setAnomalyType] = useState<PrimaryAnomaly | null>(null);
  const [page, setPage] = useState(0);
  const pageSize = 20;

  // Modal states
  const [analysisModalOpen, setAnalysisModalOpen] = useState(false);
  const [createIssueModalOpen, setCreateIssueModalOpen] = useState(false);
  const [issueCreatedModalOpen, setIssueCreatedModalOpen] = useState(false);
  const [selectedEntryId, setSelectedEntryId] = useState<string>('');
  const [createdIssueUrl, setCreatedIssueUrl] = useState('');
  const [isDuplicateIssue, setIsDuplicateIssue] = useState(false);
  const [duplicateIssueNumber, setDuplicateIssueNumber] = useState(0);

  // Telemetry enabled toggle
  const telemetryEnabledRaw = useGetSettingsValue('EnableContextTelemetry');
  const telemetryEnabled = telemetryEnabledRaw === true || telemetryEnabledRaw === 'true';
  const updateSettings = useUpdateSettings();

  // Alert settings
  const alertSettingsRaw = useGetSettingsValue('contextTelemetryAlerts');
  const alertSettings = alertSettingsRaw as ContextTelemetryAlerts | undefined;

  // Integration status
  const {
    data: integrationStatus,
    refetch: refetchIntegrationStatus,
    isFetching: isRefreshingIntegration,
  } = useIntegrationStatus();

  // Analysis mutation
  const analyzeMutation = useAnalyzeTelemetry();

  const handleToggleTelemetry = () => {
    updateSettings.mutate({
      key: 'EnableContextTelemetry',
      value: !telemetryEnabled,
    });
  };

  const handleAnalyze = (id: string) => {
    setSelectedEntryId(id);
    setAnalysisModalOpen(true);
    analyzeMutation.mutate({ id });
  };

  const handleReanalyze = () => {
    if (selectedEntryId) {
      analyzeMutation.mutate({ id: selectedEntryId, force: true });
    }
  };

  const handleCreateIssue = (id: string) => {
    setSelectedEntryId(id);
    setCreateIssueModalOpen(true);
  };

  const handleIssueCreated = (url: string) => {
    setIsDuplicateIssue(false);
    setDuplicateIssueNumber(0);
    setCreatedIssueUrl(url);
    setIssueCreatedModalOpen(true);
  };

  const handleDuplicateIssue = (url: string, issueNumber: number) => {
    setIsDuplicateIssue(true);
    setDuplicateIssueNumber(issueNumber);
    setCreatedIssueUrl(url);
    setIssueCreatedModalOpen(true);
  };

  const { data, isLoading, isFetching, error, refetch } = useContextTelemetry({
    startDate: startDate || undefined,
    endDate: endDate || undefined,
    provider: provider ?? undefined,
    minAnomalyScore: minAnomalyScore ?? undefined,
    severity: severity ?? undefined,
    anomalyType: anomalyType ?? undefined,
    limit: pageSize,
    offset: page * pageSize,
  });

  const totalPages = data ? Math.ceil(data.total / pageSize) : 0;

  const filtersSet = Boolean(startDate || endDate || provider || minAnomalyScore !== null || severity || anomalyType);
  const clearFilters = () => {
    setStartDate('');
    setEndDate('');
    setProvider(null);
    setMinAnomalyScore(null);
    setSeverity(null);
    setAnomalyType(null);
    setPage(0);
  };

  return (
    <Stack gap={ADMIN_REGION_GAP} sx={{ minWidth: 0 }} data-testid="context-inspector-root">
      <AdminPageHeader
        title="Context inspector"
        description="Context window, latency and anomaly telemetry for recent completions, with Slack and GitHub alerts."
        actions={
          <>
            <Stack direction="row" alignItems="center" gap={1}>
              <Switch
                checked={telemetryEnabled}
                onChange={handleToggleTelemetry}
                disabled={updateSettings.isPending}
                slotProps={{
                  input: {
                    'aria-label': 'Telemetry collection',
                    'data-testid': 'context-inspector-telemetry-toggle',
                  },
                }}
              />
              <Typography level="body-sm" sx={{ color: 'admin.inkSecondary' }}>
                Telemetry collection
              </Typography>
              <StatusChip
                tone={telemetryEnabled ? 'good' : 'neutral'}
                label={telemetryEnabled ? 'Enabled' : 'Disabled'}
                data-testid="context-inspector-telemetry-chip"
              />
            </Stack>
            <Button
              size="sm"
              variant="outlined"
              startDecorator={<RefreshIcon />}
              onClick={() => refetch()}
              loading={isFetching}
              data-testid="context-inspector-refresh-btn"
            >
              Refresh
            </Button>
          </>
        }
      />

      {/* The page is a settings page for the alert settings: one SaveBar and leave-page guard for the
          staged form. The telemetry switch in the header stays an instant write, as a mode toggle. */}
      <SettingsDraftProvider>
        {updateSettings.error && (
          <Alert color="danger" data-testid="context-inspector-telemetry-error">
            Could not change telemetry collection: {updateSettings.error.message}
          </Alert>
        )}

        {!telemetryEnabled && (
          <Alert color="warning" data-testid="context-inspector-disabled-banner">
            Telemetry collection is disabled. Enable it to start capturing operational metadata for new completions.
          </Alert>
        )}

        <IntegrationsCard
          integrationStatus={integrationStatus}
          onRefreshHealth={() => refetchIntegrationStatus()}
          isRefreshing={isRefreshingIntegration}
        />

        <AlertSettingsSection alertSettings={alertSettings} />

        {data?.stats && (
          <StatStrip aria-label="Telemetry summary">
            <StatTile label="Total entries" value={data.stats.totalEntries} />
            <StatTile
              label="Avg anomaly score"
              value={data.stats.avgAnomalyScore}
              comparison={data.stats.avgAnomalyScore >= 30 ? <StatusChip tone="warn" label="High" /> : undefined}
            />
            <StatTile
              label="Avg utilization"
              value={`${data.stats.avgUtilization}%`}
              comparison={data.stats.avgUtilization >= 90 ? <StatusChip tone="warn" label="High" /> : undefined}
            />
            <StatTile label="Avg response time" value={`${(data.stats.avgResponseTimeMs / 1000).toFixed(1)}s`} />
            <StatTile
              label="Severity"
              value={
                <Stack component="span" direction="row" gap={0.5} flexWrap="wrap" sx={{ py: 0.25 }}>
                  {SEVERITIES.map(sev => {
                    const count = data.stats.severityDistribution[sev] ?? 0;
                    return (
                      <StatusChip
                        key={sev}
                        tone={count > 0 ? severityTone(sev) : 'neutral'}
                        label={`${capitalize(sev)}: ${count}`}
                        data-testid={`context-inspector-severity-${sev}`}
                      />
                    );
                  })}
                </Stack>
              }
            />
          </StatStrip>
        )}

        <FilterToolbar data-testid="context-inspector-filter-bar">
          <Input
            type="date"
            size="sm"
            startDecorator={<FilterInputLabel>From</FilterInputLabel>}
            value={startDate}
            onChange={e => {
              setStartDate(e.target.value);
              setPage(0);
            }}
            slotProps={{ input: { 'aria-label': 'Start date' } }}
          />
          <Input
            type="date"
            size="sm"
            startDecorator={<FilterInputLabel>To</FilterInputLabel>}
            value={endDate}
            onChange={e => {
              setEndDate(e.target.value);
              setPage(0);
            }}
            slotProps={{ input: { 'aria-label': 'End date' } }}
          />
          <FilterChip
            id="provider"
            label="Provider"
            value={provider ?? undefined}
            options={(data?.stats?.providers ?? []).map(p => ({ value: p, label: p }))}
            onChange={value => {
              setProvider(value ?? null);
              setPage(0);
            }}
          />
          <FilterChip
            id="min-score"
            label="Anomaly score"
            value={minAnomalyScore === null ? undefined : String(minAnomalyScore)}
            options={MIN_SCORE_OPTIONS}
            onChange={value => {
              setMinAnomalyScore(value === undefined ? null : Number(value));
              setPage(0);
            }}
          />
          <FilterChip
            id="severity"
            label="Severity"
            value={severity ?? undefined}
            options={SEVERITIES.map(sev => ({ value: sev, label: capitalize(sev) }))}
            onChange={value => {
              setSeverity(SEVERITIES.find(sev => sev === value) ?? null);
              setPage(0);
            }}
          />
          <FilterChip
            id="anomaly-type"
            label="Anomaly type"
            value={anomalyType ?? undefined}
            options={ANOMALY_TYPES}
            onChange={value => {
              setAnomalyType(ANOMALY_TYPES.find(type => type.value === value)?.value ?? null);
              setPage(0);
            }}
          />
        </FilterToolbar>

        {/* With entries on screen a failed refresh is a banner above them; with none it takes their place. */}
        {error && data && (
          <Alert color="danger" data-testid="context-inspector-error-banner">
            Could not refresh telemetry: {error.message}
          </Alert>
        )}

        <SectionCard
          title="Telemetry entries"
          body="custom"
          action={
            data?.entries?.length ? (
              <Typography
                level="body-xs"
                sx={{ color: 'admin.inkMuted' }}
                data-testid="context-inspector-entries-count"
              >
                Showing {data.entries.length} of {data.total} entries
              </Typography>
            ) : undefined
          }
          data-testid="context-inspector-entries-card"
        >
          {isLoading ? (
            <LoadingState label="Loading telemetry" testId="context-inspector-loading" />
          ) : error && !data ? (
            <ErrorState
              message={`Could not load telemetry: ${error.message}`}
              onRetry={() => void refetch()}
              retrying={isFetching}
            />
          ) : !data?.entries?.length ? (
            <EmptyState
              title={filtersSet ? 'No entries match these filters' : 'No telemetry entries yet'}
              description={
                filtersSet
                  ? undefined
                  : 'Context telemetry is recorded for new completions while collection is enabled.'
              }
              action={
                filtersSet ? (
                  <Button
                    size="sm"
                    variant="outlined"
                    onClick={clearFilters}
                    data-testid="context-inspector-clear-filters-btn"
                  >
                    Clear filters
                  </Button>
                ) : null
              }
            />
          ) : (
            <>
              <AccordionGroup>
                {data.entries.map(entry => (
                  <TelemetryEntryRow
                    key={entry.id}
                    entry={entry}
                    onAnalyze={handleAnalyze}
                    onCreateIssue={handleCreateIssue}
                    githubEnabled={integrationStatus?.github ?? false}
                  />
                ))}
              </AccordionGroup>

              {totalPages > 1 && (
                <Stack
                  direction="row"
                  alignItems="center"
                  justifyContent="flex-end"
                  gap={1}
                  sx={{ px: 2, py: 1, borderTop: '1px solid', borderColor: 'admin.border' }}
                  data-testid="context-inspector-pager"
                >
                  <Typography level="body-sm" sx={{ color: 'admin.inkMuted', mr: 'auto' }}>
                    Page {page + 1} of {totalPages}
                  </Typography>
                  <Button
                    size="sm"
                    variant="outlined"
                    disabled={page === 0}
                    onClick={() => setPage(p => p - 1)}
                    data-testid="context-inspector-prev-btn"
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="outlined"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage(p => p + 1)}
                    data-testid="context-inspector-next-btn"
                  >
                    Next
                  </Button>
                </Stack>
              )}
            </>
          )}
        </SectionCard>

        {/* Modals */}
        <AnalysisModal
          open={analysisModalOpen}
          onClose={() => setAnalysisModalOpen(false)}
          analysis={analyzeMutation.data?.analysis ?? null}
          isLoading={analyzeMutation.isPending}
          error={analyzeMutation.error}
          baselines={analyzeMutation.data?.historicalBaselines}
          analysisSource={analyzeMutation.data?.analysisSource}
          cached={analyzeMutation.data?.cached}
          cachedAt={analyzeMutation.data?.cachedAt}
          onReanalyze={handleReanalyze}
        />

        <CreateIssueModal
          open={createIssueModalOpen}
          onClose={() => setCreateIssueModalOpen(false)}
          entryId={selectedEntryId}
          onSuccess={handleIssueCreated}
          onDuplicate={handleDuplicateIssue}
          configuredRepo={
            alertSettings?.githubOwner && alertSettings?.githubRepo
              ? { owner: alertSettings.githubOwner, repo: alertSettings.githubRepo }
              : null
          }
        />

        <IssueCreatedModal
          open={issueCreatedModalOpen}
          onClose={() => setIssueCreatedModalOpen(false)}
          issueUrl={createdIssueUrl}
          isDuplicate={isDuplicateIssue}
          issueNumber={duplicateIssueNumber}
        />
      </SettingsDraftProvider>
    </Stack>
  );
}

export default ContextInspectorTab;
