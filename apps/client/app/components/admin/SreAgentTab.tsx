/**
 * SRE Agent Configuration & Monitoring Tab
 *
 * Provides a dedicated admin UI for the SRE Agent Trio pipeline:
 *   - Master config controls (enabled, dry-run, sources, gates)
 *   - Pipeline status (recent tracked errors)
 *   - Pattern library management
 *   - Circuit breaker status
 */

import {
  Accordion as JoyAccordion,
  AccordionDetails as JoyAccordionDetails,
  AccordionSummary as JoyAccordionSummary,
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormHelperText,
  FormLabel,
  IconButton,
  Input,
  Link,
  Modal,
  ModalDialog,
  Option,
  Select,
  Sheet,
  Stack,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Table,
  Tabs,
  Textarea,
  Typography,
} from '@mui/joy';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useGetSettingsValue, useUpdateSettings } from '@client/app/hooks/data/settings';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import {
  SreAgentConfigSchema,
  SreRepoConfigSchema,
  SRE_SECRET_PLACEHOLDER,
  getConfiguredRepoSlugs,
  type ModelInfo,
  type SreAgentConfig,
  type SreRepoConfig,
} from '@bike4mind/common';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { isAxiosError } from 'axios';
import SaveIcon from '@mui/icons-material/Save';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ReplayIcon from '@mui/icons-material/Replay';
import CancelIcon from '@mui/icons-material/Cancel';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { TrackingDetailContent, STATUS_COLORS, formatDate } from './TrackingDetailDrawer';
import type { ISreErrorTracking } from '@bike4mind/database/infra';

// Config Section

function ConfigSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card variant="outlined" sx={{ mb: 2 }}>
      <CardContent>
        <Typography level="title-md" sx={{ mb: 2 }}>
          {title}
        </Typography>
        {children}
      </CardContent>
    </Card>
  );
}

/** Collapsible config section using MUI Joy Accordion */
function CollapsibleSection({
  title,
  children,
  defaultExpanded = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultExpanded?: boolean;
}) {
  return (
    <JoyAccordion defaultExpanded={defaultExpanded} sx={{ mb: 1 }}>
      <JoyAccordionSummary>
        <Typography level="title-md">{title}</Typography>
      </JoyAccordionSummary>
      <JoyAccordionDetails>{children}</JoyAccordionDetails>
    </JoyAccordion>
  );
}

// Numeric Input (allows clearing during edit)

/**
 * Wraps MUI Joy Input for number fields. Holds raw string while editing
 * so users can clear and retype values. Coerces to number on blur.
 */
function NumericInput({
  value,
  onChange,
  min,
  max,
  ...rest
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
} & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange' | 'type'>) {
  const [raw, setRaw] = useState<string>(String(value));
  // Sync external value when it changes (e.g., reset)
  useEffect(() => {
    setRaw(String(value));
  }, [value]);
  return (
    <Input
      {...rest}
      type="number"
      value={raw}
      slotProps={{ input: { min, max } }}
      onChange={e => setRaw(e.target.value)}
      onBlur={() => {
        let n = Number(raw);
        if (isNaN(n) || raw === '') n = min ?? 0;
        if (min !== undefined && n < min) n = min;
        if (max !== undefined && n > max) n = max;
        setRaw(String(n));
        onChange(n);
      }}
    />
  );
}

// Repo Config Editor

/** Helper: update a nested optional field on repo config. Clears to undefined when empty. */
function setRepoField<K extends keyof SreRepoConfig>(
  repo: SreRepoConfig,
  key: K,
  value: SreRepoConfig[K] | undefined,
  onChange: (updated: SreRepoConfig) => void
) {
  const updated = { ...repo };
  if (value === undefined || value === '' || (typeof value === 'number' && isNaN(value))) {
    delete updated[key];
  } else {
    updated[key] = value;
  }
  onChange(updated);
}

