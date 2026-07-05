import React, { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  FormControl,
  FormLabel,
  Input,
  LinearProgress,
  Select,
  Option,
  Stack,
  Typography,
  Textarea,
  Chip,
  Modal,
  ModalDialog,
  ModalClose,
  Table,
  Badge,
  Alert,
} from '@mui/joy';
import {
  Add as AddIcon,
  CheckCircle as CheckCircleIcon,
  Settings as SettingsIcon,
  AutoAwesome as AutoAwesomeIcon,
} from '@mui/icons-material';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

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

const LLM_MODELS = [
  { value: 'claude-opus-4-8', label: 'Claude 4.8 Opus (SOTA Recommended)' },
  { value: 'claude-opus-4-7', label: 'Claude 4.7 Opus (Previous)' },
  { value: 'claude-opus-4-6', label: 'Claude 4.6 Opus' },
  { value: 'claude-sonnet-5', label: 'Claude 5 Sonnet (SOTA Sonnet)' },
  { value: 'claude-sonnet-4-6', label: 'Claude 4.6 Sonnet' },
  { value: 'claude-opus-4-20250514', label: 'Claude 4 Opus' },
  // claude-sonnet-4-20250514 retired upstream, dropped from the picker; resolveDeprecatedModelId
  // remaps any existing config still pinned to it (use claude-sonnet-4-6 instead).
  { value: 'claude-sonnet-4-5-20250929', label: 'Claude 4.5 Sonnet' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude 4.5 Haiku (Fast)' },
  { value: 'o3-2025-04-16', label: 'OpenAI O3 (Reasoning)' },
  { value: 'gpt-4.1-2025-04-14', label: 'GPT-4.1 (Latest)' },
  { value: 'grok-3', label: 'Grok 3 (xAI Latest)' },
  { value: 'gpt-4o', label: 'GPT-4o' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast)' },
];

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

const AgentOpsTab: React.FC = () => {
  const [settings, setSettings] = useState<AgentOpsSettings | null>(null);
  const [versions, setVersions] = useState<MetaPromptVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Modal states
  const [isCreateVersionModalOpen, setIsCreateVersionModalOpen] = useState(false);
  const [isEditSettingsModalOpen, setIsEditSettingsModalOpen] = useState(false);
  const [newVersionData, setNewVersionData] = useState({ metaPrompt: '', description: '' });

  // Settings form state
  const [settingsForm, setSettingsForm] = useState({
    generationLlmModel: 'claude-opus-4-20250514',
    rateLimitSeconds: 60,
    isEnabled: true,
  });

  const loadData = async () => {
    setLoading(true);
    try {
      const settingsResponse = await api.get('/api/admin/agent-ops-settings');
      const settingsData = settingsResponse.data;
      setSettings(settingsData);
      setSettingsForm({
        generationLlmModel: settingsData.generationLlmModel,
        rateLimitSeconds: settingsData.rateLimitSeconds,
        isEnabled: settingsData.isEnabled,
      });

      const versionsResponse = await api.get('/api/admin/agent-ops-settings/versions');
      setVersions(versionsResponse.data);
    } catch (error) {
      console.error('Error loading AgentOps data:', error);
      toast.error('Failed to load AgentOps settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      await api.put('/api/admin/agent-ops-settings', settingsForm);
      toast.success('Settings saved successfully');
      setIsEditSettingsModalOpen(false);
      await loadData();
    } catch (error) {
      console.error('Error saving settings:', error);
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
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

  if (loading) {
    return (
      <Box sx={{ p: 3 }}>
        <LinearProgress />
        <Typography level="body-sm" sx={{ mt: 1 }}>
          Loading AgentOps settings...
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3 }}>
      <Stack spacing={3}>
        {/* Header */}
        <Box>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography level="h2" startDecorator={<AutoAwesomeIcon />}>
              Agent Operations Dashboard
            </Typography>
            <ContextHelpButton helpId="admin/agent-operations" tooltipText="Agent Operations Help" />
          </Stack>
          <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
            Manage system prompt generation settings and meta-prompt templates for AI agents
          </Typography>
        </Box>

        {/* Status Overview */}
        <Card variant="outlined">
          <CardContent>
            <Typography level="title-md" sx={{ mb: 2 }}>
              System Status
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ flexWrap: 'wrap', gap: { xs: 0, sm: 3 } }}>
              <Box sx={{ minWidth: { xs: '100%', sm: 'auto' } }}>
                <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                  Service Status
                </Typography>
                <Chip color={settings?.isEnabled ? 'success' : 'danger'} size="sm">
                  {settings?.isEnabled ? 'Enabled' : 'Disabled'}
                </Chip>
              </Box>
              <Box sx={{ minWidth: { xs: '100%', sm: 'auto' } }}>
                <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                  Active Meta-prompt
                </Typography>
                <Typography level="body-sm" fontWeight="bold">
                  Version {settings?.currentVersionNumber || 'None'}
                </Typography>
              </Box>
              <Box sx={{ minWidth: { xs: '100%', sm: 'auto' } }}>
                <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                  Total Generations
                </Typography>
                <Typography level="body-sm" fontWeight="bold">
                  {settings?.totalGenerationsCount || 0}
                </Typography>
              </Box>
              <Box sx={{ minWidth: { xs: '100%', sm: 'auto' } }}>
                <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                  Rate Limit
                </Typography>
                <Typography level="body-sm" fontWeight="bold">
                  {settings?.rateLimitSeconds || 60}s
                </Typography>
              </Box>
              <Box sx={{ minWidth: { xs: '100%', sm: 'auto' } }}>
                <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                  LLM Model
                </Typography>
                <Typography level="body-sm" fontWeight="bold">
                  {LLM_MODELS.find(m => m.value === settings?.generationLlmModel)?.label || 'Unknown'}
                </Typography>
              </Box>
            </Stack>
          </CardContent>
        </Card>

        {/* Quick Actions */}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <Button
            variant="solid"
            color="primary"
            startDecorator={<AddIcon />}
            onClick={() => setIsCreateVersionModalOpen(true)}
            sx={{ width: { xs: '100%', sm: 'auto' } }}
          >
            Create Meta-prompt Version
          </Button>
          <Button
            variant="outlined"
            startDecorator={<SettingsIcon />}
            onClick={() => setIsEditSettingsModalOpen(true)}
            sx={{ width: { xs: '100%', sm: 'auto' } }}
          >
            Edit Settings
          </Button>
          <Button
            variant="outlined"
            color="warning"
            startDecorator={<AutoAwesomeIcon />}
            onClick={handleRepairDatabase}
            loading={saving}
            disabled={saving}
            sx={{ width: { xs: '100%', sm: 'auto' } }}
          >
            Repair Database
          </Button>
        </Stack>

        {/* Meta-prompt Versions */}
        <Card variant="outlined">
          <CardContent>
            <Typography level="title-md" sx={{ mb: 2 }}>
              Meta-prompt Versions
            </Typography>
            {versions.length === 0 ? (
              <Alert color="warning">
                <Typography level="body-sm">
                  No meta-prompt versions found. Create one to enable system prompt generation.
                </Typography>
              </Alert>
            ) : (
              <Table stickyHeader>
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Description</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map(version => (
                    <tr key={version.versionNumber}>
                      <td>
                        <Typography level="body-sm" fontWeight="bold">
                          v{version.versionNumber}
                        </Typography>
                      </td>
                      <td>
                        <Typography level="body-sm">{version.description || 'No description'}</Typography>
                      </td>
                      <td>
                        {version.isActive ? (
                          <Badge color="success" size="sm">
                            <CheckCircleIcon sx={{ fontSize: 'inherit' }} />
                            Active
                          </Badge>
                        ) : (
                          <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                            Inactive
                          </Typography>
                        )}
                      </td>
                      <td>
                        <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                          {formatDate(version.createdAt)}
                        </Typography>
                      </td>
                      <td>
                        <Stack direction="row" spacing={1}>
                          {!version.isActive && (
                            <Button
                              size="sm"
                              variant="soft"
                              color="primary"
                              onClick={() => handleActivateVersion(version.versionNumber)}
                              disabled={saving}
                            >
                              Activate
                            </Button>
                          )}
                        </Stack>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardContent>
        </Card>
      </Stack>

      {/* Create Version Modal */}
      <Modal open={isCreateVersionModalOpen} onClose={() => setIsCreateVersionModalOpen(false)}>
        <ModalDialog sx={{ maxWidth: '800px', width: '90%', maxHeight: '80vh', overflow: 'auto' }}>
          <ModalClose />
          <Typography level="h4" sx={{ mb: 2 }}>
            Create New Meta-prompt Version
          </Typography>

          <Stack spacing={2}>
            <FormControl>
              <FormLabel>Description</FormLabel>
              <Input
                value={newVersionData.description}
                onChange={e => setNewVersionData(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Brief description of this version..."
              />
            </FormControl>

            <FormControl>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <FormLabel>Meta-prompt Content</FormLabel>
                <Button
                  size="sm"
                  variant="soft"
                  onClick={handleUseDefaultMetaPrompt}
                  startDecorator={<AutoAwesomeIcon />}
                >
                  Use Default Template
                </Button>
              </Box>
              <Textarea
                minRows={15}
                maxRows={25}
                value={newVersionData.metaPrompt}
                onChange={e => setNewVersionData(prev => ({ ...prev, metaPrompt: e.target.value }))}
                placeholder="Enter the meta-prompt content..."
                sx={{ fontFamily: 'monospace', fontSize: '0.875rem' }}
              />
            </FormControl>

            <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
              <Button variant="outlined" onClick={() => setIsCreateVersionModalOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="solid"
                color="primary"
                loading={saving}
                onClick={handleCreateVersion}
                disabled={!newVersionData.metaPrompt.trim()}
              >
                Create Version
              </Button>
            </Box>
          </Stack>
        </ModalDialog>
      </Modal>

      {/* Edit Settings Modal */}
      <Modal open={isEditSettingsModalOpen} onClose={() => setIsEditSettingsModalOpen(false)}>
        <ModalDialog sx={{ maxWidth: '500px', width: '90%' }}>
          <ModalClose />
          <Typography level="h4" sx={{ mb: 2 }}>
            Agent Operations Settings
          </Typography>

          <Stack spacing={2}>
            <FormControl>
              <FormLabel>LLM Model for Generation</FormLabel>
              <Select
                value={settingsForm.generationLlmModel}
                onChange={(_, value) => value && setSettingsForm(prev => ({ ...prev, generationLlmModel: value }))}
              >
                {LLM_MODELS.map(model => (
                  <Option key={model.value} value={model.value}>
                    {model.label}
                  </Option>
                ))}
              </Select>
            </FormControl>

            <FormControl>
              <FormLabel>Rate Limit (seconds)</FormLabel>
              <Input
                type="number"
                value={settingsForm.rateLimitSeconds}
                onChange={e => setSettingsForm(prev => ({ ...prev, rateLimitSeconds: parseInt(e.target.value) || 60 }))}
                slotProps={{ input: { min: 0, max: 3600 } }}
              />
              <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                Minimum seconds between system prompt generations per agent
              </Typography>
            </FormControl>

            <FormControl>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <input
                  type="checkbox"
                  id="isEnabled"
                  checked={settingsForm.isEnabled}
                  onChange={e => setSettingsForm(prev => ({ ...prev, isEnabled: e.target.checked }))}
                />
                <FormLabel htmlFor="isEnabled">Enable system prompt generation</FormLabel>
              </Box>
            </FormControl>

            <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
              <Button variant="outlined" onClick={() => setIsEditSettingsModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="solid" color="primary" loading={saving} onClick={handleSaveSettings}>
                Save Settings
              </Button>
            </Box>
          </Stack>
        </ModalDialog>
      </Modal>
    </Box>
  );
};

export default AgentOpsTab;
