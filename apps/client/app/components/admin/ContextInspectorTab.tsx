import { useState, useEffect } from 'react';
import { isAxiosError } from 'axios';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Stack,
  Select,
  Option,
  Input,
  Button,
  Chip,
  Grid,
  CircularProgress,
  Sheet,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  AccordionGroup,
  Table,
  LinearProgress,
  Tooltip,
  Switch,
  Alert,
  Modal,
  ModalDialog,
  ModalClose,
  Divider,
  FormControl,
  FormLabel,
  Textarea,
  IconButton,
  List,
  ListItem,
  ListItemDecorator,
  FormHelperText,
} from '@mui/joy';
import { styled } from '@mui/system';
import RefreshIcon from '@mui/icons-material/Refresh';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ErrorIcon from '@mui/icons-material/Error';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import InfoIcon from '@mui/icons-material/Info';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AnalyticsIcon from '@mui/icons-material/Analytics';
import GitHubIcon from '@mui/icons-material/GitHub';
import SettingsIcon from '@mui/icons-material/Settings';
import LightbulbIcon from '@mui/icons-material/Lightbulb';
import ReportProblemIcon from '@mui/icons-material/ReportProblem';
import LinkIcon from '@mui/icons-material/Link';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import {
  ContextTelemetryAlertsSchema,
  type ContextTelemetry,
  type AnomalySeverity,
  type PrimaryAnomaly,
  type ContextTelemetryAlerts,
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

interface SlackWorkspace {
  id: string;
  name: string;
  slackTeamId: string;
  isActive: boolean;
}

// Default settings derived from schema (module-level to avoid re-parsing on every render)
const DEFAULT_ALERT_SETTINGS = ContextTelemetryAlertsSchema.parse({});

// Token distribution bar segment
const TokenSegment = styled('div')<{ width: number; color: string }>(({ width, color }) => ({
  width: `${width}%`,
  height: '100%',
  backgroundColor: color,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '10px',
  color: 'white',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
}));

// Color mapping for token sources
const TOKEN_SOURCE_COLORS: Record<string, string> = {
  systemPrompts: '#3f51b5',
  conversationHistory: '#2196f3',
  mementos: '#00bcd4',
  fabFiles: '#009688',
  urlContent: '#8bc34a',
  toolSchemas: '#4caf50',
  userPrompt: '#ff9800',
};

// Severity colors
const SEVERITY_COLORS: Record<AnomalySeverity, string> = {
  low: '#4caf50',
  medium: '#ffc107',
  high: '#ff9800',
  critical: '#f44336',
};

// Severity icons
const SeverityIcon = ({ severity }: { severity: AnomalySeverity }) => {
  switch (severity) {
    case 'critical':
      return <ErrorIcon sx={{ color: SEVERITY_COLORS.critical }} />;
    case 'high':
      return <WarningAmberIcon sx={{ color: SEVERITY_COLORS.high }} />;
    case 'medium':
      return <WarningAmberIcon sx={{ color: SEVERITY_COLORS.medium }} />;
    case 'low':
      return <CheckCircleIcon sx={{ color: SEVERITY_COLORS.low }} />;
    default:
      return <InfoIcon />;
  }
};

// Token Distribution Visualization
const TokenDistributionBar = ({
  tokensBySource,
}: {
  tokensBySource: NonNullable<ContextTelemetry['contextWindow']['tokensBySource']>;
}) => {
  const total =
    tokensBySource.systemPrompts +
    tokensBySource.conversationHistory +
    tokensBySource.mementos +
    tokensBySource.fabFiles +
    tokensBySource.urlContent +
    tokensBySource.toolSchemas +
    tokensBySource.userPrompt;

  if (total === 0) return <Typography level="body-sm">No token data</Typography>;

  const segments = [
    { key: 'systemPrompts', label: 'System', value: tokensBySource.systemPrompts },
    { key: 'conversationHistory', label: 'History', value: tokensBySource.conversationHistory },
    { key: 'mementos', label: 'Mementos', value: tokensBySource.mementos },
    { key: 'fabFiles', label: 'Files', value: tokensBySource.fabFiles },
    { key: 'urlContent', label: 'URLs', value: tokensBySource.urlContent },
    { key: 'toolSchemas', label: 'Tools', value: tokensBySource.toolSchemas },
    { key: 'userPrompt', label: 'User', value: tokensBySource.userPrompt },
  ].filter(s => s.value > 0);

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          height: 24,
          borderRadius: 'sm',
          overflow: 'hidden',
          border: '1px solid',
          borderColor: 'divider',
        }}
      >
        {segments.map(segment => (
          <Tooltip
            key={segment.key}
            title={`${segment.label}: ${segment.value.toLocaleString()} tokens (${((segment.value / total) * 100).toFixed(1)}%)`}
          >
            <TokenSegment width={(segment.value / total) * 100} color={TOKEN_SOURCE_COLORS[segment.key]}>
              {(segment.value / total) * 100 > 8 ? segment.label : ''}
            </TokenSegment>
          </Tooltip>
        ))}
      </Box>
      <Stack direction="row" spacing={2} sx={{ mt: 1, flexWrap: 'wrap' }}>
        {segments.map(segment => (
          <Stack key={segment.key} direction="row" alignItems="center" spacing={0.5}>
            <Box
              sx={{
                width: 12,
                height: 12,
                borderRadius: 'xs',
                bgcolor: TOKEN_SOURCE_COLORS[segment.key],
              }}
            />
            <Typography level="body-xs">
              {segment.label}: {segment.value.toLocaleString()}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
};

// Anomaly Indicators
const AnomalyIndicators = ({ anomalies }: { anomalies: ContextTelemetry['anomalies'] }) => {
  const activeAnomalies = [
    anomalies.contextOverflow && 'Context Overflow',
    anomalies.criticalUtilization && 'Critical Utilization (95%+)',
    anomalies.highUtilization && !anomalies.criticalUtilization && 'High Utilization (90%+)',
    anomalies.criticalTruncation && 'Critical Truncation (75%+)',
    anomalies.highTruncation && !anomalies.criticalTruncation && 'High Truncation (50%+)',
    anomalies.toolFailureSpike && 'Tool Failure Spike',
    anomalies.toolTimeout && 'Tool Timeout',
    anomalies.subagentTimeout && 'Subagent Timeout',
    anomalies.slowTotalResponse && 'Slow Response',
    anomalies.slowFirstToken && 'Slow First Token',
  ].filter((x): x is string => Boolean(x));

  if (activeAnomalies.length === 0) {
    return (
      <Chip size="sm" color="success" variant="outlined">
        No Anomalies
      </Chip>
    );
  }

  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
      {activeAnomalies.map(anomaly => (
        <Chip key={anomaly} size="sm" color="warning" variant="outlined">
          {anomaly}
        </Chip>
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
  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 600, maxHeight: '80vh', overflow: 'auto' }}>
        <ModalClose />
        <Typography level="h4" sx={{ mb: 2 }}>
          Anomaly Analysis
        </Typography>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        )}

        {error && (
          <Alert color="danger" variant="outlined" sx={{ mb: 2 }}>
            Failed to analyze: {error.message}
          </Alert>
        )}

        {analysis && (
          <Stack spacing={2}>
            {/* Summary */}
            <Card
              variant="soft"
              color={analysis.severity === 'critical' ? 'danger' : analysis.severity === 'high' ? 'warning' : 'neutral'}
            >
              <CardContent>
                <Typography level="body-sm" fontWeight="md">
                  {analysis.summary}
                </Typography>
              </CardContent>
            </Card>

            {/* Severity & Impact */}
            <Box>
              <Stack direction="row" spacing={2} alignItems="center">
                <Chip
                  size="lg"
                  color={
                    analysis.severity === 'critical'
                      ? 'danger'
                      : analysis.severity === 'high'
                        ? 'warning'
                        : analysis.severity === 'medium'
                          ? 'warning'
                          : 'success'
                  }
                  variant="outlined"
                >
                  {analysis.severity.toUpperCase()} SEVERITY
                </Chip>
                {analysis.recommendedAction && (
                  <Chip
                    size="lg"
                    color={
                      analysis.recommendedAction === 'immediate_action'
                        ? 'danger'
                        : analysis.recommendedAction === 'investigate_soon'
                          ? 'warning'
                          : analysis.recommendedAction === 'monitor'
                            ? 'neutral'
                            : 'success'
                    }
                    variant="outlined"
                  >
                    {analysis.recommendedAction === 'no_action'
                      ? 'No Action Needed'
                      : analysis.recommendedAction === 'monitor'
                        ? 'Monitor'
                        : analysis.recommendedAction === 'investigate_soon'
                          ? 'Investigate Soon'
                          : 'Immediate Action'}
                  </Chip>
                )}
              </Stack>
              <Typography level="body-sm" sx={{ mt: 1 }}>
                {analysis.estimatedImpact}
              </Typography>
            </Box>

            <Divider />

            {/* Findings */}
            <Box>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                <ReportProblemIcon color="warning" />
                <Typography level="title-md">Findings</Typography>
              </Stack>
              <List size="sm">
                {analysis.findings.map((finding, idx) => (
                  <ListItem key={`finding-${idx}`}>
                    <ListItemDecorator>
                      <WarningAmberIcon fontSize="small" color="warning" />
                    </ListItemDecorator>
                    <Typography level="body-sm">{finding}</Typography>
                  </ListItem>
                ))}
              </List>
            </Box>

            <Divider />

            {/* Recommendations */}
            <Box>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                <LightbulbIcon color="success" />
                <Typography level="title-md">Recommendations</Typography>
              </Stack>
              <List size="sm">
                {analysis.recommendations.map((rec, idx) => (
                  <ListItem key={`rec-${idx}`}>
                    <ListItemDecorator>
                      <CheckCircleIcon fontSize="small" color="success" />
                    </ListItemDecorator>
                    <Typography level="body-sm">{rec}</Typography>
                  </ListItem>
                ))}
              </List>
            </Box>

            {/* Historical Baselines */}
            {baselines && (
              <>
                <Divider />
                <Box>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                    <AnalyticsIcon color="primary" />
                    <Typography level="title-md">Historical Baselines</Typography>
                    <Chip size="sm" variant="outlined" color="neutral">
                      {baselines.windowDays}-day, N={baselines.sampleCount}
                    </Chip>
                  </Stack>
                  <Sheet variant="outlined" sx={{ borderRadius: 'sm', p: 1.5 }}>
                    <Stack spacing={0.5}>
                      <Typography level="body-sm">
                        Avg Response Time: {((baselines.avgResponseTimeMs || 0) / 1000).toFixed(1)}s
                      </Typography>
                      <Typography level="body-sm">
                        P95 Response Time: {((baselines.p95ResponseTimeMs || 0) / 1000).toFixed(1)}s
                      </Typography>
                      <Typography level="body-sm">
                        Normal Utilization: {baselines.utilizationRange?.low ?? 0}% –{' '}
                        {baselines.utilizationRange?.high ?? 0}% (mean ± 1σ)
                      </Typography>
                    </Stack>
                  </Sheet>
                </Box>
              </>
            )}

            {/* Analysis Source & Cache Info */}
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              {analysisSource && (
                <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                  Analysis source: {analysisSource}
                  {cached && cachedAt && ` (cached ${new Date(cachedAt).toLocaleString()})`}
                </Typography>
              )}
              {cached && onReanalyze && (
                <Button size="sm" variant="outlined" color="neutral" onClick={onReanalyze} disabled={isLoading}>
                  Re-analyze
                </Button>
              )}
            </Stack>
          </Stack>
        )}
      </ModalDialog>
    </Modal>
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
    <Modal open={open} onClose={handleClose}>
      <ModalDialog sx={{ maxWidth: 500 }}>
        <ModalClose />
        <Typography level="h4" sx={{ mb: 2 }}>
          Create GitHub Issue
        </Typography>

        <Stack spacing={2}>
          {!configuredRepo ? (
            <Alert color="warning" variant="outlined">
              No GitHub repository configured. Please configure GitHub owner and repo in the settings above.
            </Alert>
          ) : (
            <>
              <FormControl>
                <FormLabel>Repository</FormLabel>
                <Input value={repository} disabled />
                <FormHelperText>Configured in Alert & Integration Settings</FormHelperText>
              </FormControl>

              <FormControl>
                <FormLabel>Additional Context (Optional)</FormLabel>
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

              {createIssue.error && (
                <Alert color="danger" variant="outlined">
                  Failed to create issue: {createIssue.error.message}
                </Alert>
              )}

              <Stack direction="row" spacing={1} justifyContent="flex-end">
                <Button variant="outlined" color="neutral" onClick={handleClose}>
                  Cancel
                </Button>
                <Button
                  startDecorator={createIssue.isPending ? <CircularProgress size="sm" /> : <GitHubIcon />}
                  onClick={handleSubmit}
                  loading={createIssue.isPending}
                >
                  Create Issue
                </Button>
              </Stack>
            </>
          )}
        </Stack>
      </ModalDialog>
    </Modal>
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
  const heading = isDuplicate ? 'Existing Issue Found' : 'Issue Created';
  const description = isDuplicate
    ? `A GitHub issue already exists for this anomaly${issueNumber && issueNumber > 0 ? `: #${issueNumber}` : ''}.`
    : 'The GitHub issue has been created successfully.';
  const buttonLabel = isDuplicate ? 'View Existing Issue on GitHub' : 'View Issue on GitHub';

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog>
        <ModalClose />
        <Stack spacing={2} alignItems="center" sx={{ py: 2 }}>
          {isDuplicate ? (
            <InfoIcon sx={{ fontSize: 48, color: 'primary.500' }} />
          ) : (
            <CheckCircleIcon sx={{ fontSize: 48, color: 'success.500' }} />
          )}
          <Typography level="h4">{heading}</Typography>
          <Typography level="body-sm" textAlign="center">
            {description}
          </Typography>
          <Button component="a" href={issueUrl} target="_blank" rel="noopener noreferrer" startDecorator={<LinkIcon />}>
            {buttonLabel}
          </Button>
        </Stack>
      </ModalDialog>
    </Modal>
  );
};

