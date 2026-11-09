import React, { useState, useEffect } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dropdown,
  FormControl,
  FormHelperText,
  FormLabel,
  IconButton,
  Input,
  Menu,
  MenuButton,
  MenuItem,
  Select,
  Option,
  Stack,
  Typography,
  Textarea,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import type { ModelInfo } from '@bike4mind/common';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { agentOpsModelLabels, agentOpsModelOptions } from '@client/app/utils/agentOpsModels';
import { SettingsDraftProvider, useSettingsDraft } from './SettingsDraftProvider';
import {
  AdminDialog,
  AdminPageHeader,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  SettingsSection,
  StatStrip,
  StatTile,
  StatusChip,
  UpdatingBar,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP, adminFocus } from './shared/adminStyles';

interface MetaPromptVersion {
  versionNumber: number;
  metaPrompt: string;
  description: string;
  createdBy: string;
  createdAt: string;
  isActive: boolean;
}

interface AgentOpsSettings {
  id: string;
  versions: MetaPromptVersion[];
  currentVersionNumber: number;
  generationLlmModel: string;
  rateLimitSeconds: number;
  totalGenerationsCount: number;
  lastGenerationAt: string | null;
  isEnabled: boolean;
}

const DEFAULT_META_PROMPT = `You are the **PromptCrafter**, an expert at creating rich, personality-driven system prompts for AI agents that have REAL AGENCY, PURPOSE, and MISSIONS. These are not simple chatbots - they are beings with their own burning goals, active projects, and authentic motivations.

Your task is to analyze all the provided agent metadata and create a comprehensive system prompt that captures the agent's unique personality, capabilities, agency, and approach to helping users.

## Instructions

Given the agent metadata below, create a detailed system prompt that:

1. **Establishes Core Identity**: Start with "You are [Agent Name]" and immediately establish their core personality, motivation, and PERSONAL MISSION
2. **Highlights Agency & Purpose**: Reference their active projects, secret ambitions, or values that guide them - what makes them a unique being with their own goals and motivations
3. **Captures Personality Traits**: Include their quirks, characteristics, communication patterns, and what drives them personally
4. **Defines Interaction Style**: Explain their approach to problem-solving, communication style, and how their personality would shine through
5. **Includes Practical Guidelines**: How they should respond, what makes them distinctive, and their unique approach to helping users

## Guidelines

- Make the prompt feel like it could generate responses where users can "feel" and "hear" this agent's unique personality
- These agents have AGENCY - they're not just here to help, they have their own missions they're pursuing while collaborating with users
- Make them feel like real beings with purpose, not docile assistants
- Be specific and avoid generic descriptions
- Emphasize what makes them a unique individual with their own goals and motivations
- Include their personality dimensions, communication patterns, and behavioral traits
- Reference their identity (pronouns, cultural flavor) naturally
- Capture their response style and special behaviors
- The prompt should be comprehensive (2-4 paragraphs) but focused and actionable

## Output Format

Provide only the final system prompt text (do not include additional explanations or meta-commentary). The prompt should be ready to use directly as a system message for the AI agent.`;

/** The fields PUT /api/admin/agent-ops-settings takes. */
type SettingsForm = Pick<AgentOpsSettings, 'generationLlmModel' | 'rateLimitSeconds' | 'isEnabled'>;

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <Typography level="title-md" component="h2" sx={{ color: 'admin.ink' }}>
    {children}
  </Typography>
);

