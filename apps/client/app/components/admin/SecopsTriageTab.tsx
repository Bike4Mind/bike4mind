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
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Option,
  Select,
  Stack,
  Switch,
  Typography,
} from '@mui/joy';
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useGetSettingsValue, useSettingsFromServer, useUpdateSettings } from '@client/app/hooks/data/settings';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { SecopsTriageConfigSchema, type SecopsTriageConfig } from '@bike4mind/common';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { leavesAdminSettingsPage, useRouteAdminTabSwitches } from './SettingsDraftProvider';
import {
  AdminPageHeader,
  ErrorState,
  LoadingState,
  SaveBar,
  SettingsSection,
  StatusChip,
  UnsavedChangesGuard,
} from './shared';
import { ADMIN_DETAIL_MAX_WIDTH, ADMIN_REGION_GAP } from './shared/adminStyles';

interface SlackWorkspace {
  id: string;
  name: string;
  slackTeamId: string;
  isActive: boolean;
}

// Config Section

function ConfigSection({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <SettingsSection component="section" sx={{ mb: 0 }} data-testid={testId}>
      <Typography level="title-md" component="h2" sx={{ mb: 2, color: 'admin.ink' }}>
        {title}
      </Typography>
      {children}
    </SettingsSection>
  );
}

// One count per form control: the two priority selects share the severityToPriority object.
export function countChangedFields(draft: SecopsTriageConfig, saved: SecopsTriageConfig): number {
  const byControl = ({ severityToPriority, ...rest }: SecopsTriageConfig): Record<string, unknown> => ({
    ...rest,
    criticalPriority: severityToPriority?.critical,
    highPriority: severityToPriority?.high,
  });
  const before = byControl(saved);
  const after = byControl(draft);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])).length;
}

// Main Panel

function SecopsTriageConfigPanel() {
  const rawConfig = useGetSettingsValue('secopsTriageConfig');
  const { data: storedSettings, isLoading, isError, isFetching, refetch } = useSettingsFromServer();
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

  const changeCount = config && savedConfig ? countChangedFields(config, savedConfig) : 0;
  useRouteAdminTabSwitches(changeCount > 0);

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

  if (isLoading) return <LoadingState label="Loading SecOps triage settings" testId="secops-triage-loading" />;
  // Without the stored config the form would show defaults, and saving them would overwrite it.
  if (isError && !storedSettings) {
    return (
      <ErrorState
        message="SecOps triage settings could not be loaded."
        onRetry={() => void refetch()}
        retrying={isFetching}
      />
    );
  }
  if (!config) return null;

  return (
    <Stack spacing={2}>
      {/* Master Controls */}
      <ConfigSection title="Master controls" testId="secops-triage-section-master">
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Box>
              <Typography level="title-sm">Enabled</Typography>
              <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                Master kill switch. When disabled, security scan findings are still ingested but no GitHub issues are
                created.
              </Typography>
            </Box>
            <Switch
              checked={config.enabled}
              onChange={e => setConfig({ ...config, enabled: e.target.checked })}
              data-testid="secops-triage-enabled-switch"
            />
          </Stack>

          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Box>
              <Stack direction="row" alignItems="center" gap={1}>
                <Typography level="title-sm">Dry run</Typography>
                {config.dryRun && <StatusChip tone="warn" label="Active" data-testid="secops-triage-dry-run-chip" />}
              </Stack>
              <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                Logs all actions without creating real GitHub issues or posting to Slack. Enable first when testing.
              </Typography>
            </Box>
            <Switch
              checked={config.dryRun ?? false}
              onChange={e => setConfig({ ...config, dryRun: e.target.checked })}
              data-testid="secops-triage-dry-run-switch"
            />
          </Stack>
        </Stack>
      </ConfigSection>

      {/* GitHub Settings */}
      <ConfigSection title="GitHub settings" testId="secops-triage-section-github">
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
      <ConfigSection title="Slack notifications" testId="secops-triage-section-slack">
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
      <ConfigSection title="LLM enrichment" testId="secops-triage-section-llm">
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Box>
              <Stack direction="row" alignItems="center" gap={1}>
                <Typography level="title-sm">LLM enrichment</Typography>
                {config.llmEnrichment && (
                  <StatusChip tone="good" label="Active" data-testid="secops-triage-llm-enrichment-chip" />
                )}
              </Stack>
              <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                When enabled, the LLM will generate a combined &quot;Where It Was Found&quot; explanation and &quot;How
                to Fix&quot; section for each new GitHub issue, plus an overall health assessment in the Slack summary.
              </Typography>
            </Box>
            <Switch
              checked={config.llmEnrichment ?? false}
              onChange={e => setConfig({ ...config, llmEnrichment: e.target.checked })}
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

      <SaveBar
        count={changeCount}
        pending={updateSettings.isPending}
        onSave={() => void handleSave()}
        onDiscard={handleReset}
      />
      <UnsavedChangesGuard
        dirty={changeCount > 0}
        pending={updateSettings.isPending}
        isLeaving={leavesAdminSettingsPage}
      />
    </Stack>
  );
}

// Tab Export

export default function SecopsTriageTab() {
  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP, maxWidth: ADMIN_DETAIL_MAX_WIDTH }} data-testid="admin-secops-triage-tab">
      <AdminPageHeader
        title="SecOps triage"
        description="Creates GitHub issues for critical and high security scan findings (OWASP ZAP, Gitleaks, package CVEs, Semgrep)."
      />
      <SecopsTriageConfigPanel />
    </Stack>
  );
}