/** Gate editor for per-repo gate config */
function RepoGateEditor({
  label,
  gate,
  onChange,
}: {
  label: string;
  gate: { enabled: boolean; autoThreshold: number; askThreshold: number; approvalTimeoutHours: number };
  onChange: (g: {
    enabled: boolean;
    autoThreshold: number;
    askThreshold: number;
    approvalTimeoutHours: number;
  }) => void;
}) {
  return (
    <Card variant="soft" sx={{ mb: 1 }}>
      <CardContent>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography level="title-sm">{label}</Typography>
          <Switch checked={gate.enabled} onChange={e => onChange({ ...gate, enabled: e.target.checked })} size="sm" />
        </Stack>
        {gate.enabled && (
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={2}>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Auto Threshold</FormLabel>
                <NumericInput
                  size="sm"
                  value={gate.autoThreshold}
                  min={0}
                  max={100}
                  onChange={n => onChange({ ...gate, autoThreshold: n })}
                />
                <FormHelperText>Auto-approve above this confidence</FormHelperText>
              </FormControl>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Ask Threshold</FormLabel>
                <NumericInput
                  size="sm"
                  value={gate.askThreshold}
                  min={0}
                  max={100}
                  onChange={n => onChange({ ...gate, askThreshold: n })}
                />
                <FormHelperText>Request human review above this</FormHelperText>
              </FormControl>
            </Stack>
            <Stack direction="row" spacing={2}>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Approval Timeout (hours)</FormLabel>
                <NumericInput
                  size="sm"
                  value={gate.approvalTimeoutHours}
                  min={1}
                  onChange={n => onChange({ ...gate, approvalTimeoutHours: n })}
                />
              </FormControl>
              <Box sx={{ flex: 1 }} />
            </Stack>
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

interface SlackWorkspace {
  id: string;
  name: string;
  slackTeamId: string;
  isActive: boolean;
}

function RepoConfigCard({
  repo,
  index,
  onChange,
  onRemove,
  models,
  modelsByProvider,
  workspaces,
}: {
  repo: SreRepoConfig;
  index: number;
  onChange: (updated: SreRepoConfig) => void;
  onRemove: () => void;
  models: ModelInfo[];
  modelsByProvider: Record<string, ModelInfo[]>;
  workspaces: SlackWorkspace[];
}) {
  const currentModelInfo = models?.find(m => m.id === repo.modelId);
  const isSecretMasked = repo.webhookSecret === SRE_SECRET_PLACEHOLDER;
  const isCallbackMasked = repo.callbackToken === SRE_SECRET_PLACEHOLDER;

  const generateToken = useCallback(() => {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    const token = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
    onChange({ ...repo, callbackToken: token });
  }, [repo, onChange]);

  return (
    <Card variant="outlined" sx={{ mb: 2 }}>
      <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {/* Card header: repo name + delete button */}
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Typography level="title-lg">
            {repo.owner && repo.repo ? `${repo.owner}/${repo.repo}` : `Repository #${index + 1}`}
          </Typography>
          <IconButton
            size="sm"
            variant="plain"
            color="danger"
            onClick={onRemove}
            data-testid={`sre-repo-remove-${index}`}
            aria-label="Delete repository"
          >
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Stack>

        {/* Master Controls */}
        <ConfigSection title="Master Controls">
          <Stack spacing={2}>
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Box>
                <Typography level="title-sm">Pipeline Enabled</Typography>
                <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                  Master kill switch for the entire SRE Agent pipeline
                </Typography>
              </Box>
              <Switch
                checked={repo.enabled}
                onChange={e => onChange({ ...repo, enabled: e.target.checked })}
                color={repo.enabled ? 'success' : 'neutral'}
                size="sm"
              />
            </Stack>
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Box>
                <Typography level="title-sm">Dry Run Mode</Typography>
                <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                  Log actions without dispatching fixes
                </Typography>
              </Box>
              <Switch
                checked={repo.dryRun}
                onChange={e => onChange({ ...repo, dryRun: e.target.checked })}
                color={repo.dryRun ? 'warning' : 'neutral'}
                size="sm"
              />
            </Stack>
            <Stack direction="row" spacing={2}>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Max Fixes/Day</FormLabel>
                <NumericInput
                  size="sm"
                  value={repo.maxFixesPerDay}
                  min={0}
                  onChange={n => onChange({ ...repo, maxFixesPerDay: n })}
                />
              </FormControl>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Max Diff Lines</FormLabel>
                <NumericInput
                  size="sm"
                  value={repo.maxDiffLines}
                  min={1}
                  onChange={n => onChange({ ...repo, maxDiffLines: n })}
                />
              </FormControl>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Max Revisions</FormLabel>
                <NumericInput
                  size="sm"
                  value={repo.maxRevisions}
                  min={0}
                  max={10}
                  onChange={n => onChange({ ...repo, maxRevisions: n })}
                />
                <FormHelperText>
                  {repo.maxRevisions === 0
                    ? 'Revisions disabled — failed fixes will not be retried'
                    : `Up to ${repo.maxRevisions} revision attempt(s) per fix`}
                </FormHelperText>
              </FormControl>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Max CI Retries</FormLabel>
                <NumericInput
                  size="sm"
                  value={repo.maxCiRetries}
                  min={0}
                  max={3}
                  onChange={n => onChange({ ...repo, maxCiRetries: n })}
                />
                <FormHelperText>
                  {repo.maxCiRetries === 0
                    ? 'CI retries disabled — typecheck/apply failures will hard-fail'
                    : `Up to ${repo.maxCiRetries} CI retry attempt(s) before hard-failing`}
                </FormHelperText>
              </FormControl>
            </Stack>
          </Stack>
        </ConfigSection>

        {/* Model Configuration */}
        <CollapsibleSection title="Model Configuration">
          <FormControl>
            <FormLabel>Diagnostician LLM Model</FormLabel>
            <Select
              size="sm"
              value={repo.modelId}
              onChange={(_, value) => {
                if (value && !String(value).startsWith('__header_')) {
                  onChange({ ...repo, modelId: String(value) });
                }
              }}
              placeholder="Choose a model..."
            >
              {Object.entries(modelsByProvider)
                .map(([provider, providerModels]) => [
                  <Option key={`${provider}-header`} value={`__header_${provider}`} disabled>
                    <Typography level="body-xs" sx={{ fontWeight: 'bold', textTransform: 'uppercase' }}>
                      {provider}
                    </Typography>
                  </Option>,
                  ...providerModels.map(model => (
                    <Option key={model.id} value={model.id}>
                      {model.name}
                    </Option>
                  )),
                ])
                .flat()}
            </Select>
            <FormHelperText>Model used for root cause analysis and fix generation</FormHelperText>
          </FormControl>
          {currentModelInfo && (
            <Alert size="sm" variant="soft" color="success" startDecorator={<CheckCircleIcon />} sx={{ mt: 0.5 }}>
              <Typography level="body-sm">
                <strong>{currentModelInfo.name}</strong> ({currentModelInfo.backend}) &bull;{' '}
                {Math.round((currentModelInfo.contextWindow || 0) / 1000)}K context
              </Typography>
            </Alert>
          )}
          <FormControl sx={{ mt: 2 }}>
            <FormLabel>Repository-Specific Instructions</FormLabel>
            <Textarea
              size="sm"
              minRows={3}
              maxRows={8}
              placeholder="Critical constraints the diagnostician must follow (e.g. 'All DB calls must go through the QueryBuilder wrapper'). For general coding conventions, use CLAUDE.md."
              slotProps={{ textarea: { maxLength: 2000 } }}
              value={repo.sreInstructions ?? ''}
              onChange={e => setRepoField(repo, 'sreInstructions', e.target.value || undefined, onChange)}
            />
            <FormHelperText>
              Critical constraints for automated fixes (max 2,000 chars). Not for general coding conventions — use
              CLAUDE.md for those.
            </FormHelperText>
          </FormControl>
        </CollapsibleSection>

        {/* Integrations */}
        <CollapsibleSection title="Integrations">
          <Stack spacing={2}>
            {/* Slack sub-card */}
            <Card variant="soft">
              <CardContent>
                <Typography level="title-sm" sx={{ mb: 0.5 }}>
                  Slack
                </Typography>
                <Typography level="body-xs" sx={{ color: 'text.secondary', mb: 1.5 }}>
                  Used for approval messages when confidence falls in the &quot;ask&quot; band.
                </Typography>
                <Stack spacing={1.5}>
                  <Stack direction="row" spacing={2}>
                    <FormControl sx={{ flex: 1 }}>
                      <FormLabel>Workspace</FormLabel>
                      {workspaces.length === 0 ? (
                        <Alert size="sm" variant="soft" color="warning">
                          No Slack workspaces found. Install one via Admin &rarr; Slack.
                        </Alert>
                      ) : (
                        <Select
                          size="sm"
                          value={repo.slack?.workspaceId || ''}
                          onChange={(_, value) => {
                            onChange({
                              ...repo,
                              slack: {
                                ...repo.slack,
                                workspaceId: value || undefined,
                                approverIds: repo.slack?.approverIds ?? '',
                              },
                            });
                          }}
                          placeholder="Select a workspace..."
                        >
                          {workspaces.map(ws => (
                            <Option key={ws.id} value={ws.id}>
                              {ws.name || ws.slackTeamId}
                            </Option>
                          ))}
                        </Select>
                      )}
                    </FormControl>
                    <FormControl sx={{ flex: 1 }}>
                      <FormLabel>Channel ID</FormLabel>
                      <Input
                        size="sm"
                        placeholder="e.g. C06CWQNTSAH"
                        value={repo.slack?.channelId ?? ''}
                        onChange={e => {
                          const val = e.target.value || undefined;
                          onChange({
                            ...repo,
                            slack: { ...repo.slack, channelId: val, approverIds: repo.slack?.approverIds ?? '' },
                          });
                        }}
                      />
                      <FormHelperText>Channel for approval messages (use channel ID, not name)</FormHelperText>
                    </FormControl>
                  </Stack>
                  <FormControl>
                    <FormLabel>Approver IDs</FormLabel>
                    <Input
                      size="sm"
                      placeholder="e.g. U01ABC123, U02DEF456"
                      value={repo.slack?.approverIds ?? ''}
                      onChange={e => {
                        onChange({ ...repo, slack: { ...repo.slack, approverIds: e.target.value } });
                      }}
                    />
                    <FormHelperText>
                      Comma-separated Slack user IDs authorized to approve/reject fixes. Leave empty to allow anyone in
                      the channel.
                    </FormHelperText>
                  </FormControl>
                </Stack>
              </CardContent>
            </Card>

            {/* GitHub sub-card */}
            <Card variant="soft">
              <CardContent>
                <Typography level="title-sm" sx={{ mb: 0.5 }}>
                  GitHub
                </Typography>
                <Typography level="body-xs" sx={{ color: 'text.secondary', mb: 1.5 }}>
                  Target repository for issue intake, code analysis, and fix PRs. Uses the system default GitHub
                  connection.
                </Typography>
                <Stack spacing={1.5}>
                  <Stack direction="row" spacing={2}>
                    <FormControl sx={{ flex: 1 }}>
                      <FormLabel>Owner</FormLabel>
                      <Input
                        size="sm"
                        placeholder="e.g. MillionOnMars"
                        value={repo.owner}
                        onChange={e => onChange({ ...repo, owner: e.target.value })}
                        data-testid={`sre-repo-owner-${index}`}
                      />
                      <FormHelperText>GitHub org or user</FormHelperText>
                    </FormControl>
                    <FormControl sx={{ flex: 1 }}>
                      <FormLabel>Repository</FormLabel>
                      <Input
                        size="sm"
                        placeholder="e.g. lumina5"
                        value={repo.repo}
                        onChange={e => onChange({ ...repo, repo: e.target.value })}
                        data-testid={`sre-repo-name-${index}`}
                      />
                      <FormHelperText>Repository name</FormHelperText>
                    </FormControl>
                  </Stack>
                  <FormControl>
                    <FormLabel>PR Reviewers</FormLabel>
                    <Input
                      size="sm"
                      placeholder="e.g. octocat, hubot"
                      value={repo.reviewers ?? ''}
                      onChange={e => setRepoField(repo, 'reviewers', e.target.value || undefined, onChange)}
                    />
                    <FormHelperText>Comma-separated GitHub usernames to request as reviewers on fix PRs</FormHelperText>
                  </FormControl>
                  <Divider />
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    Workflow callback authentication — token is stored encrypted, URL is derived automatically.
                  </Typography>
                  <FormControl>
                    <FormLabel>Callback Token</FormLabel>
                    <Input
                      size="sm"
                      placeholder={
                        isCallbackMasked
                          ? 'Token configured — enter new value to change'
                          : 'Bearer token for workflow callbacks'
                      }
                      value={isCallbackMasked ? '' : (repo.callbackToken ?? '')}
                      onChange={e => onChange({ ...repo, callbackToken: e.target.value || SRE_SECRET_PLACEHOLDER })}
                      endDecorator={
                        <Button size="sm" variant="plain" onClick={generateToken}>
                          Generate
                        </Button>
                      }
                    />
                    <FormHelperText>
                      {isCallbackMasked
                        ? 'Token configured — copy the GitHub secret SRE_CALLBACK_TOKEN to match'
                        : 'Used by the SRE workflow to authenticate callback requests'}
                    </FormHelperText>
                  </FormControl>
                </Stack>
              </CardContent>
            </Card>
          </Stack>
        </CollapsibleSection>

        {/* Error Sources */}
        <CollapsibleSection title="Error Sources">
          <Stack spacing={2}>
            {/* CloudWatch */}
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Box>
                <Typography level="title-sm">CloudWatch (Real-time)</Typography>
                <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                  Ingest errors from CloudWatch log events via logToSlack handler
                </Typography>
              </Box>
              <Switch
                checked={repo.sources?.cloudwatch?.enabled ?? false}
                onChange={e => {
                  const sources = {
                    ...repo.sources,
                    cloudwatch: { enabled: e.target.checked },
                  };
                  onChange({ ...repo, sources });
                }}
                size="sm"
              />
            </Stack>
            {(repo.sources?.cloudwatch?.enabled ?? false) && (
              <Alert size="sm" variant="soft" color="neutral" sx={{ ml: 2 }}>
                CloudWatch integration uses the existing logToSlack Lambda subscription. No additional setup needed —
                errors are classified automatically via heuristics.
              </Alert>
            )}

            <Divider />

            {/* GitHub Issues */}
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Box>
                <Typography level="title-sm">GitHub Issues (Webhook)</Typography>
                <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                  Ingest errors from labeled GitHub issues via webhook handler
                </Typography>
              </Box>
              <Switch
                checked={repo.sources?.github?.enabled ?? false}
                onChange={e => {
                  const ghSource = { ...repo.sources?.github, enabled: e.target.checked };
                  const sources = { ...repo.sources, github: ghSource };
                  onChange({ ...repo, sources });
                }}
                size="sm"
              />
            </Stack>
            {(repo.sources?.github?.enabled ?? false) && (
              <Stack spacing={1.5} sx={{ pl: 2 }}>
                {/* Webhook URL + Secret (side by side) */}
                <Stack direction="row" spacing={2}>
                  <FormControl sx={{ flex: 1 }}>
                    <FormLabel>Webhook URL</FormLabel>
                    <Input
                      size="sm"
                      readOnly
                      value={typeof window !== 'undefined' ? `${window.location.origin}/api/webhooks/github/sre` : ''}
                      endDecorator={
                        <IconButton
                          size="sm"
                          variant="plain"
                          onClick={() => {
                            const url =
                              typeof window !== 'undefined' ? `${window.location.origin}/api/webhooks/github/sre` : '';
                            navigator.clipboard.writeText(url);
                            toast.success('Webhook URL copied');
                          }}
                          data-testid={`sre-webhook-url-copy-${index}`}
                        >
                          <ContentCopyIcon fontSize="small" />
                        </IconButton>
                      }
                    />
                    <FormHelperText>
                      Configure this URL in your GitHub App or repository webhook settings
                    </FormHelperText>
                  </FormControl>
                  <FormControl sx={{ flex: 1 }}>
                    <FormLabel>Webhook Secret</FormLabel>
                    <Input
                      size="sm"
                      placeholder={
                        isSecretMasked
                          ? 'Secret configured — enter new value to change'
                          : 'HMAC secret for webhook verification'
                      }
                      value={isSecretMasked ? '' : (repo.webhookSecret ?? '')}
                      onChange={e => onChange({ ...repo, webhookSecret: e.target.value || SRE_SECRET_PLACEHOLDER })}
                    />
                    <FormHelperText>
                      {isSecretMasked
                        ? 'Secret configured — must match the secret in your GitHub webhook'
                        : 'Must match the secret in your GitHub webhook'}
                    </FormHelperText>
                  </FormControl>
                </Stack>

                {!repo.owner || !repo.repo ? (
                  <Alert size="sm" variant="soft" color="warning">
                    Set the GitHub owner and repo in the Integrations section above to filter issues.
                  </Alert>
                ) : (
                  <Alert size="sm" variant="soft" color="primary">
                    Watching issues from{' '}
                    <strong>
                      {repo.owner}/{repo.repo}
                    </strong>{' '}
                    matching the label filter below.
                  </Alert>
                )}
                <Stack direction="row" spacing={2}>
                  <GithubLabelInput
                    label="Required Labels (all must match)"
                    placeholder="bug (default)"
                    helperText="Comma-separated, e.g.: bug"
                    value={repo.sources?.github?.labelFilter?.required}
                    onCommit={labels => {
                      const ghSource = {
                        ...repo.sources?.github,
                        labelFilter: { ...repo.sources?.github?.labelFilter, required: labels },
                      };
                      onChange({ ...repo, sources: { ...repo.sources, github: ghSource } });
                    }}
                  />
                  <GithubLabelInput
                    label="Any-Of Labels (at least one)"
                    placeholder="Optional additional labels"
                    helperText="Leave empty to skip this check — all issues passing required labels will match"
                    value={repo.sources?.github?.labelFilter?.anyOf}
                    onCommit={labels => {
                      const ghSource = {
                        ...repo.sources?.github,
                        labelFilter: { ...repo.sources?.github?.labelFilter, anyOf: labels },
                      };
                      onChange({ ...repo, sources: { ...repo.sources, github: ghSource } });
                    }}
                  />
                </Stack>
              </Stack>
            )}
          </Stack>
        </CollapsibleSection>

        {/* Approval Gates */}
        <CollapsibleSection title="Approval Gates">
          <Typography level="body-sm" sx={{ mb: 2, color: 'text.secondary' }}>
            Confidence bands: auto (proceed silently), ask (Slack approval), stop (below ask threshold).
          </Typography>
          <RepoGateEditor
            label="Sentinel to Diagnostician"
            gate={repo.gates.sentinelToDiagnostician}
            onChange={g => onChange({ ...repo, gates: { ...repo.gates, sentinelToDiagnostician: g } })}
          />
          <RepoGateEditor
            label="Diagnostician to Surgeon"
            gate={repo.gates.diagnosticianToSurgeon}
            onChange={g => onChange({ ...repo, gates: { ...repo.gates, diagnosticianToSurgeon: g } })}
          />
        </CollapsibleSection>

        {/* File Scope */}
        <CollapsibleSection title="File Scope">
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={2}>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Allowed File Patterns</FormLabel>
                <Textarea
                  size="sm"
                  minRows={2}
                  placeholder="One glob per line (base patterns always merged)"
                  value={(repo.allowedFilePatterns ?? []).join('\n')}
                  onChange={e => {
                    const patterns = e.target.value
                      .split('\n')
                      .map(s => s.trim())
                      .filter(Boolean);
                    setRepoField(repo, 'allowedFilePatterns', patterns.length ? patterns : undefined, onChange);
                  }}
                />
                <FormHelperText>One glob pattern per line. Files the Surgeon can modify.</FormHelperText>
              </FormControl>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Blocked File Patterns</FormLabel>
                <Textarea
                  size="sm"
                  minRows={2}
                  placeholder="One glob per line (uses default if empty)"
                  value={(repo.blockedFilePatterns ?? []).join('\n')}
                  onChange={e => {
                    const patterns = e.target.value
                      .split('\n')
                      .map(s => s.trim())
                      .filter(Boolean);
                    setRepoField(repo, 'blockedFilePatterns', patterns.length ? patterns : undefined, onChange);
                  }}
                />
                <FormHelperText>One glob pattern per line. Files never auto-fixed.</FormHelperText>
              </FormControl>
            </Stack>
            <Stack direction="row" spacing={2}>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Default Branch</FormLabel>
                <Input
                  size="sm"
                  placeholder="main (auto-detect if empty)"
                  value={repo.defaultBranch ?? ''}
                  onChange={e => setRepoField(repo, 'defaultBranch', e.target.value || undefined, onChange)}
                />
              </FormControl>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Build Command</FormLabel>
                <Input
                  size="sm"
                  placeholder="pnpm core:build"
                  value={repo.buildCommand ?? ''}
                  onChange={e => setRepoField(repo, 'buildCommand', e.target.value || undefined, onChange)}
                />
                <FormHelperText>Override the build step in the SRE workflow</FormHelperText>
              </FormControl>
            </Stack>
          </Stack>
        </CollapsibleSection>

        {/* Safety & Limits */}
        <CollapsibleSection title="Safety & Limits">
          <Stack spacing={2}>
            <Typography level="title-sm">Circuit Breaker</Typography>
            <Stack direction="row" spacing={2}>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Failure Threshold</FormLabel>
                <NumericInput
                  size="sm"
                  value={repo.circuitBreaker.failureThreshold}
                  min={1}
                  onChange={n =>
                    onChange({
                      ...repo,
                      circuitBreaker: { ...repo.circuitBreaker, failureThreshold: n },
                    })
                  }
                />
                <FormHelperText>Consecutive failures to trip breaker</FormHelperText>
              </FormControl>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Cooldown (min)</FormLabel>
                <NumericInput
                  size="sm"
                  value={repo.circuitBreaker.cooldownMinutes}
                  min={1}
                  onChange={n =>
                    onChange({
                      ...repo,
                      circuitBreaker: { ...repo.circuitBreaker, cooldownMinutes: n },
                    })
                  }
                />
              </FormControl>
            </Stack>
            <Divider />
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Typography level="title-sm">Recurrence Guard</Typography>
              <Switch
                checked={repo.recurrence.enabled}
                onChange={e => onChange({ ...repo, recurrence: { ...repo.recurrence, enabled: e.target.checked } })}
                size="sm"
              />
            </Stack>
            {repo.recurrence.enabled && (
              <Stack direction="row" spacing={2}>
                <FormControl sx={{ flex: 1 }}>
                  <FormLabel>Window (days)</FormLabel>
                  <NumericInput
                    size="sm"
                    value={repo.recurrence.windowDays}
                    min={1}
                    max={30}
                    onChange={n =>
                      onChange({
                        ...repo,
                        recurrence: { ...repo.recurrence, windowDays: n },
                      })
                    }
                  />
                  <FormHelperText>Look-back window for prior merged fixes (max 30, TTL ceiling)</FormHelperText>
                </FormControl>
                <FormControl sx={{ flex: 1 }}>
                  <FormLabel>Threshold</FormLabel>
                  <NumericInput
                    size="sm"
                    value={repo.recurrence.threshold}
                    min={1}
                    max={10}
                    onChange={n =>
                      onChange({
                        ...repo,
                        recurrence: { ...repo.recurrence, threshold: n },
                      })
                    }
                  />
                  <FormHelperText>Merged fixes before escalating (skip LLM)</FormHelperText>
                </FormControl>
              </Stack>
            )}
            <Divider />
            <Typography level="title-sm">Token Budget (per analysis)</Typography>
            <Stack direction="row" spacing={2}>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Max Input Tokens</FormLabel>
                <NumericInput
                  size="sm"
                  value={repo.tokenBudget.maxInputTokens}
                  min={1}
                  onChange={n =>
                    onChange({
                      ...repo,
                      tokenBudget: { ...repo.tokenBudget, maxInputTokens: n },
                    })
                  }
                />
              </FormControl>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Max Output Tokens</FormLabel>
                <NumericInput
                  size="sm"
                  value={repo.tokenBudget.maxOutputTokens}
                  min={1}
                  onChange={n =>
                    onChange({
                      ...repo,
                      tokenBudget: { ...repo.tokenBudget, maxOutputTokens: n },
                    })
                  }
                />
              </FormControl>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Max GitHub API Calls</FormLabel>
                <NumericInput
                  size="sm"
                  value={repo.tokenBudget.maxGithubApiCalls}
                  min={1}
                  onChange={n =>
                    onChange({
                      ...repo,
                      tokenBudget: { ...repo.tokenBudget, maxGithubApiCalls: n },
                    })
                  }
                />
              </FormControl>
            </Stack>
            <Divider />
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Typography level="title-sm">Pattern Library</Typography>
              <Switch
                checked={repo.patternLibrary.enabled}
                onChange={e =>
                  onChange({
                    ...repo,
                    patternLibrary: { ...repo.patternLibrary, enabled: e.target.checked },
                  })
                }
                size="sm"
              />
            </Stack>
            {repo.patternLibrary.enabled && (
              <FormControl>
                <FormLabel>Min Confidence for Pattern Reuse</FormLabel>
                <NumericInput
                  size="sm"
                  value={repo.patternLibrary.minConfidence}
                  min={0}
                  max={100}
                  onChange={n =>
                    onChange({
                      ...repo,
                      patternLibrary: {
                        ...repo.patternLibrary,
                        minConfidence: n,
                      },
                    })
                  }
                />
              </FormControl>
            )}
          </Stack>
        </CollapsibleSection>
      </CardContent>
    </Card>
  );
}

// Main Config Tab

function SreConfigPanel() {
  const rawConfig = useGetSettingsValue('sreAgentConfig');
  const updateSettings = useUpdateSettings();
  const [config, setConfig] = useState<SreAgentConfig | null>(null);
  const [savedConfig, setSavedConfig] = useState<SreAgentConfig | null>(null);
  // Ref holds the latest config so handleSave avoids a stale closure when React 18
  // batches GithubLabelInput's onBlur setConfig before the Save button's onClick runs.
  // useLayoutEffect updates the ref synchronously after DOM commit, before any later
  // click handler fires.
  const latestConfigRef = useRef<SreAgentConfig | null>(null);
  useLayoutEffect(() => {
    latestConfigRef.current = config;
  }, [config]);

  const { data: models } = useModelInfo();
  const { data: workspacesData } = useQuery({
    queryKey: ['slackWorkspaces'],
    queryFn: async () => {
      const response = await api.get('/api/admin/slack-workspaces');
      return response.data as { workspaces: SlackWorkspace[] };
    },
  });

  const textModels = models?.filter(m => m.type === 'text') || [];
  const modelsByProvider = textModels.reduce(
    (acc, model) => {
      const provider = model.backend || 'unknown';
      if (!acc[provider]) acc[provider] = [];
      acc[provider].push(model);
      return acc;
    },
    {} as Record<string, ModelInfo[]>
  );
  const slackWorkspaces = workspacesData?.workspaces ?? [];

  useEffect(() => {
    if (rawConfig) {
      try {
        const parsed = SreAgentConfigSchema.parse(rawConfig);
        setConfig(parsed);
        setSavedConfig(parsed);
      } catch {
        const empty = SreAgentConfigSchema.parse({});
        setConfig(empty);
        setSavedConfig(empty);
      }
    }
  }, [rawConfig]);

  const isDirty = config && savedConfig ? JSON.stringify(config) !== JSON.stringify(savedConfig) : false;

  const handleSave = useCallback(async () => {
    // Read from the ref, not the closure, to guard against React 18 batching
    // GithubLabelInput's onBlur setConfig after the Save click fires.
    const currentConfig = latestConfigRef.current;
    if (!currentConfig) return;
    try {
      await updateSettings.mutateAsync({ key: 'sreAgentConfig', value: currentConfig });
      setConfig(currentConfig);
      setSavedConfig(currentConfig);
      toast.success('SRE Agent configuration saved');
    } catch (err) {
      const msg = isAxiosError<{ error?: string; message?: string }>(err)
        ? err.response?.data?.error || err.response?.data?.message
        : undefined;
      toast.error(`Failed to save: ${msg || (err instanceof Error ? err.message : 'Unknown error')}`);
    }
  }, [updateSettings]);

  const handleReset = useCallback(() => {
    if (savedConfig) {
      setConfig(savedConfig);
    }
  }, [savedConfig]);

  if (!config) return <Typography>Loading configuration...</Typography>;

  return (
    <Box>
      {/* Multi-Repo Configuration */}
      <ConfigSection title="Repositories">
        <Typography level="body-sm" sx={{ mb: 2, color: 'text.secondary' }}>
          Each repository is fully self-contained with its own settings. Add a repository to enable the SRE pipeline for
          it.
        </Typography>
        {config.repos.map((repo, idx) => (
          <RepoConfigCard
            key={`repo-${idx}`}
            repo={repo}
            index={idx}
            onChange={updated => {
              const repos = [...config.repos];
              repos[idx] = updated;
              setConfig({ ...config, repos });
            }}
            onRemove={() => {
              const repos = config.repos.filter((_, i) => i !== idx);
              setConfig({ ...config, repos });
            }}
            models={textModels}
            modelsByProvider={modelsByProvider}
            workspaces={slackWorkspaces}
          />
        ))}
        <Button
          variant="outlined"
          color="neutral"
          size="sm"
          startDecorator={<AddIcon />}
          onClick={() => {
            // owner/repo require min(1), so parse with placeholder values the
            // admin replaces before saving.
            const newRepo = SreRepoConfigSchema.parse({
              owner: 'new-owner',
              repo: 'new-repo',
            });
            // Clear to empty for the UI; Zod defaults fill all other fields
            newRepo.owner = '';
            newRepo.repo = '';
            setConfig({ ...config, repos: [...config.repos, newRepo] });
          }}
          data-testid="sre-add-repo-btn"
        >
          Add Repository
        </Button>
        {config.repos.length === 0 && (
          <Alert size="sm" variant="soft" color="warning" sx={{ mt: 1 }}>
            No repositories configured. Add at least one repository for the SRE pipeline to operate.
          </Alert>
        )}
      </ConfigSection>

      {/* Save Bar */}
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', justifyContent: 'flex-end' }}>
        {isDirty && (
          <Chip color="warning" variant="soft" size="sm" data-testid="sre-unsaved-changes-chip">
            Unsaved changes
          </Chip>
        )}
        <Button
          variant="outlined"
          color="neutral"
          size="sm"
          disabled={!isDirty}
          onClick={handleReset}
          data-testid="sre-config-reset-btn"
        >
          Reset
        </Button>
        <Button
          variant="solid"
          color="primary"
          size="sm"
          disabled={!isDirty}
          loading={updateSettings.isPending}
          onClick={handleSave}
          startDecorator={<SaveIcon />}
          data-testid="sre-config-save-btn"
        >
          Save
        </Button>
      </Box>
    </Box>
  );
}

// Pipeline Status Panel

type TrackingDocSummary = Partial<Pick<ISreErrorTracking, 'id'>> &
  Pick<
    ISreErrorTracking,
    | 'errorFingerprint'
    | 'repoSlug'
    | 'source'
    | 'status'
    | 'errorMessage'
    | 'classification'
    | 'fixPrNumber'
    | 'githubIssueNumber'
    | 'githubIssueState'
    | 'createdAt'
    | 'updatedAt'
  > & {
    _id?: string;
    diagnosisResult?: { confidence: number; rootCause: string };
  };

/** Resolve document ID defensively; DocumentDB lean() virtuals may not populate `id`. */
function getDocId(doc: TrackingDocSummary): string | undefined {
  return doc.id ?? (typeof doc._id === 'object' ? String(doc._id) : doc._id);
}

export { type TrackingDocSummary, getDocId };

/**
 * A doc is hidden by the "hide closed GitHub issues" filter only when its
 * denormalized githubIssueState is 'closed'. CloudWatch-sourced docs (no linked
 * issue) and GitHub docs whose state has not been observed yet (githubIssueState
 * absent, or 'open') always stay visible - so the filter never hides in-flight
 * work on a false or missing state.
 */
export function isClosedGithubIssueDoc(doc: Pick<TrackingDocSummary, 'githubIssueState'>): boolean {
  return doc.githubIssueState === 'closed';
}

/** sessionStorage key persisting the Pipeline Status "hide closed GH issues" toggle across the session. */
const HIDE_CLOSED_ISSUES_STORAGE_KEY = 'sre-pipeline-hide-closed-issues';

/**
 * Session-persisted boolean toggle, defaulting to `true` (hide closed-issue
 * tracking on first open, per the issue's default view). Persistence uses
 * sessionStorage so it survives tab navigation but resets in a new session.
 */
function useHideClosedIssues(): [boolean, (next: boolean) => void] {
  const [hide, setHide] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const stored = window.sessionStorage.getItem(HIDE_CLOSED_ISSUES_STORAGE_KEY);
    return stored === null ? true : stored === 'true';
  });

  const update = useCallback((next: boolean) => {
    setHide(next);
    try {
      window.sessionStorage.setItem(HIDE_CLOSED_ISSUES_STORAGE_KEY, String(next));
    } catch {
      // sessionStorage can throw (private mode / quota) - persistence is best-effort.
    }
  }, []);

  return [hide, update];
}

// Keep in sync with RETRYABLE_STATUSES in packages/database/src/models/SreErrorTrackingModel.ts
// (cannot import from @bike4mind/database in client components - pulls in node:fs via documentdb-cert-manager)
const RETRYABLE_STATUSES = new Set([
  'failed',
  'wont_fix',
  'dispatch_failed',
  'dry_run',
  'scope_blocked',
  'approval_expired',
  'recurrence_detected',
  'low_confidence',
  'rate_limited',
] as ISreErrorTracking['status'][]);
// Keep in sync with DISMISSABLE_STATUSES in packages/database/src/models/SreErrorTrackingModel.ts
// dry_run excluded - dismissing dry-runs makes no sense (they're not real failures)
const DISMISSABLE_STATUSES = new Set([
  'failed',
  'dispatch_failed',
  'wont_fix',
  'already_fixed',
  'scope_blocked',
  'approval_expired',
  'recurrence_detected',
  'low_confidence',
  'rate_limited',
] as ISreErrorTracking['status'][]);

export function PipelineTrackingCard({ doc }: { doc: TrackingDocSummary }) {
  const [expanded, setExpanded] = useState(false);
  const docId = getDocId(doc);
  const queryClient = useQueryClient();

  const {
    data: fullDoc,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['sre-tracking-detail', docId],
    queryFn: async () => {
      const { data } = await api.get<ISreErrorTracking>(`/api/sre/tracking/${docId}`);
      return data;
    },
    enabled: !!docId && expanded,
    staleTime: 30_000,
  });

  const isGithubIssue = doc.source === 'GITHUB_ISSUE' && !!doc.githubIssueNumber;

  const { data: issueState } = useQuery({
    queryKey: ['sre-issue-state', docId],
    queryFn: async () => {
      const { data } = await api.get<{ state: string; closedAt?: string; error?: string }>(
        `/api/sre/tracking/${docId}/issue-state`
      );
      return data;
    },
    enabled: !!docId && isGithubIssue,
    staleTime: 120_000,
  });

  const isIssueClosed = issueState?.state === 'closed';
  const isRetryable = RETRYABLE_STATUSES.has(doc.status);
  const isDismissable = DISMISSABLE_STATUSES.has(doc.status);
  // Rerun (dismissed docs only) creates a fresh tracking doc, preserving the
  // dismissed one as audit history. Retry instead deletes the terminal doc and
  // re-dispatches.
  const isRerunable = doc.status === 'dismissed';

  const [dismissOpen, setDismissOpen] = useState(false);
  const [dismissReason, setDismissReason] = useState('');

  const retryMutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{ success: boolean; fingerprint: string }>(`/api/sre/tracking/${docId}/retry`);
      return data;
    },
    onSuccess: () => {
      toast.success('Retry initiated — analysis will restart shortly');
      queryClient.invalidateQueries({ queryKey: ['sre-tracking-recent'] });
      queryClient.invalidateQueries({ queryKey: ['sre-tracking-detail', docId] });
    },
    onError: err => {
      const msg = isAxiosError<{ message?: string }>(err) ? err.response?.data?.message : undefined;
      toast.error(msg || 'Failed to retry');
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async (reason: string) => {
      const { data } = await api.post<{ success: boolean; fingerprint: string }>(`/api/sre/tracking/${docId}/dismiss`, {
        reason,
      });
      return data;
    },
    onSuccess: () => {
      toast.success('Tracking doc dismissed');
      setDismissOpen(false);
      setDismissReason('');
      queryClient.invalidateQueries({ queryKey: ['sre-tracking-recent'] });
      queryClient.invalidateQueries({ queryKey: ['sre-tracking-detail', docId] });
    },
    onError: err => {
      const msg = isAxiosError<{ error?: string; message?: string }>(err)
        ? err.response?.data?.error || err.response?.data?.message
        : undefined;
      toast.error(msg || 'Failed to dismiss');
    },
  });

  const rerunMutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{
        success: boolean;
        dispatched: boolean;
        userMessage: string;
        code: string | null;
        fingerprint: string;
      }>(`/api/sre/tracking/${docId}/rerun`);
      return data;
    },
    onSuccess: data => {
      if (data.dispatched) {
        toast.success(data.userMessage);
      } else {
        toast.warning(data.userMessage);
      }
      queryClient.invalidateQueries({ queryKey: ['sre-tracking-recent'] });
      queryClient.invalidateQueries({ queryKey: ['sre-tracking-detail', docId] });
    },
    onError: err => {
      const msg = isAxiosError<{ error?: string; message?: string }>(err)
        ? err.response?.data?.error || err.response?.data?.message
        : undefined;
      toast.error(msg || 'Failed to rerun');
    },
  });

  return (
    <Card variant="outlined" data-testid={`sre-tracking-card-${docId}`}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', p: 1 }}>
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
          Status:
        </Typography>
        <Chip size="sm" variant="soft" color={STATUS_COLORS[doc.status] || 'neutral'}>
          {doc.status}
        </Chip>
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
          Source:
        </Typography>
        <Chip size="sm" variant="soft">
          {{ CLOUDWATCH: 'CW', GITHUB_ISSUE: 'GH' }[doc.source] ?? doc.source}
        </Chip>
        {doc.repoSlug && (
          <>
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
              Repo:
            </Typography>
            <Chip size="sm" variant="soft" color="primary">
              {doc.repoSlug}
            </Chip>
          </>
        )}
        <Typography level="body-xs" sx={{ flex: 1, minWidth: 0 }} noWrap>
          {doc.errorMessage?.slice(0, 120) || doc.errorFingerprint.slice(0, 12)}
        </Typography>
        {doc.diagnosisResult?.confidence != null && (
          <Chip size="sm" variant="soft" color={doc.diagnosisResult.confidence >= 70 ? 'success' : 'warning'}>
            Confidence: {doc.diagnosisResult.confidence}%
          </Chip>
        )}
        {doc.fixPrNumber && (
          <Chip size="sm" variant="soft" color="primary">
            PR #{doc.fixPrNumber}
          </Chip>
        )}
        {isIssueClosed && (
          <Chip size="sm" variant="soft" color="success" data-testid={`sre-tracking-issue-closed-${docId}`}>
            Issue Closed
          </Chip>
        )}
        {isRetryable && (
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            disabled={isIssueClosed || retryMutation.isPending}
            onClick={e => {
              e.stopPropagation();
              retryMutation.mutate();
            }}
            data-testid={`sre-tracking-retry-${docId}`}
            aria-label="Retry analysis"
          >
            {retryMutation.isPending ? <CircularProgress size="sm" /> : <ReplayIcon fontSize="small" />}
          </IconButton>
        )}
        {isDismissable && (
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            disabled={dismissMutation.isPending}
            onClick={e => {
              e.stopPropagation();
              setDismissOpen(true);
            }}
            data-testid={`sre-tracking-dismiss-${docId}`}
            aria-label="Dismiss tracking doc"
          >
            <CancelIcon fontSize="small" />
          </IconButton>
        )}
        {isRerunable && (
          <IconButton
            size="sm"
            variant="plain"
            color="warning"
            disabled={rerunMutation.isPending}
            onClick={e => {
              e.stopPropagation();
              rerunMutation.mutate();
            }}
            data-testid={`sre-tracking-rerun-${docId}`}
            aria-label="Rerun from scratch — dispatches a fresh event"
          >
            {rerunMutation.isPending ? <CircularProgress size="sm" /> : <RestartAltIcon fontSize="small" />}
          </IconButton>
        )}
        <Typography level="body-xs" sx={{ color: 'text.tertiary', whiteSpace: 'nowrap' }}>
          Updated: {formatDate(doc.updatedAt)}
        </Typography>
      </Stack>
      <JoyAccordion expanded={expanded} onChange={(_e, val) => setExpanded(val)}>
        <JoyAccordionSummary
          indicator={<ExpandMoreIcon />}
          data-testid={`sre-tracking-expand-${docId}`}
          aria-label={`Details for error ${doc.errorFingerprint.slice(0, 12)}`}
        >
          Details
        </JoyAccordionSummary>
        <JoyAccordionDetails>
          {isError ? (
            <Alert variant="soft" color="danger">
              Failed to load details{error instanceof Error ? `: ${error.message}` : ''}
            </Alert>
          ) : isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
              <CircularProgress size="sm" />
            </Box>
          ) : fullDoc ? (
            <TrackingDetailContent doc={fullDoc} />
          ) : null}
        </JoyAccordionDetails>
      </JoyAccordion>

      <Modal
        open={dismissOpen}
        onClose={() => {
          if (!dismissMutation.isPending) {
            setDismissOpen(false);
            setDismissReason('');
          }
        }}
      >
        <ModalDialog>
          <DialogTitle>Dismiss tracking doc</DialogTitle>
          <DialogContent>
            <Typography level="body-sm" sx={{ mb: 2 }}>
              Dismiss marks this doc as reviewed and removes it from the circuit breaker&apos;s failure count. It will
              not be retried. Use this for failures caused by known bugs, testing, or issues already fixed outside the
              SRE pipeline.
            </Typography>
            <FormControl>
              <FormLabel>Reason (required, 3-500 chars)</FormLabel>
              <Textarea
                size="sm"
                minRows={2}
                value={dismissReason}
                onChange={e => setDismissReason(e.target.value)}
                placeholder="e.g. Superseded by PR #7854"
                slotProps={{ textarea: { maxLength: 500 } }}
                data-testid={`sre-dismiss-reason-${docId}`}
              />
              <FormHelperText>{dismissReason.length}/500 characters</FormHelperText>
            </FormControl>
          </DialogContent>
          <DialogActions>
            <Button
              variant="plain"
              color="neutral"
              onClick={() => {
                setDismissOpen(false);
                setDismissReason('');
              }}
              disabled={dismissMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              color="danger"
              onClick={() => dismissMutation.mutate(dismissReason.trim())}
              disabled={dismissReason.trim().length < 3 || dismissMutation.isPending}
              loading={dismissMutation.isPending}
              data-testid={`sre-dismiss-confirm-${docId}`}
            >
              Dismiss
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </Card>
  );
}