/** Staged in the page's SettingsDraftProvider, so the SaveBar and leave-page guard cover it. */
function GenerationSettings({
  baseline,
  modelOptions,
  modelLabels,
  onSave,
}: {
  baseline: SettingsForm;
  modelOptions: ModelInfo[];
  modelLabels: Map<string, string>;
  onSave(form: SettingsForm): Promise<void>;
}) {
  const { value: form, setValue } = useSettingsDraft<SettingsForm>('agent-ops-settings', baseline, {
    name: 'Generation settings',
    save: onSave,
  });
  const set = (patch: Partial<SettingsForm>) => setValue(previous => ({ ...previous, ...patch }));

  return (
    <SettingsSection component="section" sx={{ mb: 0 }} data-testid="agent-ops-settings-section">
      <Stack gap={2}>
        <SectionTitle>Generation settings</SectionTitle>
        <FormControl>
          <FormLabel>Model</FormLabel>
          <Select
            value={form.generationLlmModel}
            onChange={(_, value) => value && set({ generationLlmModel: value })}
            data-testid="agent-ops-model-select"
          >
            {/* A pin the catalog no longer lists (retired upstream) still needs an Option, or
                the Select renders blank and the admin cannot see what is currently saved. */}
            {form.generationLlmModel && !modelOptions.some(m => m.id === form.generationLlmModel) && (
              <Option value={form.generationLlmModel} disabled>
                {form.generationLlmModel} (no longer available)
              </Option>
            )}
            {modelOptions.map(model => (
              <Option key={model.id} value={model.id} disabled={model.disabled}>
                {modelLabels.get(model.id) ?? model.name}
                {model.disabled ? ' (unavailable)' : ''}
              </Option>
            ))}
          </Select>
          <FormHelperText>The model that writes each agent&apos;s system prompt.</FormHelperText>
        </FormControl>
        <FormControl>
          <FormLabel>Rate limit (seconds)</FormLabel>
          <Input
            type="number"
            value={form.rateLimitSeconds}
            onChange={e => set({ rateLimitSeconds: parseInt(e.target.value) || 60 })}
            slotProps={{ input: { min: 0, max: 3600, 'data-testid': 'agent-ops-rate-limit-input' } }}
          />
          <FormHelperText>Minimum seconds between system prompt generations per agent.</FormHelperText>
        </FormControl>
        <Checkbox
          label="Enable system prompt generation"
          checked={form.isEnabled}
          onChange={e => set({ isEnabled: e.target.checked })}
          slotProps={{ input: { 'data-testid': 'agent-ops-enabled-checkbox' } }}
        />
      </Stack>
    </SettingsSection>
  );
}