// Health Check Card Component (matches LiveOps Triage pattern)
const HealthCheckCard = ({ check }: { check: HealthCheckItem }) => {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.5,
        p: 1.5,
        borderRadius: 'sm',
        border: '1px solid',
        borderColor: check.status === 'ok' ? 'success.400' : check.status === 'warning' ? 'warning.400' : 'danger.400',
        bgcolor: 'background.surface',
      }}
    >
      {check.status === 'ok' ? (
        <CheckCircleIcon sx={{ fontSize: 20, color: 'success.500', mt: 0.25 }} />
      ) : check.status === 'warning' ? (
        <WarningAmberIcon sx={{ fontSize: 20, color: 'warning.500', mt: 0.25 }} />
      ) : (
        <ErrorIcon sx={{ fontSize: 20, color: 'danger.500', mt: 0.25 }} />
      )}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          level="body-sm"
          fontWeight="lg"
          sx={{
            color: check.status === 'ok' ? 'success.700' : check.status === 'warning' ? 'warning.700' : 'danger.700',
          }}
        >
          {check.name}
        </Typography>
        <Typography level="body-xs" sx={{ color: 'text.secondary', wordBreak: 'break-word' }}>
          {check.message}
        </Typography>
      </Box>
    </Box>
  );
};

// Priority color mapping for dry run results
const PRIORITY_COLORS: Record<string, 'danger' | 'warning' | 'success' | 'neutral'> = {
  P0: 'danger',
  P1: 'warning',
  P2: 'warning',
  P3: 'success',
};