// Manual Trigger Section

interface TriggerResultItem {
  issueNumber: number;
  dispatched: boolean;
  reason?: string;
  labels?: string[];
}

const TRIGGER_RESULT_COLORS: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  dispatched: 'success',
  'label-mismatch': 'warning',
  'not-found': 'neutral',
  'already-dispatched': 'neutral',
  'pipeline-disabled': 'danger',
  'github-source-disabled': 'danger',
  'repo-mismatch': 'warning',
  'rate-limit-exceeded': 'danger',
  'internal-error': 'danger',
};

function parseIssueNumbers(raw: string): number[] {
  const nums = raw
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n > 0);
  return [...new Set(nums)];
}

function ManualTriggerSection({ repoSlugs }: { repoSlugs: string[] }) {
  const [input, setInput] = useState('');
  const [selectedRepo, setSelectedRepo] = useSelectedRepo(repoSlugs);
  const queryClient = useQueryClient();
  const parsedNumbers = useMemo(() => parseIssueNumbers(input), [input]);

  const mutation = useMutation({
    mutationFn: async (issueNumbers: number[]) => {
      const { data } = await api.post<{ results: TriggerResultItem[] }>('/api/sre/trigger', {
        issueNumbers,
        ...(selectedRepo ? { repoSlug: selectedRepo } : {}),
      });
      return data.results;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sre-tracking-recent'] });
    },
    onError: err => {
      const msg = isAxiosError<{ message?: string }>(err) ? err.response?.data?.message : undefined;
      toast.error(msg || 'Failed to trigger issues');
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (parsedNumbers.length > 0) {
      mutation.mutate(parsedNumbers);
    }
  };

  return (
    <Card variant="outlined" data-testid="sre-manual-trigger-section">
      <CardContent>
        <Typography level="title-md" sx={{ mb: 1 }}>
          Manual Trigger
        </Typography>
        <form onSubmit={handleSubmit}>
          <Stack spacing={1.5}>
            {repoSlugs.length > 0 && (
              <FormControl>
                <FormLabel>Target Repository</FormLabel>
                <Select
                  size="sm"
                  value={selectedRepo}
                  onChange={(_, value) => setSelectedRepo(value ?? '')}
                  data-testid="sre-manual-trigger-repo-select"
                >
                  {repoSlugs.map(slug => (
                    <Option key={slug} value={slug}>
                      {slug}
                    </Option>
                  ))}
                </Select>
              </FormControl>
            )}
            <FormControl>
              <FormLabel>Issue Numbers</FormLabel>
              <Stack direction="row" spacing={1}>
                <Input
                  placeholder="7346, 7339, 7327"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  data-testid="sre-manual-trigger-input"
                  sx={{ flex: 1 }}
                />
                <Button
                  type="submit"
                  loading={mutation.isPending}
                  disabled={parsedNumbers.length === 0}
                  data-testid="sre-manual-trigger-btn"
                >
                  Trigger
                </Button>
              </Stack>
              <FormHelperText>
                {parsedNumbers.length > 0
                  ? `${parsedNumbers.length} issue${parsedNumbers.length > 1 ? 's' : ''} ready`
                  : 'Comma-separated GitHub issue numbers (max 20)'}
              </FormHelperText>
            </FormControl>
            {mutation.data && (
              <Stack spacing={0.5} aria-live="polite" data-testid="sre-manual-trigger-results">
                {mutation.data.map(r => (
                  <Chip
                    key={r.issueNumber}
                    size="sm"
                    variant="soft"
                    color={TRIGGER_RESULT_COLORS[r.reason ?? 'dispatched'] ?? 'neutral'}
                    data-testid={`sre-trigger-result-${r.issueNumber}`}
                  >
                    #{r.issueNumber}: {r.reason ?? 'dispatched'}
                  </Chip>
                ))}
              </Stack>
            )}
          </Stack>
        </form>
      </CardContent>
    </Card>
  );
}

// Shared repo-selection hook

function useSelectedRepo(repoSlugs: string[]) {
  const [selectedRepo, setSelectedRepo] = useState<string>(repoSlugs[0] ?? '');
  useEffect(() => {
    // !selectedRepo (not selectedRepo &&) so auto-select fires when repos load after mount.
    // repoSlugs starts as [] during React Query hydration; the falsy check ensures
    // auto-selection runs when the list later populates.
    if (!selectedRepo || !repoSlugs.includes(selectedRepo)) {
      setSelectedRepo(repoSlugs[0] ?? '');
    }
  }, [repoSlugs, selectedRepo]);
  return [selectedRepo, setSelectedRepo] as const;
}

// Label input hook + wrapper component

function useStringListInput(value: string[] | undefined, onCommit: (next: string[]) => void) {
  const canonical = useMemo(() => (value ?? []).join(', '), [value]);
  const [raw, setRaw] = useState<string>(canonical);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setRaw(canonical);
  }, [canonical]);

  return {
    value: raw,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setRaw(e.target.value),
    onFocus: () => {
      focusedRef.current = true;
    },
    onBlur: () => {
      focusedRef.current = false;
      const next = raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      onCommit(next);
      setRaw(next.join(', '));
    },
  };
}

