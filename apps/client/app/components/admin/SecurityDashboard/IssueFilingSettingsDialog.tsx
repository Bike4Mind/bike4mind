import {
  Box,
  Button,
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
import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SecopsTriageConfigFieldsSchema, SecopsTriageConfigSchema, type SecopsTriageConfig } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { SECOPS_TRIAGE_STATUS_QUERY_KEY } from '@client/app/hooks/data/admin';
import { useGetSettingsValue, useSettingsFromServer, useUpdateSettings } from '@client/app/hooks/data/settings';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { AdminDialog, AdminDialogFooter, ErrorState, LoadingState, StatusChip, UnsavedChangesGuard } from '../shared';
import { leavesAdminSettingsPage, useRouteAdminTabSwitches } from '../shared/adminTabSwitches';
import {
  DEFAULT_SECURITY_VIEW,
  SECURITY_DASHBOARD_SEARCH_PARSERS,
  SECURITY_VIEW_PARAM,
} from '../securityDashboardSearch';

interface SlackWorkspace {
  id: string;
  name: string;
  slackTeamId: string;
  isActive: boolean;
}

const TEST_ID = 'security-issue-filing-settings';

/** The editor belongs to Scans; other Security views unmount it just like another admin tab. */
export function leavesIssueFilingSettings(
  current: Parameters<typeof leavesAdminSettingsPage>[0],
  next: Parameters<typeof leavesAdminSettingsPage>[1]
): boolean {
  if (leavesAdminSettingsPage(current, next)) return true;
  const value = SECURITY_VIEW_PARAM in next.search ? next.search[SECURITY_VIEW_PARAM] : undefined;
  return (SECURITY_DASHBOARD_SEARCH_PARSERS[SECURITY_VIEW_PARAM](value) ?? DEFAULT_SECURITY_VIEW) !== 'scans';
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

function FormGroup({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <Box
      component="section"
      data-testid={testId}
      sx={{ pt: 2, borderTop: '1px solid', borderColor: 'admin.border', '&:first-of-type': { pt: 0, borderTop: 0 } }}
    >
      <Typography level="title-md" component="h3" sx={{ mb: 1.5, color: 'admin.ink' }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

function SwitchRow({
  title,
  chip,
  description,
  checked,
  onChange,
  testId,
}: {
  title: string;
  chip?: ReactNode;
  description: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId: string;
}) {
  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
      <Box>
        <Stack direction="row" alignItems="center" gap={1}>
          <Typography level="title-sm">{title}</Typography>
          {chip}
        </Stack>
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          {description}
        </Typography>
      </Box>
      <Switch checked={checked} onChange={event => onChange(event.target.checked)} data-testid={testId} />
    </Stack>
  );
}

function SettingsForm({
  config,
  setConfig,
}: {
  config: SecopsTriageConfig;
  setConfig: (config: SecopsTriageConfig) => void;
}) {
  const { data: models } = useModelInfo();
  const textModels = models?.filter(model => model.type === 'text') ?? [];
  const { data: workspacesData } = useQuery({
    queryKey: ['slackWorkspaces'],
    queryFn: async () => (await api.get('/api/admin/slack-workspaces')).data as { workspaces: SlackWorkspace[] },
  });

  return (
    <Stack gap={2}>
      <FormGroup title="Master controls" testId={`${TEST_ID}-section-master`}>
        <Stack gap={2}>
          <SwitchRow
            title="Enabled"
            description="Master kill switch. When off, security scan findings are still ingested but no GitHub issues are created."
            checked={config.enabled}
            onChange={enabled => setConfig({ ...config, enabled })}
            testId={`${TEST_ID}-enabled-switch`}
          />
          <SwitchRow
            title="Dry run"
            chip={config.dryRun && <StatusChip tone="warn" label="Active" data-testid={`${TEST_ID}-dry-run-chip`} />}
            description="Logs each action without creating, commenting on, reopening or closing GitHub issues. The Slack summary is still posted, marked as a dry run."
            checked={config.dryRun ?? false}
            onChange={dryRun => setConfig({ ...config, dryRun })}
            testId={`${TEST_ID}-dry-run-switch`}
          />
        </Stack>
      </FormGroup>

      <FormGroup title="GitHub settings" testId={`${TEST_ID}-section-github`}>
        <Stack gap={2}>
          <FormControl>
            <FormLabel>Repository</FormLabel>
            <Input
              value={config.githubRepo}
              onChange={event => setConfig({ ...config, githubRepo: event.target.value })}
              placeholder="owner/repo"
              data-testid={`${TEST_ID}-github-repo-input`}
            />
            <FormHelperText>
              GitHub repository where issues are filed, in owner/repo form. Required while filing is enabled, and it
              must be a private repository the GitHub connection is allowed to use.
            </FormHelperText>
          </FormControl>

          <FormControl>
            <FormLabel>Severity threshold</FormLabel>
            <Select
              value={config.severityThreshold}
              onChange={(_, value) => value && setConfig({ ...config, severityThreshold: value })}
              data-testid={`${TEST_ID}-severity-threshold-select`}
            >
              <Option value="critical">Critical only</Option>
              <Option value="high">High and above (recommended)</Option>
            </Select>
            <FormHelperText>Lowest severity that files an issue.</FormHelperText>
          </FormControl>

          <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
            <FormControl sx={{ flex: 1 }}>
              <FormLabel>Priority for critical findings</FormLabel>
              <Select
                value={config.severityToPriority?.critical ?? 'P0'}
                onChange={(_, value) =>
                  value &&
                  setConfig({ ...config, severityToPriority: { ...config.severityToPriority, critical: value } })
                }
                data-testid={`${TEST_ID}-critical-priority-select`}
              >
                <Option value="P0">P0 (Critical)</Option>
                <Option value="P1">P1 (High)</Option>
              </Select>
              <FormHelperText>Priority label on issues for critical findings.</FormHelperText>
            </FormControl>

            <FormControl sx={{ flex: 1 }}>
              <FormLabel>Priority for high findings</FormLabel>
              <Select
                value={config.severityToPriority?.high ?? 'P1'}
                onChange={(_, value) =>
                  value && setConfig({ ...config, severityToPriority: { ...config.severityToPriority, high: value } })
                }
                data-testid={`${TEST_ID}-high-priority-select`}
              >
                <Option value="P0">P0 (Critical)</Option>
                <Option value="P1">P1 (High)</Option>
              </Select>
              <FormHelperText>Priority label on issues for high findings.</FormHelperText>
            </FormControl>
          </Stack>

          <FormControl>
            <FormLabel>Max issues per scan</FormLabel>
            <Input
              type="number"
              value={config.maxIssuesPerScan ?? 20}
              onChange={event => setConfig({ ...config, maxIssuesPerScan: Number(event.target.value) })}
              slotProps={{ input: { min: 1, max: 100 } }}
              sx={{ maxWidth: 120 }}
              data-testid={`${TEST_ID}-max-issues-input`}
            />
            <FormHelperText>
              Cap on issues created per scan, 1 to 100. Highest severity findings are processed first.
            </FormHelperText>
          </FormControl>
        </Stack>
      </FormGroup>

      <FormGroup title="Slack notifications" testId={`${TEST_ID}-section-slack`}>
        <Stack gap={2}>
          <FormControl>
            <FormLabel>Workspace</FormLabel>
            <Select
              value={config.slackWorkspaceId ?? ''}
              onChange={(_, value) => setConfig({ ...config, slackWorkspaceId: value || undefined })}
              placeholder="Select workspace..."
              data-testid={`${TEST_ID}-slack-workspace-select`}
            >
              {workspacesData?.workspaces.map(workspace => (
                <Option key={workspace.id} value={workspace.id}>
                  {workspace.name || workspace.slackTeamId}
                </Option>
              ))}
              {/* A stored id the list no longer offers stays selectable: Joy's Select resets a value it cannot
                  find to null on mount, which would mark an untouched form as dirty. */}
              {workspacesData &&
                config.slackWorkspaceId &&
                !workspacesData.workspaces.some(workspace => workspace.id === config.slackWorkspaceId) && (
                  <Option value={config.slackWorkspaceId} data-testid={`${TEST_ID}-slack-workspace-unavailable`}>
                    {`${config.slackWorkspaceId} (not available)`}
                  </Option>
                )}
            </Select>
            <FormHelperText>
              Slack workspace that posts the summary; its app must be invited to the channel below. Leave empty to use
              the first active workspace.
            </FormHelperText>
          </FormControl>

          <FormControl>
            <FormLabel>Slack channel ID</FormLabel>
            <Input
              value={config.slackChannelId ?? ''}
              onChange={event => setConfig({ ...config, slackChannelId: event.target.value || undefined })}
              placeholder="e.g. C0123456789"
              data-testid={`${TEST_ID}-slack-channel-input`}
            />
            <FormHelperText>
              Channel that gets the filing summary after each scan. Leave empty to turn off Slack notifications.
            </FormHelperText>
          </FormControl>
        </Stack>
      </FormGroup>

      <FormGroup title="LLM enrichment" testId={`${TEST_ID}-section-llm`}>
        <Stack gap={2}>
          <SwitchRow
            title="LLM enrichment"
            chip={
              config.llmEnrichment && (
                <StatusChip tone="good" label="Active" data-testid={`${TEST_ID}-llm-enrichment-chip`} />
              )
            }
            description='Adds a "Where it was found" and "How to fix" section to each new issue, and an overall health assessment to the Slack summary.'
            checked={config.llmEnrichment ?? false}
            onChange={llmEnrichment => setConfig({ ...config, llmEnrichment })}
            testId={`${TEST_ID}-llm-enrichment-switch`}
          />
          {config.llmEnrichment && (
            <FormControl>
              <FormLabel>Model</FormLabel>
              <Select
                value={config.modelId ?? null}
                onChange={(_, value) => setConfig({ ...config, modelId: value ?? undefined })}
                placeholder="Choose a model..."
                data-testid={`${TEST_ID}-model-select`}
              >
                {textModels.map(model => (
                  <Option key={model.id} value={model.id}>
                    {model.name}
                  </Option>
                ))}
                {models && config.modelId && !textModels.some(model => model.id === config.modelId) && (
                  <Option value={config.modelId} data-testid={`${TEST_ID}-model-unavailable`}>
                    {`${config.modelId} (not available)`}
                  </Option>
                )}
              </Select>
              <FormHelperText>
                Model for the issue sections and the health assessment. A fast model keeps scan processing quick.
              </FormHelperText>
            </FormControl>
          )}
        </Stack>
      </FormGroup>
    </Stack>
  );
}

/** The one editor for the issue filing settings (`secopsTriageConfig`). Mount it only while open. */
export function IssueFilingSettingsDialog({ onClose }: { onClose: () => void }) {
  const rawConfig = useGetSettingsValue('secopsTriageConfig');
  const { data: storedSettings, isLoading, isError, isFetching, refetch } = useSettingsFromServer();
  const updateSettings = useUpdateSettings();
  const queryClient = useQueryClient();

  const [config, setConfig] = useState<SecopsTriageConfig | null>(null);
  const [savedConfig, setSavedConfig] = useState<SecopsTriageConfig | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  useEffect(() => {
    // A saved value that only breaks a cross-field rule still fills the form, so saving reports that
    // rule instead of writing defaults over the stored fields.
    const parsed = SecopsTriageConfigFieldsSchema.safeParse(rawConfig ?? {});
    const loaded = parsed.success ? parsed.data : SecopsTriageConfigSchema.parse({});
    setConfig(loaded);
    setSavedConfig(loaded);
  }, [rawConfig]);

  const changeCount = config && savedConfig ? countChangedFields(config, savedConfig) : 0;
  const pending = updateSettings.isPending;
  const protectDraft = changeCount > 0 || pending;
  useRouteAdminTabSwitches(protectDraft);

  const handleSave = useCallback(async () => {
    if (!config || changeCount === 0 || pending) return;
    const validation = SecopsTriageConfigSchema.safeParse(config);
    if (!validation.success) {
      toast.error(validation.error.issues[0]?.message ?? 'The settings could not be saved as entered.');
      return;
    }
    try {
      await updateSettings.mutateAsync({ key: 'secopsTriageConfig', value: config });
      setSavedConfig(config);
      toast.success('Issue filing settings saved');
      void queryClient.invalidateQueries({ queryKey: SECOPS_TRIAGE_STATUS_QUERY_KEY });
      onClose();
    } catch (err) {
      toast.error(`Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [config, changeCount, pending, updateSettings, queryClient, onClose]);

  const requestClose = () => {
    if (pending) return;
    if (changeCount > 0) setConfirmingDiscard(true);
    else onClose();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void handleSave();
    }
  };

  // Without the stored config the form would show defaults, and saving them would overwrite it.
  const body = isLoading ? (
    <LoadingState label="Loading issue filing settings" testId={`${TEST_ID}-loading`} />
  ) : isError && !storedSettings ? (
    <ErrorState
      message="Issue filing settings could not be loaded."
      onRetry={() => void refetch()}
      retrying={isFetching}
    />
  ) : config ? (
    <SettingsForm config={config} setConfig={setConfig} />
  ) : null;

  return (
    <AdminDialog
      title="Issue filing settings"
      onClose={requestClose}
      closeDisabled={pending}
      width={640}
      data-testid={TEST_ID}
    >
      <Box onKeyDown={onKeyDown}>
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted', mb: 2 }}>
          Files a GitHub issue for each critical or high finding a scan reports, and closes it when the finding is gone.
          A finding seen again reopens its issue, unless the issue was closed as not planned or as a duplicate.
        </Typography>
        {body}
        <AdminDialogFooter>
          <Typography
            role="status"
            level="body-sm"
            sx={{ color: 'admin.inkMuted', mr: 'auto' }}
            data-testid={`${TEST_ID}-changes`}
          >
            {changeCount === 0 ? 'No unsaved changes' : `${changeCount} unsaved change${changeCount === 1 ? '' : 's'}`}
          </Typography>
          <Button
            variant="outlined"
            color="neutral"
            disabled={pending}
            onClick={requestClose}
            data-testid={`${TEST_ID}-cancel-btn`}
          >
            Cancel
          </Button>
          <Button
            disabled={changeCount === 0}
            loading={pending}
            onClick={() => void handleSave()}
            data-testid={`${TEST_ID}-save-btn`}
          >
            Save settings
          </Button>
        </AdminDialogFooter>
      </Box>
      <AdminDialog
        open={confirmingDiscard}
        role="alertdialog"
        title="Discard unsaved changes?"
        onClose={() => setConfirmingDiscard(false)}
        data-testid={`${TEST_ID}-discard-dialog`}
      >
        <Typography>Closing discards your unsaved edits. Keep editing to save them first.</Typography>
        <AdminDialogFooter>
          <Button
            variant="plain"
            onClick={() => setConfirmingDiscard(false)}
            data-testid={`${TEST_ID}-keep-editing-btn`}
          >
            Keep editing
          </Button>
          <Button color="danger" onClick={onClose} data-testid={`${TEST_ID}-discard-btn`}>
            Discard changes
          </Button>
        </AdminDialogFooter>
      </AdminDialog>
      <UnsavedChangesGuard dirty={protectDraft} pending={pending} isLeaving={leavesIssueFilingSettings} />
    </AdminDialog>
  );
}