// Dry Run Result Card Component
const DryRunResultCard = ({ result }: { result: DryRunResult }) => {
  const priorityColor = PRIORITY_COLORS[result.action.priority] || 'neutral';

  return (
    <Box
      data-testid="dry-run-result-card"
      sx={{
        p: 1.5,
        borderRadius: 'sm',
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.level1',
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
        <Stack spacing={0.5}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip
              data-testid="dry-run-source-chip"
              size="sm"
              color={result.source === 'test' ? 'primary' : 'neutral'}
              variant="outlined"
            >
              {result.source === 'test' ? 'Test' : 'Real'}
            </Chip>
            <Chip data-testid="dry-run-priority-chip" size="sm" color={priorityColor} variant="soft">
              {result.action.priority}
            </Chip>
            <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
              {new Date(result.timestamp).toLocaleTimeString()}
            </Typography>
          </Stack>

          <Typography level="body-sm" fontWeight="md">
            {result.telemetrySummary.primaryAnomaly} (score: {result.telemetrySummary.anomalyScore})
          </Typography>

          <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
            {result.telemetrySummary.modelId} &bull; {result.telemetrySummary.provider}
          </Typography>
        </Stack>

        <Stack spacing={0.5} alignItems="flex-end">
          {result.action.wouldCreateIssue ? (
            <Chip
              data-testid="dry-run-create-issue-chip"
              size="sm"
              color="success"
              variant="soft"
              startDecorator={<GitHubIcon sx={{ fontSize: 14 }} />}
            >
              Would create issue
            </Chip>
          ) : result.action.isDuplicate ? (
            <Chip data-testid="dry-run-duplicate-chip" size="sm" color="neutral" variant="outlined">
              Duplicate of #{result.action.matchedIssueNumber}
            </Chip>
          ) : null}

          {result.action.isRegression && (
            <Chip data-testid="dry-run-regression-chip" size="sm" color="danger" variant="soft">
              Regression from #{result.action.regressedFromIssue}
            </Chip>
          )}

          {result.action.wouldSendSlackAlert && (
            <Chip data-testid="dry-run-slack-chip" size="sm" color="primary" variant="outlined">
              Would send Slack
            </Chip>
          )}
        </Stack>
      </Stack>

      {result.action.wouldCreateIssue && result.action.issueTitle && (
        <Typography level="body-xs" sx={{ mt: 1, color: 'text.secondary' }}>
          Title: {result.action.issueTitle}
        </Typography>
      )}
    </Box>
  );
};

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
      <Typography level="title-sm">Dry Run Testing</Typography>
      <Typography level="body-xs" sx={{ color: 'text.secondary', mb: 2 }}>
        Test your configuration without creating actual issues or sending alerts.
      </Typography>

      {/* Test Configuration Button */}
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
        <Button
          data-testid="dry-run-test-btn"
          variant="outlined"
          color="primary"
          startDecorator={<PlayArrowIcon />}
          onClick={handleTest}
          loading={testConfigMutation.isPending}
        >
          Test with Sample Data
        </Button>
        <Select
          data-testid="dry-run-sample-type-select"
          size="sm"
          value={selectedSampleType}
          onChange={(_, v) => v && setSelectedSampleType(v)}
          sx={{ minWidth: 120 }}
        >
          <Option value="critical">Critical</Option>
          <Option value="high">High</Option>
          <Option value="medium">Medium</Option>
          <Option value="low">Low</Option>
        </Select>
      </Stack>

      {/* Error display for test config */}
      {testConfigMutation.isError && (
        <Alert color="danger" variant="soft" sx={{ mb: 2 }}>
          Test failed: {testConfigMutation.error?.message || 'Unknown error'}
        </Alert>
      )}

      {/* Dry Run Results Panel */}
      <Card data-testid="dry-run-results-panel" variant="outlined">
        <CardContent>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Typography level="title-sm">Recent Dry Run Results</Typography>
            <IconButton data-testid="dry-run-refresh-btn" size="sm" variant="plain" onClick={() => refetchResults()}>
              <RefreshIcon />
            </IconButton>
          </Stack>

          {isResultsError ? (
            <Alert data-testid="dry-run-results-error" color="danger" variant="soft" size="sm">
              Failed to load dry run results. Try refreshing.
            </Alert>
          ) : isLoadingResults ? (
            <Box data-testid="dry-run-loading" sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
              <CircularProgress size="sm" />
            </Box>
          ) : !dryRunResults?.results.length ? (
            <Typography data-testid="dry-run-empty-state" level="body-sm" sx={{ color: 'text.secondary' }}>
              No dry run results yet. Enable dry run mode and trigger some anomalies, or use the test button above.
            </Typography>
          ) : (
            <Stack data-testid="dry-run-results-list" spacing={1}>
              {dryRunResults.results.map(result => (
                <DryRunResultCard key={result._id} result={result} />
              ))}
            </Stack>
          )}
        </CardContent>
      </Card>
    </>
  );
};