function GithubLabelInput({
  value,
  onCommit,
  placeholder,
  label,
  helperText,
}: {
  value: string[] | undefined;
  onCommit: (next: string[]) => void;
  placeholder?: string;
  label: string;
  helperText: string;
}) {
  const inputProps = useStringListInput(value, onCommit);
  return (
    <FormControl sx={{ flex: 1 }}>
      <FormLabel>{label}</FormLabel>
      <Input size="sm" placeholder={placeholder} {...inputProps} />
      <FormHelperText>{helperText}</FormHelperText>
    </FormControl>
  );
}

// GitHub Issue Scan

interface ScanResultItem {
  issueNumber: number;
  title: string;
  htmlUrl: string;
  outcome: string;
  reason?: string;
  trackingStatus?: string;
}

interface ScanResponse {
  repoSlug: string;
  scanned: number;
  dispatched: number;
  capReached: boolean;
  skipped: {
    inFlight: number;
    resolved: number;
    dismissed: number;
    recentlyDispatched: number;
    rateLimited: number;
    dispatchError: number;
    capReached: number;
  };
  results: ScanResultItem[];
  durationMs: number;
}

const SCAN_OUTCOME_COLORS: Record<string, 'success' | 'neutral' | 'warning' | 'danger'> = {
  dispatched: 'success',
  skipped_in_flight: 'neutral',
  skipped_resolved: 'success',
  skipped_dismissed: 'neutral',
  skipped_recently_dispatched: 'neutral',
  skipped_rate_limited: 'warning',
  skipped_dispatch_error: 'danger',
  skipped_cap_reached: 'warning',
};