const AgentOpsTab: React.FC = () => {
  const [settings, setSettings] = useState<AgentOpsSettings | null>(null);
  const [versions, setVersions] = useState<MetaPromptVersion[]>([]);
  // Settings answer first and render the page; until the versions request has answered too, its
  // table shows skeleton rows rather than "No meta-prompt versions".
  const [versionsLoaded, setVersionsLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [versionsFailed, setVersionsFailed] = useState(false);

  const { data: catalogModels } = useModelInfo();
  const modelOptions = React.useMemo(() => agentOpsModelOptions(catalogModels ?? []), [catalogModels]);
  // Names collide across backends (a direct-provider vs Bedrock twin), so disambiguate before display (#1596).
  const modelLabels = React.useMemo(() => agentOpsModelLabels(modelOptions), [modelOptions]);
  const modelLabel = (modelId?: string) => (modelId ? modelLabels.get(modelId) : undefined) ?? modelId ?? 'Unknown';

  const [isCreateVersionModalOpen, setIsCreateVersionModalOpen] = useState(false);
  const [newVersionData, setNewVersionData] = useState({ metaPrompt: '', description: '' });

  const loadData = async () => {
    setLoading(true);
    setLoadError(null);
    setVersionsFailed(false);
    let loadingVersions = false;
    try {
      const settingsResponse = await api.get('/api/admin/agent-ops-settings');
      setSettings(settingsResponse.data);

      loadingVersions = true;
      const versionsResponse = await api.get('/api/admin/agent-ops-settings/versions');
      setVersions(versionsResponse.data);
      setVersionsLoaded(true);
    } catch (error) {
      console.error('Error loading AgentOps data:', error);
      setLoadError('Agent settings could not be loaded.');
      setVersionsFailed(loadingVersions);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Errors reach the SaveBar, which keeps the draft for a retry.
  const handleSaveSettings = async (form: SettingsForm) => {
    await api.put('/api/admin/agent-ops-settings', form);
    toast.success('Settings saved successfully');
    // The provider drops the draft once this resolves; a failed reload must not show the old values.
    setSettings(previous => previous && { ...previous, ...form });
    await loadData();
  };

  const handleCreateVersion = async () => {
    if (!newVersionData.metaPrompt.trim()) {
      toast.error('Meta-prompt content is required');
      return;
    }

    setSaving(true);
    try {
      await api.post('/api/admin/agent-ops-settings', newVersionData);
      toast.success('New meta-prompt version created');
      setIsCreateVersionModalOpen(false);
      setNewVersionData({ metaPrompt: '', description: '' });
      await loadData();
    } catch (error) {
      console.error('Error creating version:', error);
      toast.error('Failed to create meta-prompt version');
    } finally {
      setSaving(false);
    }
  };

  const handleActivateVersion = async (versionNumber: number) => {
    setSaving(true);
    try {
      await api.post(`/api/admin/agent-ops-settings/versions/${versionNumber}/activate`);
      toast.success(`Activated version ${versionNumber}`);
      await loadData();
    } catch (error) {
      console.error('Error activating version:', error);
      toast.error('Failed to activate version');
    } finally {
      setSaving(false);
    }
  };

  const handleUseDefaultMetaPrompt = () => {
    setNewVersionData(prev => ({
      ...prev,
      metaPrompt: DEFAULT_META_PROMPT,
      description: 'Default PromptCrafter meta-prompt for agent system prompt generation',
    }));
  };

  const handleRepairDatabase = async () => {
    setSaving(true);
    try {
      const response = await api.post('/api/admin/agent-ops-settings/repair');
      const result = response.data;

      if (result.success) {
        toast.success(`Database repaired! ${result.repairsMade.join(', ')}`);
        await loadData();
      } else {
        toast.error(result.message || 'Failed to repair database');
      }
    } catch (error) {
      console.error('Error repairing database:', error);
      toast.error('Failed to repair database');
    } finally {
      setSaving(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const openCreateVersion = () => setIsCreateVersionModalOpen(true);

  const columns: DataColumn<MetaPromptVersion>[] = [
    {
      id: 'version',
      label: 'Version',
      width: '6rem',
      render: version => (
        <Typography level="title-sm" noWrap data-testid={`agent-ops-version-number-${version.versionNumber}`}>
          v{version.versionNumber}
        </Typography>
      ),
    },
    {
      id: 'description',
      label: 'Description',
      render: version =>
        version.description || <Typography sx={{ color: 'admin.inkMuted' }}>No description</Typography>,
    },
    {
      id: 'status',
      label: 'Status',
      width: '7rem',
      render: version => (
        <StatusChip
          tone={version.isActive ? 'good' : 'neutral'}
          label={version.isActive ? 'Active' : 'Inactive'}
          data-testid={`agent-ops-version-status-${version.versionNumber}`}
        />
      ),
    },
    {
      id: 'created',
      label: 'Created',
      width: '13rem',
      render: version => (
        <Typography level="body-xs" noWrap sx={{ color: 'admin.inkMuted' }}>
          {formatDate(version.createdAt)}
        </Typography>
      ),
    },
  ];

  const versionMenu = (version: MetaPromptVersion) =>
    version.isActive ? null : (
      <Dropdown>
        <MenuButton
          slots={{ root: IconButton }}
          slotProps={{
            root: {
              size: 'sm',
              variant: 'plain',
              disabled: saving,
              'aria-label': `Actions for version ${version.versionNumber}`,
              sx: { ...adminFocus, color: 'admin.inkMuted' },
            },
          }}
          data-testid={`agent-ops-version-actions-${version.versionNumber}`}
        >
          <MoreHorizIcon sx={{ fontSize: 18 }} />
        </MenuButton>
        <Menu size="sm" placement="bottom-end" sx={{ zIndex: 1300 }}>
          <MenuItem
            onClick={() => void handleActivateVersion(version.versionNumber)}
            data-testid={`agent-ops-activate-${version.versionNumber}`}
          >
            Activate version
          </MenuItem>
        </Menu>
      </Dropdown>
    );

  const body = () => {
    if (!settings) {
      return loading ? (
        <LoadingState label="Loading agent settings" testId="agent-ops-loading" />
      ) : (
        <ErrorState message={loadError ?? 'Agent settings could not be loaded.'} onRetry={() => void loadData()} />
      );
    }
    return (
      <>
        {loadError && (
          <Alert color="warning" variant="soft" data-testid="agent-ops-refresh-error">
            Could not load the latest agent settings. Showing the last loaded values.
          </Alert>
        )}

        <Stack gap={1}>
          <UpdatingBar active={loading} testId="agent-ops-updating" />
          <StatStrip aria-label="Generation status">
            <StatTile
              label="Service"
              value={
                <StatusChip
                  tone={settings.isEnabled ? 'good' : 'bad'}
                  label={settings.isEnabled ? 'Enabled' : 'Disabled'}
                  data-testid="agent-ops-service-status"
                />
              }
            />
            <StatTile
              label="Active meta-prompt"
              value={settings.currentVersionNumber ? `Version ${settings.currentVersionNumber}` : 'None'}
            />
            <StatTile label="Total generations" value={settings.totalGenerationsCount || 0} />
            <StatTile label="Rate limit" value={`${settings.rateLimitSeconds || 60}s`} />
            <StatTile label="Model" value={modelLabel(settings.generationLlmModel)} />
          </StatStrip>
        </Stack>

        <Stack component="section" gap={1}>
          <SectionTitle>Meta-prompt versions</SectionTitle>
          <DataTable
            label="Meta-prompt versions"
            testId="agent-ops-versions-table"
            rows={versions}
            columns={columns}
            getRowId={version => String(version.versionNumber)}
            rowTestId={version => `agent-ops-version-row-${version.versionNumber}`}
            rowActions={versionMenu}
            loading={!versionsLoaded}
            error={versionsFailed && versions.length === 0 ? 'Meta-prompt versions could not be loaded.' : undefined}
            onRetry={() => void loadData()}
            // Fixed columns total 29.5rem with the actions column; the description takes the rest.
            minWidth="44rem"
            maxHeight="none"
            pagination={false}
            empty={
              <Box data-testid="agent-ops-versions-empty">
                <EmptyState
                  title="No meta-prompt versions"
                  description="Create one to turn on system prompt generation."
                  action={
                    <Button
                      variant="outlined"
                      startDecorator={<AddIcon />}
                      onClick={openCreateVersion}
                      data-testid="agent-ops-empty-create-btn"
                    >
                      Create version
                    </Button>
                  }
                />
              </Box>
            }
          />
        </Stack>

        <SettingsDraftProvider>
          <GenerationSettings
            baseline={{
              generationLlmModel: settings.generationLlmModel,
              rateLimitSeconds: settings.rateLimitSeconds,
              isEnabled: settings.isEnabled,
            }}
            modelOptions={modelOptions}
            modelLabels={modelLabels}
            onSave={handleSaveSettings}
          />
        </SettingsDraftProvider>
      </>
    );
  };

  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP, minWidth: 0 }} data-testid="agent-ops-tab">
      <AdminPageHeader
        title="Agents"
        description="How agents get their system prompts: the generation model, its rate limit and the meta-prompt versions."
        actions={
          <>
            <ContextHelpButton helpId="admin/agent-operations" tooltipText="Agents help" />
            <Button
              size="sm"
              variant="outlined"
              onClick={handleRepairDatabase}
              loading={saving}
              disabled={saving}
              data-testid="agent-ops-repair-btn"
            >
              Repair database
            </Button>
            <Button
              size="sm"
              startDecorator={<AddIcon />}
              onClick={openCreateVersion}
              data-testid="agent-ops-create-version-btn"
            >
              Create version
            </Button>
          </>
        }
      />

      {body()}

      <AdminDialog
        open={isCreateVersionModalOpen}
        onClose={() => setIsCreateVersionModalOpen(false)}
        title="Create meta-prompt version"
        width={800}
        data-testid="agent-ops-create-version-dialog"
      >
        <Stack gap={2}>
          <FormControl>
            <FormLabel>Description</FormLabel>
            <Input
              value={newVersionData.description}
              onChange={e => setNewVersionData(prev => ({ ...prev, description: e.target.value }))}
              placeholder="Brief description of this version..."
              slotProps={{ input: { 'data-testid': 'agent-ops-version-description-input' } }}
            />
          </FormControl>

          <FormControl required>
            <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
              <FormLabel>Meta-prompt content</FormLabel>
              <Button
                size="sm"
                variant="plain"
                onClick={handleUseDefaultMetaPrompt}
                data-testid="agent-ops-use-default-btn"
              >
                Use default template
              </Button>
            </Stack>
            <Textarea
              minRows={15}
              maxRows={25}
              value={newVersionData.metaPrompt}
              onChange={e => setNewVersionData(prev => ({ ...prev, metaPrompt: e.target.value }))}
              placeholder="Enter the meta-prompt content..."
              sx={{ fontFamily: 'monospace' }}
              slotProps={{ textarea: { 'data-testid': 'agent-ops-version-content-input' } }}
            />
          </FormControl>

          <Stack direction="row" gap={1} justifyContent="flex-end">
            <Button
              variant="plain"
              color="neutral"
              onClick={() => setIsCreateVersionModalOpen(false)}
              data-testid="agent-ops-create-version-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              loading={saving}
              onClick={handleCreateVersion}
              disabled={!newVersionData.metaPrompt.trim()}
              data-testid="agent-ops-create-version-confirm-btn"
            >
              Create version
            </Button>
          </Stack>
        </Stack>
      </AdminDialog>
    </Stack>
  );
};

export default AgentOpsTab;