// Settings Section Component (matches What's New tab pattern with Save/Reset)
const SettingsSection = ({
  alertSettings,
  onUpdateSettings,
  isUpdating,
  updateError,
  integrationStatus,
  onRefreshHealth,
  isRefreshing,
}: {
  alertSettings: ContextTelemetryAlerts | undefined;
  onUpdateSettings: (settings: ContextTelemetryAlerts) => void;
  isUpdating: boolean;
  updateError: Error | null;
  integrationStatus: IntegrationHealthResponse | undefined;
  onRefreshHealth: () => void;
  isRefreshing: boolean;
}) => {
  const [configExpanded, setConfigExpanded] = useState(false);

  // Local state for editing (not saved until user clicks Save)
  const [localSettings, setLocalSettings] = useState<ContextTelemetryAlerts>(alertSettings ?? DEFAULT_ALERT_SETTINGS);

  // Sync local state when server data changes (including when settings are cleared)
  useEffect(() => {
    setLocalSettings(alertSettings ?? DEFAULT_ALERT_SETTINGS);
  }, [alertSettings]);

  // JSON round-trip strips undefined on both sides, so {key: undefined} vs {}
  // does not falsely register as an unsaved change
  const serverSettings = alertSettings ?? DEFAULT_ALERT_SETTINGS;
  const isDirty =
    JSON.stringify(JSON.parse(JSON.stringify(localSettings))) !==
    JSON.stringify(JSON.parse(JSON.stringify(serverSettings)));

  const handleSave = () => {
    onUpdateSettings(localSettings);
  };

  const handleReset = () => {
    setLocalSettings(alertSettings ?? DEFAULT_ALERT_SETTINGS);
  };

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
    <Box sx={{ p: 2 }}>
      {/* Section Header */}
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <SettingsIcon color="primary" />
          <Typography level="title-lg">Alert & Integration Settings</Typography>
          {integrationStatus?.overall && (
            <Chip
              size="sm"
              variant="outlined"
              color={
                integrationStatus.overall === 'healthy'
                  ? 'success'
                  : integrationStatus.overall === 'degraded'
                    ? 'warning'
                    : 'danger'
              }
            >
              {integrationStatus.overall.toUpperCase()}
            </Chip>
          )}
        </Stack>
        <Tooltip title="Refresh health status">
          <IconButton size="sm" variant="plain" onClick={onRefreshHealth} disabled={isRefreshing}>
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      </Stack>

      <Typography level="body-sm" sx={{ color: 'text.secondary', mb: 2 }}>
        Configure Slack alerts and GitHub issue creation for context telemetry anomalies.
      </Typography>

      {/* Integration Health Status */}
      {integrationStatus?.checks && (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 2, mb: 2 }}>
          {integrationStatus.checks.map((check, idx) => (
            <HealthCheckCard key={idx} check={check} />
          ))}
        </Box>
      )}

      {/* Configuration Accordion */}
      <AccordionGroup>
        <Accordion expanded={configExpanded} onChange={() => setConfigExpanded(!configExpanded)}>
          <AccordionSummary indicator={<ExpandMoreIcon />}>
            <Typography level="title-sm">Configuration</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Stack spacing={3} sx={{ pt: 1 }}>
              {/* Enable/Disable Toggle */}
              <Stack direction="row" spacing={2} alignItems="center">
                <Switch
                  checked={localSettings.enabled}
                  onChange={e => setLocalSettings({ ...localSettings, enabled: e.target.checked })}
                  disabled={isUpdating}
                  color={localSettings.enabled ? 'success' : 'neutral'}
                />
                <Box>
                  <Typography level="body-md" fontWeight="bold">
                    {localSettings.enabled ? 'Alerts Enabled' : 'Alerts Disabled'}
                  </Typography>
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    Send alerts to Slack when anomalies are detected
                  </Typography>
                </Box>
              </Stack>

              {/* Dry Run Mode Toggle */}
              <Stack direction="row" spacing={2} alignItems="center">
                <Switch
                  data-testid="dry-run-mode-toggle"
                  checked={localSettings.dryRun ?? false}
                  onChange={e => setLocalSettings({ ...localSettings, dryRun: e.target.checked })}
                  disabled={isUpdating}
                  color={localSettings.dryRun ? 'warning' : 'neutral'}
                />
                <Box>
                  <Typography level="body-md" fontWeight="bold">
                    Dry Run Mode
                  </Typography>
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    Log actions without creating issues or sending alerts
                  </Typography>
                </Box>
              </Stack>

              <Divider />

              {/* Slack Integration */}
              <Typography level="title-sm">Slack Integration</Typography>
              <Grid container spacing={2}>
                <Grid xs={12} md={6}>
                  <FormControl>
                    <FormLabel>Slack Workspace</FormLabel>
                    {isWorkspacesError ? (
                      <Alert color="danger" variant="outlined" size="sm" sx={{ mt: 1 }}>
                        Failed to load Slack workspaces. Check your connection and try again.
                      </Alert>
                    ) : workspacesData?.workspaces.length === 0 ? (
                      <Alert color="warning" variant="outlined" size="sm" sx={{ mt: 1 }}>
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
                    />
                    <FormHelperText>Slack channel ID for anomaly alerts</FormHelperText>
                  </FormControl>
                </Grid>
              </Grid>

              <Divider />

              {/* GitHub Integration */}
              <Typography level="title-sm">GitHub Integration</Typography>
              <Grid container spacing={2}>
                <Grid xs={12} md={6}>
                  <FormControl>
                    <FormLabel>GitHub Owner</FormLabel>
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
                    <FormLabel>GitHub Repo</FormLabel>
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
                  <FormControl>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <Switch
                        checked={localSettings.autoCreateIssues ?? false}
                        onChange={e => setLocalSettings({ ...localSettings, autoCreateIssues: e.target.checked })}
                        disabled={isUpdating}
                      />
                      <Box>
                        <Typography level="body-sm">Auto-create GitHub Issues</Typography>
                        <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                          Automatically create issues for critical anomalies
                        </Typography>
                      </Box>
                    </Box>
                  </FormControl>
                </Grid>
              </Grid>

              <Divider />

              {/* LLM Configuration */}
              <Typography level="title-sm">LLM Configuration</Typography>
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
                          <Typography level="body-xs" sx={{ textTransform: 'uppercase', fontWeight: 'bold' }}>
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
                    <FormLabel>Max Tokens</FormLabel>
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
                    <FormLabel>LLM Analysis Threshold</FormLabel>
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
              <Typography level="title-sm">Alert Thresholds</Typography>
              <Grid container spacing={2}>
                <Grid xs={12} md={4}>
                  <FormControl>
                    <FormLabel>Alert Threshold</FormLabel>
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
                    <FormLabel>Critical Threshold</FormLabel>
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
                    <FormLabel>Dedup Window (Minutes)</FormLabel>
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
              <Typography level="title-sm">Performance Targets (SLOs)</Typography>
              <Grid container spacing={2}>
                <Grid xs={12} md={6}>
                  <FormControl>
                    <FormLabel>Response Time P95 (seconds)</FormLabel>
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
                    <FormLabel>First Token Time (seconds)</FormLabel>
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
                    <FormLabel>Error Rate (%)</FormLabel>
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
                    <FormLabel>Context Utilization (%)</FormLabel>
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
              <Typography level="title-sm">Historical Baselines</Typography>
              <Grid container spacing={2}>
                <Grid xs={12} md={6}>
                  <FormControl>
                    <FormLabel>Baseline Window (days)</FormLabel>
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

              {/* Save/Reset Buttons */}
              <Divider />
              <Stack direction="row" spacing={2} justifyContent="flex-end" alignItems="center">
                {isDirty && (
                  <Chip size="sm" color="warning" variant="outlined">
                    Unsaved changes
                  </Chip>
                )}
                <Button
                  data-testid="settings-reset-btn"
                  variant="outlined"
                  color="neutral"
                  onClick={handleReset}
                  disabled={!isDirty || isUpdating}
                >
                  Reset
                </Button>
                <Button
                  data-testid="settings-save-btn"
                  variant="solid"
                  color="primary"
                  onClick={handleSave}
                  disabled={!isDirty || isUpdating}
                  loading={isUpdating}
                >
                  Save
                </Button>
              </Stack>

              {/* Save error display */}
              {updateError && (
                <Alert data-testid="settings-save-error" color="danger" variant="soft" sx={{ mt: 2 }}>
                  Failed to save settings: {updateError.message || 'Unknown error'}
                </Alert>
              )}

              {/* Dry Run Testing - only visible when dryRun is enabled */}
              {localSettings.dryRun && <DryRunSection />}
            </Stack>
          </AccordionDetails>
        </Accordion>
      </AccordionGroup>
    </Box>
  );
};