function ScanResults({ data }: { data: ScanResponse }) {
  const totalSkipped = Object.values(data.skipped).reduce((a, b) => a + b, 0);
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={0.5} flexWrap="wrap">
        <Chip size="sm" variant="soft" color="neutral">
          Scanned {data.scanned}
        </Chip>
        <Chip size="sm" variant="soft" color="success">
          Dispatched {data.dispatched}
        </Chip>
        <Chip size="sm" variant="soft" color="neutral">
          Skipped {totalSkipped}
        </Chip>
        {data.capReached && (
          <Chip size="sm" variant="soft" color="warning">
            Cap reached (10)
          </Chip>
        )}
      </Stack>
      <Stack direction="row" spacing={0.5} flexWrap="wrap">
        {data.skipped.inFlight > 0 && (
          <Chip size="sm" variant="soft" color="neutral">
            In-flight {data.skipped.inFlight}
          </Chip>
        )}
        {data.skipped.resolved > 0 && (
          <Chip size="sm" variant="soft" color="success">
            Already fixed {data.skipped.resolved}
          </Chip>
        )}
        {data.skipped.dismissed > 0 && (
          <Chip size="sm" variant="soft" color="neutral">
            Dismissed {data.skipped.dismissed}
          </Chip>
        )}
        {data.skipped.recentlyDispatched > 0 && (
          <Chip size="sm" variant="soft" color="neutral">
            Recent dispatch {data.skipped.recentlyDispatched}
          </Chip>
        )}
        {data.skipped.rateLimited > 0 && (
          <Chip size="sm" variant="soft" color="warning">
            Rate limited {data.skipped.rateLimited}
          </Chip>
        )}
        {data.skipped.dispatchError > 0 && (
          <Chip size="sm" variant="soft" color="danger">
            Errors {data.skipped.dispatchError}
          </Chip>
        )}
      </Stack>
      {data.results.length > 0 && (
        <Stack sx={{ maxHeight: 400, overflowY: 'auto' }} spacing={0.5}>
          {data.results.map(item => (
            <Stack key={item.issueNumber} direction="row" spacing={1} alignItems="center">
              <Link href={item.htmlUrl} target="_blank" rel="noopener noreferrer" level="body-sm">
                #{item.issueNumber}
              </Link>
              <Typography
                level="body-sm"
                sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {item.title}
              </Typography>
              <Chip size="sm" variant="soft" color={SCAN_OUTCOME_COLORS[item.outcome] ?? 'neutral'}>
                {item.outcome.replace('skipped_', '').replace(/_/g, ' ')}
              </Chip>
            </Stack>
          ))}
        </Stack>
      )}
      {data.scanned === 0 && (
        <Alert variant="soft" color="neutral" size="sm">
          No matching open issues found for the configured label filter.
        </Alert>
      )}
    </Stack>
  );
}

