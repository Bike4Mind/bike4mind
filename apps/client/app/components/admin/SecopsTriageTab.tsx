/**
 * SecOps Triage Configuration Tab
 *
 * Dedicated admin UI for configuring the SecOps Triage pipeline:
 *   - Master controls (enabled, dry-run)
 *   - GitHub issue settings (repo, severity threshold, priority mapping, rate limit)
 *   - Slack notification settings (channel ID)
 */

import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Option,
  Select,
  Sheet,
  Stack,
  Switch,
  Typography,
} from '@mui/joy';
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useGetSettingsValue, useUpdateSettings } from '@client/app/hooks/data/settings';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { SecopsTriageConfigSchema, type SecopsTriageConfig } from '@bike4mind/common';
import { toast } from 'sonner';
import SaveIcon from '@mui/icons-material/Save';
import ReplayIcon from '@mui/icons-material/Replay';
import SecurityIcon from '@mui/icons-material/Security';
import { api } from '@client/app/contexts/ApiContext';

interface SlackWorkspace {
  id: string;
  name: string;
  slackTeamId: string;
  isActive: boolean;
}

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

// Main Panel

function SecopsTriageConfigPanel() {
  const rawConfig = useGetSettingsValue('secopsTriageConfig');
  const updateSettings = useUpdateSettings();

  const [config, setConfig] = useState<SecopsTriageConfig | null>(null);
  const [savedConfig, setSavedConfig] = useState<SecopsTriageConfig | null>(null);

  const { data: models } = useModelInfo();
  const textModels = models?.filter(m => m.type === 'text') ?? [];

  const { data: workspacesData } = useQuery({
    queryKey: ['slackWorkspaces'],
    queryFn: async () => {
      const response = await api.get('/api/admin/slack-workspaces');
      return response.data as { workspaces: SlackWorkspace[] };
    },
  });

  useEffect(() => {
    try {
      const parsed = SecopsTriageConfigSchema.parse(rawConfig ?? {});
      setConfig(parsed);
      setSavedConfig(parsed);
    } catch {
      const defaults = SecopsTriageConfigSchema.parse({});
      setConfig(defaults);
      setSavedConfig(defaults);
    }
  }, [rawConfig]);

  const isDirty = config && savedConfig ? JSON.stringify(config) !== JSON.stringify(savedConfig) : false;

  const handleSave = useCallback(async () => {
    if (!config) return;
    if (config.llmEnrichment && !config.modelId) {
      toast.error('A model must be selected when LLM Enrichment is enabled.');
      return;
    }
    try {
      await updateSettings.mutateAsync({ key: 'secopsTriageConfig', value: config });
      setSavedConfig(config);
      toast.success('SecOps Triage configuration saved');
    } catch (err) {
      toast.error(`Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [config, updateSettings]);

  const handleReset = useCallback(() => {
    if (savedConfig) setConfig(savedConfig);
  }, [savedConfig]);

  if (!config) return null;

  return (
    <Stack spacing={2}>
      {/* Master Controls */}
      <ConfigSection title="Master Controls">
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Box>
              <Typography level="title-sm">Enabled</Typography>
              <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
                Master kill switch. When disabled, security scan findings are still ingested but no GitHub issues are
                created.
              </Typography>
            </Box>
            <Switch
              checked={config.enabled}
              onChange={e => setConfig({ ...config, enabled: e.target.checked })}
              color={config.enabled ? 'success' : 'neutral'}
              data-testid="secops-triage-enabled-switch"
            />
          </Stack>

          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Box>
              <Typography level="title-sm">
                Dry Run{' '}
                {config.dryRun && (
                  <Chip size="sm" color="warning" variant="soft">
                    Active
                  </Chip>
                )}
              </Typography>
              <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
                Logs all actions without creating real GitHub issues or posting to Slack. Enable first when testing.
              </Typography>
            </Box>
            <Switch
              checked={config.dryRun ?? false}
              onChange={e => setConfig({ ...config, dryRun: e.target.checked })}
              color={config.dryRun ? 'warning' : 'neutral'}
              data-testid="secops-triage-dry-run-switch"
            />
          </Stack>
        </Stack>
      </ConfigSection>

      {/* GitHub Settings */}
      <ConfigSection title="GitHub Settings">
        <Stack spacing={2}>
          <FormControl>
            <FormLabel>Repository</FormLabel>
            <Input
              value={config.githubRepo}
              onChange={e => setConfig({ ...config, githubRepo: e.target.value })}
              placeholder="MillionOnMars/lumina5"
              data-testid="secops-triage-github-repo-input"
            />
            <FormHelperText>GitHub repository where issues will be created (e.g. MillionOnMars/lumina5)</FormHelperText>
          </FormControl>

          <FormControl>
            <FormLabel>Severity Threshold</FormLabel>
            <Select
              value={config.severityThreshold}
              onChange={(_, val) => val && setConfig({ ...config, severityThreshold: val })}
              data-testid="secops-triage-severity-threshold-select"
            >
              <Option value="critical">Critical only</Option>
              <Option value="high">High and above (recommended)</Option>
            </Select>
            <FormHelperText>Minimum severity level that triggers issue creation.</FormHelperText>
          </FormControl>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <FormControl sx={{ flex: 1 }}>
              <FormLabel>Critical → Priority</FormLabel>
              <Select
                value={config.severityToPriority?.critical ?? 'P0'}
                onChange={(_, val) =>
                  val &&
                  setConfig({
                    ...config,
                    severityToPriority: { ...config.severityToPriority, critical: val },
                  })
                }
                data-testid="secops-triage-critical-priority-select"
              >
                <Option value="P0">P0 (Critical)</Option>
                <Option value="P1">P1 (High)</Option>
              </Select>
              <FormHelperText>GitHub issue priority label for critical findings.</FormHelperText>
            </FormControl>

            <FormControl sx={{ flex: 1 }}>
              <FormLabel>High → Priority</FormLabel>
              <Select
                value={config.severityToPriority?.high ?? 'P1'}
                onChange={(_, val) =>
                  val &&
                  setConfig({
                    ...config,
                    severityToPriority: { ...config.severityToPriority, high: val },
                  })
                }
                data-testid="secops-triage-high-priority-select"
              >
                <Option value="P0">P0 (Critical)</Option>
                <Option value="P1">P1 (High)</Option>
              </Select>
              <FormHelperText>GitHub issue priority label for high findings.</FormHelperText>
            </FormControl>
          </Stack>

          <FormControl>
            <FormLabel>Max Issues Per Scan</FormLabel>
            <Input
              type="number"
              value={config.maxIssuesPerScan ?? 20}
              onChange={e => setConfig({ ...config, maxIssuesPerScan: Number(e.target.value) })}
              slotProps={{ input: { min: 1, max: 100 } }}
              sx={{ maxWidth: 120 }}
              data-testid="secops-triage-max-issues-input"
            />
            <FormHelperText>
              Cap on issues created per scan (1–100). Highest severity findings are processed first.
            </FormHelperText>
          </FormControl>
        </Stack>
      </ConfigSection>

      {/* Slack Settings */}
      <ConfigSection title="Slack Notifications">
        <Stack spacing={2}>
          <FormControl>
            <FormLabel>Workspace</FormLabel>
            <Select
              value={config.slackWorkspaceId ?? ''}
              onChange={(_, value) => setConfig({ ...config, slackWorkspaceId: value || undefined })}
              placeholder="Select workspace..."
              data-testid="secops-triage-slack-workspace-select"
            >
              {workspacesData?.workspaces.map(ws => (
                <Option key={ws.id} value={ws.id}>
                  {ws.name || ws.slackTeamId}
                </Option>
              ))}
            </Select>
            <FormHelperText>
              Slack app/workspace to use for posting. Must be invited to the channel below. Leave empty to use the first
              active workspace.
            </FormHelperText>
          </FormControl>

          <FormControl>
            <FormLabel>Slack Channel ID</FormLabel>
            <Input
              value={config.slackChannelId ?? ''}
              onChange={e => setConfig({ ...config, slackChannelId: e.target.value || undefined })}
              placeholder="e.g. C0AM7B67G2U"
              data-testid="secops-triage-slack-channel-input"
            />
            <FormHelperText>
              Channel ID to post the triage summary after each scan. Leave empty to disable Slack notifications.
            </FormHelperText>
          </FormControl>
        </Stack>
      </ConfigSection>

      {/* LLM Enrichment */}
      <ConfigSection title="LLM Enrichment">
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Box>
              <Typography level="title-sm">
                LLM Enrichment{' '}
                {config.llmEnrichment && (
                  <Chip size="sm" color="primary" variant="soft">
                    Active
                  </Chip>
                )}
              </Typography>
              <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
                When enabled, the LLM will generate a combined &quot;Where It Was Found&quot; explanation and &quot;How
                to Fix&quot; section for each new GitHub issue, plus an overall health assessment in the Slack summary.
              </Typography>
            </Box>
            <Switch
              checked={config.llmEnrichment ?? false}
              onChange={e => setConfig({ ...config, llmEnrichment: e.target.checked })}
              color={config.llmEnrichment ? 'primary' : 'neutral'}
              data-testid="secops-triage-llm-enrichment-switch"
            />
          </Stack>

          {config.llmEnrichment && (
            <FormControl>
              <FormLabel>Model</FormLabel>
              <Select
                value={config.modelId ?? null}
                onChange={(_, val) => setConfig({ ...config, modelId: val ?? undefined })}
                placeholder="Choose a model..."
                data-testid="secops-triage-model-select"
              >
                {textModels.map(model => (
                  <Option key={model.id} value={model.id}>
                    {model.name}
                  </Option>
                ))}
              </Select>
              <FormHelperText>
                LLM model used for finding enrichment and health assessment. A fast model like Claude Haiku is
                recommended to keep scan processing time low.
              </FormHelperText>
            </FormControl>
          )}
        </Stack>
      </ConfigSection>

      {/* Save / Reset */}
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <Button
          variant="plain"
          color="neutral"
          startDecorator={<ReplayIcon />}
          onClick={handleReset}
          disabled={!isDirty}
          data-testid="secops-triage-reset-btn"
        >
          Reset
        </Button>
        <Button
          variant="solid"
          color="primary"
          startDecorator={<SaveIcon />}
          onClick={handleSave}
          disabled={!isDirty}
          loading={updateSettings.isPending}
          data-testid="secops-triage-save-btn"
        >
          Save
        </Button>
      </Stack>

      {isDirty && (
        <Typography level="body-xs" sx={{ color: 'warning.500', textAlign: 'right' }}>
          You have unsaved changes.
        </Typography>
      )}
    </Stack>
  );
}

// Tab Export

export default function SecopsTriageTab() {
  return (
    <Sheet sx={{ p: 3, maxWidth: 800 }}>
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 3 }}>
        <SecurityIcon sx={{ color: 'primary.500' }} />
        <Box>
          <Typography level="title-lg">SecOps Triage</Typography>
          <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
            Auto-creates GitHub issues for critical/high security scan findings (OWASP ZAP, Gitleaks secrets, package
            CVEs, Semgrep SAST) via the b4m-prod GitHub App.
          </Typography>
        </Box>
      </Stack>
      <SecopsTriageConfigPanel />
    </Sheet>
  );
}