// Individual telemetry entry card
const TelemetryEntryCard = ({
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
      <Card variant="outlined" sx={{ mb: 1 }}>
        <CardContent>
          <Typography level="body-sm" color="neutral">
            No telemetry data available
          </Typography>
        </CardContent>
      </Card>
    );
  }

  const { model, contextWindow, performance, anomalies, tools, subagents } = telemetry;

  return (
    <Card variant="outlined" sx={{ mb: 1 }}>
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <SeverityIcon severity={anomalies.severity} />
            <Typography level="title-sm">{model.modelId}</Typography>
            <Chip size="sm" variant="outlined">
              {model.provider}
            </Chip>
            {model.fallbackUsed && (
              <Chip size="sm" color="warning" variant="outlined">
                Fallback
              </Chip>
            )}
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center">
            <Tooltip title="Analyze anomalies">
              <IconButton size="sm" variant="outlined" color="primary" onClick={() => onAnalyze(entry.id)}>
                <AnalyticsIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title={githubEnabled ? 'Create GitHub Issue' : 'GitHub not configured'}>
              <span>
                <IconButton
                  size="sm"
                  variant="outlined"
                  color="neutral"
                  onClick={() => onCreateIssue(entry.id)}
                  disabled={!githubEnabled}
                >
                  <GitHubIcon />
                </IconButton>
              </span>
            </Tooltip>
            <Typography level="body-xs" color="neutral">
              {new Date(entry.timestamp).toLocaleString()}
            </Typography>
          </Stack>
        </Stack>

        <Grid container spacing={2} sx={{ mb: 1 }}>
          <Grid xs={6} md={3}>
            <Typography level="body-xs" color="neutral">
              Input Tokens
            </Typography>
            <Typography level="body-sm" fontWeight="md">
              {contextWindow.inputTokens.toLocaleString()}
            </Typography>
          </Grid>
          <Grid xs={6} md={3}>
            <Typography level="body-xs" color="neutral">
              Utilization
            </Typography>
            <Stack direction="row" alignItems="center" spacing={1}>
              <LinearProgress
                determinate
                value={Math.min(contextWindow.utilizationPercentage, 100)}
                color={
                  contextWindow.utilizationPercentage >= 90
                    ? 'danger'
                    : contextWindow.utilizationPercentage >= 75
                      ? 'warning'
                      : 'success'
                }
                sx={{ flexGrow: 1 }}
              />
              <Typography level="body-sm">{contextWindow.utilizationPercentage.toFixed(1)}%</Typography>
            </Stack>
          </Grid>
          <Grid xs={6} md={3}>
            <Typography level="body-xs" color="neutral">
              Response Time
            </Typography>
            <Typography level="body-sm" fontWeight="md">
              {(performance.totalResponseTimeMs / 1000).toFixed(2)}s
            </Typography>
          </Grid>
          <Grid xs={6} md={3}>
            <Typography level="body-xs" color="neutral">
              Anomaly Score
            </Typography>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography
                level="body-sm"
                fontWeight="md"
                color={anomalies.anomalyScore >= 50 ? 'danger' : anomalies.anomalyScore >= 30 ? 'warning' : 'success'}
              >
                {anomalies.anomalyScore}/100
              </Typography>
            </Stack>
          </Grid>
        </Grid>

        <AnomalyIndicators anomalies={anomalies} />

        <Accordion expanded={expanded} onChange={() => setExpanded(!expanded)} sx={{ mt: 1 }}>
          <AccordionSummary indicator={<ExpandMoreIcon />}>
            <Typography level="body-sm">Details</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Stack spacing={2}>
              {/* Basic-tier notice: system prompts & feature breakdown require Enhanced */}
              {!telemetry.systemPrompts && (
                <Typography level="body-xs" sx={{ fontStyle: 'italic', color: 'text.tertiary' }}>
                  Basic tier — system prompt breakdown and feature details require <strong>Enhanced</strong> telemetry.
                </Typography>
              )}
              {/* Token Distribution */}
              {contextWindow.tokensBySource && (
                <Box>
                  <Typography level="body-sm" fontWeight="md" sx={{ mb: 1 }}>
                    Token Distribution
                  </Typography>
                  <TokenDistributionBar tokensBySource={contextWindow.tokensBySource} />
                </Box>
              )}

              {/* System Prompt Details */}
              {telemetry.systemPrompts && telemetry.systemPrompts.prompts.length > 0 && (
                <Box>
                  <Typography level="body-sm" fontWeight="md" sx={{ mb: 1 }}>
                    System Prompts ({telemetry.systemPrompts.totalTokens.toLocaleString()} tokens)
                  </Typography>
                  <Grid container spacing={1}>
                    {telemetry.systemPrompts.prompts.map(prompt => (
                      <Grid key={`${prompt.name}-${prompt.source}`} xs={4} md={2}>
                        <Typography level="body-xs" color="neutral">
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
                  <Typography level="body-sm" fontWeight="md" sx={{ mb: 1 }}>
                    Tools ({tools.length})
                  </Typography>
                  <Table size="sm">
                    <thead>
                      <tr>
                        <th>Tool</th>
                        <th>Calls</th>
                        <th>Failures</th>
                        <th>Avg Time</th>
                        <th>Last Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tools.slice(0, 10).map(tool => (
                        <tr key={tool.toolName}>
                          <td>{tool.toolName}</td>
                          <td>{tool.invocationCount}</td>
                          <td>
                            {tool.failureCount > 0 ? (
                              <Chip size="sm" color="danger" variant="outlined">
                                {tool.failureCount}
                              </Chip>
                            ) : (
                              0
                            )}
                          </td>
                          <td>
                            {tool.invocationCount > 0 ? (tool.totalDurationMs / tool.invocationCount).toFixed(0) : '-'}
                            ms
                          </td>
                          <td>
                            <Typography level="body-xs" sx={{ maxWidth: 200 }} noWrap>
                              {tool.lastError ?? '-'}
                            </Typography>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Box>
              )}

              {/* Subagents */}
              {subagents && subagents.length > 0 && (
                <Box>
                  <Typography level="body-sm" fontWeight="md" sx={{ mb: 1 }}>
                    Subagents ({subagents.length})
                  </Typography>
                  <Table size="sm">
                    <thead>
                      <tr>
                        <th>Agent</th>
                        <th>Delegations</th>
                        <th>Timeouts</th>
                        <th>Total Time</th>
                        <th>Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {subagents.map(agent => (
                        <tr key={agent.agentName}>
                          <td>{agent.agentName}</td>
                          <td>{agent.delegationCount}</td>
                          <td>
                            {agent.timeoutCount > 0 ? (
                              <Chip size="sm" color="danger" variant="outlined">
                                {agent.timeoutCount}
                              </Chip>
                            ) : (
                              0
                            )}
                          </td>
                          <td>{(agent.totalDurationMs / 1000).toFixed(1)}s</td>
                          <td>{agent.totalTokensUsed.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Box>
              )}

              {/* Fallback Info */}
              {model.fallbackUsed && (
                <Box>
                  <Typography level="body-sm" fontWeight="md" sx={{ mb: 1 }}>
                    Fallback Details
                  </Typography>
                  <Typography level="body-sm">Original Model: {model.originalModelId ?? 'Unknown'}</Typography>
                  <Typography level="body-sm">Reason: {model.fallbackReason ?? 'Unknown'}</Typography>
                </Box>
              )}
            </Stack>
          </AccordionDetails>
        </Accordion>
      </CardContent>
    </Card>
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

  const handleUpdateAlertSettings = (newSettings: ContextTelemetryAlerts) => {
    updateSettings.mutate({
      key: 'contextTelemetryAlerts',
      value: newSettings,
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

  return (
    <Box sx={{ p: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography level="h4">Context Telemetry Inspector</Typography>
        <Stack direction="row" spacing={2} alignItems="center">
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography level="body-sm">Telemetry Collection</Typography>
            <Switch checked={telemetryEnabled} onChange={handleToggleTelemetry} disabled={updateSettings.isPending} />
            <Chip size="sm" color={telemetryEnabled ? 'success' : 'neutral'} variant="outlined">
              {telemetryEnabled ? 'Enabled' : 'Disabled'}
            </Chip>
          </Stack>
          <Button
            startDecorator={isFetching ? <CircularProgress size="sm" /> : <RefreshIcon />}
            variant="outlined"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? 'Refreshing...' : 'Refresh'}
          </Button>
        </Stack>
      </Stack>

      {!telemetryEnabled && (
        <Alert color="warning" variant="outlined" sx={{ mb: 2 }}>
          Telemetry collection is disabled. Enable it to start capturing operational metadata for new completions.
        </Alert>
      )}

      {/* Settings Section */}
      <Sheet variant="outlined" sx={{ mb: 2, borderRadius: 'sm' }}>
        <SettingsSection
          alertSettings={alertSettings}
          onUpdateSettings={handleUpdateAlertSettings}
          isUpdating={updateSettings.isPending}
          updateError={updateSettings.error}
          integrationStatus={integrationStatus}
          onRefreshHealth={() => refetchIntegrationStatus()}
          isRefreshing={isRefreshingIntegration}
        />
      </Sheet>

      {/* Stats Overview */}
      {data?.stats && (
        <Grid container spacing={2} sx={{ mb: 2 }}>
          <Grid xs={6} md={2}>
            <Card variant="soft">
              <CardContent>
                <Typography level="body-xs" color="neutral">
                  Total Entries
                </Typography>
                <Typography level="h4">{data.stats.totalEntries.toLocaleString()}</Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid xs={6} md={2}>
            <Card variant="soft">
              <CardContent>
                <Typography level="body-xs" color="neutral">
                  Avg Anomaly Score
                </Typography>
                <Typography level="h4" color={data.stats.avgAnomalyScore >= 30 ? 'danger' : 'success'}>
                  {data.stats.avgAnomalyScore}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid xs={6} md={2}>
            <Card variant="soft">
              <CardContent>
                <Typography level="body-xs" color="neutral">
                  Avg Utilization
                </Typography>
                <Typography level="h4" color={data.stats.avgUtilization >= 90 ? 'danger' : 'success'}>
                  {data.stats.avgUtilization}%
                </Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid xs={6} md={2}>
            <Card variant="soft">
              <CardContent>
                <Typography level="body-xs" color="neutral">
                  Avg Response Time
                </Typography>
                <Typography level="h4">{(data.stats.avgResponseTimeMs / 1000).toFixed(1)}s</Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid xs={12} md={4}>
            <Card variant="soft">
              <CardContent>
                <Typography level="body-xs" color="neutral">
                  Severity Distribution
                </Typography>
                <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
                  {(['critical', 'high', 'medium', 'low'] as AnomalySeverity[]).map(sev => (
                    <Chip
                      key={sev}
                      size="sm"
                      variant="outlined"
                      sx={{ borderColor: SEVERITY_COLORS[sev], color: SEVERITY_COLORS[sev] }}
                    >
                      {sev}: {data.stats.severityDistribution[sev] ?? 0}
                    </Chip>
                  ))}
                </Stack>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      )}

      {/* Filters */}
      <Sheet variant="outlined" sx={{ p: 2, mb: 2, borderRadius: 'sm' }}>
        <Grid container spacing={2} alignItems="flex-end">
          <Grid xs={6} md={2}>
            <Typography level="body-sm" sx={{ mb: 0.5 }}>
              Start Date
            </Typography>
            <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} size="sm" />
          </Grid>
          <Grid xs={6} md={2}>
            <Typography level="body-sm" sx={{ mb: 0.5 }}>
              End Date
            </Typography>
            <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} size="sm" />
          </Grid>
          <Grid xs={6} md={2}>
            <Typography level="body-sm" sx={{ mb: 0.5 }}>
              Provider
            </Typography>
            <Select size="sm" value={provider} onChange={(_, v) => setProvider(v)} placeholder="All Providers">
              <Option value={null}>All Providers</Option>
              {data?.stats?.providers?.map(p => (
                <Option key={p} value={p}>
                  {p}
                </Option>
              ))}
            </Select>
          </Grid>
          <Grid xs={6} md={2}>
            <Typography level="body-sm" sx={{ mb: 0.5 }}>
              Min Anomaly Score
            </Typography>
            <Select size="sm" value={minAnomalyScore} onChange={(_, v) => setMinAnomalyScore(v)} placeholder="Any">
              <Option value={null}>Any (&gt;0)</Option>
              <Option value={30}>30+</Option>
              <Option value={50}>50+</Option>
              <Option value={70}>70+</Option>
            </Select>
          </Grid>
          <Grid xs={6} md={2}>
            <Typography level="body-sm" sx={{ mb: 0.5 }}>
              Severity
            </Typography>
            <Select size="sm" value={severity} onChange={(_, v) => setSeverity(v)} placeholder="All">
              <Option value={null}>All</Option>
              <Option value="critical">Critical</Option>
              <Option value="high">High</Option>
              <Option value="medium">Medium</Option>
              <Option value="low">Low</Option>
            </Select>
          </Grid>
          <Grid xs={6} md={2}>
            <Typography level="body-sm" sx={{ mb: 0.5 }}>
              Anomaly Type
            </Typography>
            <Select size="sm" value={anomalyType} onChange={(_, v) => setAnomalyType(v)} placeholder="All">
              <Option value={null}>All</Option>
              <Option value="context_overflow">Context Overflow</Option>
              <Option value="high_truncation">High Truncation</Option>
              <Option value="tool_failure">Tool Failure</Option>
              <Option value="subagent_timeout">Subagent Timeout</Option>
              <Option value="slow_response">Slow Response</Option>
              <Option value="multiple">Multiple</Option>
            </Select>
          </Grid>
        </Grid>
      </Sheet>

      {/* Results */}
      {isLoading || isFetching ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, py: 4 }}>
          <CircularProgress />
          <Typography level="body-sm" color="neutral">
            {isLoading ? 'Loading telemetry data...' : 'Refreshing...'}
          </Typography>
        </Box>
      ) : error ? (
        <Card color="danger" variant="soft">
          <CardContent>
            <Typography>Error loading telemetry data: {(error as Error).message}</Typography>
          </CardContent>
        </Card>
      ) : !data?.entries?.length ? (
        <Card variant="outlined">
          <CardContent>
            <Typography level="body-md" color="neutral" textAlign="center">
              No telemetry entries found. Context telemetry is recorded for new completions when enabled.
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <>
          <Typography level="body-sm" color="neutral" sx={{ mb: 1 }}>
            Showing {data.entries.length} of {data.total} entries
          </Typography>
          <AccordionGroup>
            {data.entries.map(entry => (
              <TelemetryEntryCard
                key={entry.id}
                entry={entry}
                onAnalyze={handleAnalyze}
                onCreateIssue={handleCreateIssue}
                githubEnabled={integrationStatus?.github ?? false}
              />
            ))}
          </AccordionGroup>

          {/* Pagination */}
          {totalPages > 1 && (
            <Stack direction="row" justifyContent="center" spacing={1} sx={{ mt: 2 }}>
              <Button size="sm" variant="outlined" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                Previous
              </Button>
              <Typography level="body-sm" sx={{ alignSelf: 'center' }}>
                Page {page + 1} of {totalPages}
              </Typography>
              <Button
                size="sm"
                variant="outlined"
                disabled={page >= totalPages - 1}
                onClick={() => setPage(p => p + 1)}
              >
                Next
              </Button>
            </Stack>
          )}
        </>
      )}

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
    </Box>
  );
}

export default ContextInspectorTab;