function ScanSection({ repoSlugs }: { repoSlugs: string[] }) {
  const [selectedRepo, setSelectedRepo] = useSelectedRepo(repoSlugs);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (repoSlug: string) => {
      const { data } = await api.post<ScanResponse>('/api/sre/scan', { repoSlug });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sre-tracking-recent'] });
    },
    onError: err => {
      const msg = isAxiosError<{ message?: string }>(err) ? err.response?.data?.message : undefined;
      toast.error(msg || 'Failed to scan repository');
    },
  });

  // Reset stale results when repo selection changes.
  // mutation is excluded from deps: its identity changes on every state transition,
  // which would cause an infinite reset loop if included.
  useEffect(() => {
    mutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRepo]);

  if (repoSlugs.length === 0) {
    return (
      <Alert variant="soft" color="neutral" size="sm">
        No repositories configured — add one in the Integrations section to enable scanning.
      </Alert>
    );
  }

  return (
    <Card variant="outlined" data-testid="sre-scan-section">
      <CardContent>
        <Typography level="title-md" sx={{ mb: 1 }}>
          Scan GitHub Issues
        </Typography>
        <Typography level="body-sm" sx={{ mb: 1.5, color: 'text.tertiary' }}>
          Find open issues matching the configured label filter that haven&apos;t been run through the pipeline, and
          dispatch them now. Use this to catch issues created before the SRE system existed or missed due to webhook
          failures. Scans up to 100 issues, dispatches up to 10 per run.
        </Typography>
        <Stack spacing={1.5}>
          <FormControl>
            <FormLabel>Repository</FormLabel>
            <Select
              size="sm"
              value={selectedRepo}
              onChange={(_, value) => setSelectedRepo(value ?? '')}
              disabled={mutation.isPending}
              data-testid="sre-scan-repo-select"
            >
              {repoSlugs.map(slug => (
                <Option key={slug} value={slug}>
                  {slug}
                </Option>
              ))}
            </Select>
          </FormControl>
          <Button
            size="sm"
            loading={mutation.isPending}
            disabled={!selectedRepo}
            onClick={() => mutation.mutate(selectedRepo)}
            data-testid="sre-scan-btn"
          >
            Scan GitHub Issues
          </Button>
          {mutation.isPending && (
            <Typography level="body-xs" color="neutral">
              Scanning… this may take a moment.
            </Typography>
          )}
          {mutation.data && <ScanResults data={mutation.data} />}
        </Stack>
      </CardContent>
    </Card>
  );
}

export function PipelineStatusPanel({ repoSlugs }: { repoSlugs: string[] }) {
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [hideClosedIssues, setHideClosedIssues] = useHideClosedIssues();

  const { data: trackingDocs, isLoading } = useQuery({
    queryKey: ['sre-tracking-recent', selectedRepo],
    queryFn: async () => {
      const params = selectedRepo ? `?repoSlug=${encodeURIComponent(selectedRepo)}` : '';
      const { data } = await api.get<TrackingDocSummary[]>(`/api/sre/tracking${params}`);
      return data;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const visibleDocs = useMemo(
    () => (hideClosedIssues ? (trackingDocs ?? []).filter(doc => !isClosedGithubIssueDoc(doc)) : (trackingDocs ?? [])),
    [trackingDocs, hideClosedIssues]
  );

  const hiddenByFilterCount = (trackingDocs?.length ?? 0) - visibleDocs.length;

  return (
    <Stack spacing={1.5}>
      {repoSlugs.length > 0 && (
        <FormControl>
          <FormLabel>Filter by Repository</FormLabel>
          <Select
            size="sm"
            value={selectedRepo}
            onChange={(_, value) => setSelectedRepo(value ?? '')}
            data-testid="sre-pipeline-repo-filter"
          >
            <Option value="">All Repos</Option>
            {repoSlugs.map(slug => (
              <Option key={slug} value={slug}>
                {slug}
              </Option>
            ))}
          </Select>
        </FormControl>
      )}
      <Checkbox
        size="sm"
        label="Hide tracking for closed GitHub issues"
        checked={hideClosedIssues}
        onChange={e => setHideClosedIssues(e.target.checked)}
        data-testid="sre-pipeline-hide-closed-toggle"
      />
      <ManualTriggerSection repoSlugs={repoSlugs} />
      <ScanSection repoSlugs={repoSlugs} />
      {isLoading ? (
        <Typography>Loading pipeline status...</Typography>
      ) : !trackingDocs?.length ? (
        <Alert variant="soft" color="neutral">
          No tracked errors yet. The pipeline will populate this once errors are ingested.
        </Alert>
      ) : !visibleDocs.length ? (
        <Alert variant="soft" color="neutral" data-testid="sre-pipeline-all-hidden">
          {hiddenByFilterCount === 1
            ? '1 tracked error is for a closed GitHub issue. Uncheck the filter above to see it.'
            : `${hiddenByFilterCount} tracked errors are for closed GitHub issues. Uncheck the filter above to see them.`}
        </Alert>
      ) : (
        <>
          {hideClosedIssues && hiddenByFilterCount > 0 && (
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }} data-testid="sre-pipeline-hidden-count">
              {hiddenByFilterCount === 1
                ? '1 closed-issue doc hidden'
                : `${hiddenByFilterCount} closed-issue docs hidden`}
            </Typography>
          )}
          {visibleDocs.map(doc => {
            const key = getDocId(doc) ?? doc.errorFingerprint;
            return <PipelineTrackingCard key={key} doc={doc} />;
          })}
        </>
      )}
    </Stack>
  );
}

// Pattern Library Panel

interface PatternSummary {
  id: string;
  errorFingerprint: string;
  name: string;
  isActive: boolean;
  workaroundIneffective?: boolean;
  rootCauseTrackingIssue?: number;
  matchCount: number;
  successCount: number;
  failureCount: number;
  diagnosis: { confidence: number };
  createdAt: string;
  lastMatchedAt?: string;
}

function PatternRow({ p, onPatched }: { p: PatternSummary; onPatched: () => void }) {
  const [editIssue, setEditIssue] = useState(false);
  const [issueNum, setIssueNum] = useState(String(p.rootCauseTrackingIssue ?? ''));

  const patchMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const { data } = await api.patch(`/api/sre/patterns/${p.id}`, body);
      return data;
    },
    onSuccess: () => {
      toast.success('Pattern updated');
      onPatched();
    },
    onError: err => {
      const msg = isAxiosError<{ message?: string }>(err) ? err.response?.data?.message : undefined;
      toast.error(msg || 'Failed to update pattern');
    },
  });

  const total = p.successCount + p.failureCount;
  const rate = total > 0 ? Math.round((p.successCount / total) * 100) : null;

  return (
    <tr key={p.id}>
      <td>
        <Stack spacing={0.5}>
          <Typography level="body-xs" noWrap sx={{ maxWidth: 300 }}>
            {p.name}
          </Typography>
          {p.workaroundIneffective && (
            <Chip size="sm" variant="soft" color="danger">
              Workaround Ineffective
            </Chip>
          )}
        </Stack>
      </td>
      <td>
        <Chip
          size="sm"
          variant="soft"
          color={p.isActive ? 'success' : 'neutral'}
          sx={{ cursor: 'pointer' }}
          onClick={() => {
            if (p.workaroundIneffective && !p.isActive) {
              patchMutation.mutate({ isActive: true, workaroundIneffective: false, confirmReactivate: true });
            } else {
              patchMutation.mutate({ isActive: !p.isActive });
            }
          }}
          data-testid={`sre-pattern-toggle-${p.id}`}
        >
          {p.isActive ? 'Active' : 'Inactive'}
        </Chip>
      </td>
      <td>
        <Typography level="body-xs">{p.diagnosis.confidence}%</Typography>
      </td>
      <td>
        <Typography level="body-xs">{p.matchCount}</Typography>
      </td>
      <td>
        <Typography level="body-xs">{rate != null ? `${rate}% (${total})` : '-'}</Typography>
      </td>
      <td>
        {editIssue ? (
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Input
              size="sm"
              type="number"
              placeholder="#"
              value={issueNum}
              onChange={e => setIssueNum(e.target.value)}
              sx={{ width: 80 }}
              slotProps={{ input: { min: 1 } }}
            />
            <IconButton
              size="sm"
              variant="plain"
              color="success"
              onClick={() => {
                const val = issueNum ? Number(issueNum) : null;
                patchMutation.mutate({ rootCauseTrackingIssue: val });
                setEditIssue(false);
              }}
            >
              <CheckCircleIcon fontSize="small" />
            </IconButton>
          </Stack>
        ) : (
          <Typography
            level="body-xs"
            sx={{ cursor: 'pointer', textDecoration: 'underline dotted', color: 'text.secondary' }}
            onClick={() => setEditIssue(true)}
            data-testid={`sre-pattern-issue-${p.id}`}
          >
            {p.rootCauseTrackingIssue ? `#${p.rootCauseTrackingIssue}` : 'Link issue'}
          </Typography>
        )}
      </td>
      <td>
        <Typography level="body-xs">
          {p.lastMatchedAt ? new Date(p.lastMatchedAt).toLocaleDateString() : 'Never'}
        </Typography>
      </td>
    </tr>
  );
}

function PatternLibraryPanel({ repoSlugs }: { repoSlugs: string[] }) {
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const queryClient = useQueryClient();
  const { data: patterns, isLoading } = useQuery({
    queryKey: ['sre-patterns', selectedRepo],
    queryFn: async () => {
      const params = selectedRepo ? `?repoSlug=${encodeURIComponent(selectedRepo)}` : '';
      const { data } = await api.get<PatternSummary[]>(`/api/sre/patterns${params}`);
      return data;
    },
    staleTime: 60_000,
  });

  return (
    <Stack spacing={1.5}>
      {repoSlugs.length > 0 && (
        <FormControl>
          <FormLabel>Filter by Repository</FormLabel>
          <Select
            size="sm"
            value={selectedRepo}
            onChange={(_, value) => setSelectedRepo(value ?? '')}
            data-testid="sre-patterns-repo-filter"
          >
            <Option value="">All Repos</Option>
            {repoSlugs.map(slug => (
              <Option key={slug} value={slug}>
                {slug}
              </Option>
            ))}
          </Select>
        </FormControl>
      )}
      {isLoading ? (
        <Typography>Loading patterns...</Typography>
      ) : !patterns?.length ? (
        <Alert variant="soft" color="neutral">
          No patterns yet. Patterns are created automatically when SRE fixes are successfully merged.
        </Alert>
      ) : (
        <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
          <Table size="sm" stickyHeader>
            <thead>
              <tr>
                <th>Pattern</th>
                <th style={{ width: 80 }}>Active</th>
                <th style={{ width: 80 }}>Confidence</th>
                <th style={{ width: 80 }}>Matches</th>
                <th style={{ width: 100 }}>Success Rate</th>
                <th style={{ width: 120 }}>Root Cause</th>
                <th style={{ width: 140 }}>Last Match</th>
              </tr>
            </thead>
            <tbody>
              {patterns.map(p => (
                <PatternRow
                  key={p.id}
                  p={p}
                  onPatched={() => queryClient.invalidateQueries({ queryKey: ['sre-patterns', selectedRepo] })}
                />
              ))}
            </tbody>
          </Table>
        </Sheet>
      )}
    </Stack>
  );
}

// Main Tab Component

export default function SreAgentTab() {
  const rawConfig = useGetSettingsValue('sreAgentConfig');

  const repoSlugs = useMemo(() => {
    if (!rawConfig) return [];
    try {
      const parsed = SreAgentConfigSchema.parse(rawConfig);
      return getConfiguredRepoSlugs(parsed);
    } catch {
      return [];
    }
  }, [rawConfig]);

  return (
    <Box sx={{ p: 2 }}>
      <Typography level="h4" sx={{ mb: 0.5 }}>
        SRE Agent
      </Typography>
      <Typography level="body-sm" sx={{ mb: 2, color: 'text.secondary' }}>
        Autonomous error detection, LLM diagnosis, and automated fix pipeline.
      </Typography>

      <Tabs defaultValue={0} sx={{ borderRadius: 'sm' }}>
        <TabList>
          <Tab data-testid="sre-tab-pipeline-status">Pipeline Status</Tab>
          <Tab data-testid="sre-tab-pattern-library">Pattern Library</Tab>
          <Tab data-testid="sre-tab-configuration">Configuration</Tab>
        </TabList>

        <TabPanel value={0} sx={{ p: 2 }}>
          <PipelineStatusPanel repoSlugs={repoSlugs} />
        </TabPanel>
        <TabPanel value={1} sx={{ p: 2 }}>
          <PatternLibraryPanel repoSlugs={repoSlugs} />
        </TabPanel>
        <TabPanel value={2} sx={{ p: 2 }}>
          <SreConfigPanel />
        </TabPanel>
      </Tabs>
    </Box>
  );
}
