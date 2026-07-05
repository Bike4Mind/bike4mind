import React, { useState, useEffect } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormLabel,
  Grid,
  IconButton,
  Input,
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
  Badge,
  LinearProgress,
  Divider,
} from '@mui/joy';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Edit as EditIcon,
  Save as SaveIcon,
  Speed as SpeedIcon,
  Psychology as PsychologyIcon,
  PlayArrow as PlayArrowIcon,
  CheckCircle as CheckCircleIcon,
  Warning as WarningIcon,
  Refresh as RefreshIcon,
  Bolt as BoltIcon,
} from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { useUpdateSettings } from '@client/app/hooks/data/settings';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import {
  ModelInfo,
  RapidReplyFallbackBehaviors,
  RapidReplyResponseStylesCommon,
  RapidReplyTransitionModes,
} from '@bike4mind/common';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { IRapidReplyMapping } from '@bike4mind/common/types/entities/RapidReplyTypes';
import { api } from '@client/app/contexts/ApiContext';
import { RapidReplyMetrics } from './RapidReplyMetrics';
import { useSaveMapping, useDeleteMapping, useTestConfiguration } from '@client/app/hooks/data/rapidReplyMutations';
import { useExperimentalFeatureSettings } from '@client/app/hooks/data/settings';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

const defaultPrompt = `IMPORTANT: DO NOT ANSWER THE QUESTION. You are providing a quick, friendly acknowledgment that shows you understand the topic while the full response is being prepared. Keep it to ONE sentence only and reference the subject matter.

        Examples:
        - For coding questions: "Working through that [language/framework] code now!"
        - For research requests: "Gathering the latest on [topic] for you!"
        - For creative tasks: "Love this [writing/design] idea - crafting it now!"
        - For technical issues: "Analyzing that [specific problem] - solution coming up!"

        Single sentence only. Always acknowledge the specific topic while indicating work is in progress.`;

// API Hook definitions
const useRapidReplyMappings = () => {
  return useQuery({
    queryKey: ['rapid-reply-mappings'],
    queryFn: async () => {
      const response = await api.get('/api/admin/rapid-reply/mappings');
      return response.data;
    },
  });
};

const useRapidReplyMetrics = () => {
  return useQuery({
    queryKey: ['rapid-reply-metrics'],
    queryFn: async () => {
      const response = await api.get('/api/admin/rapid-reply/metrics');
      return response.data;
    },
    refetchInterval: 30000, // Refresh every 30 seconds
  });
};

// Will be used for prompt management feature
// const useRapidReplyPrompts = (mappingId?: string) => {
//   return useQuery({
//     queryKey: ['rapid-reply-prompts', mappingId],
//     queryFn: async () => {
//       const url = mappingId
//         ? `/api/admin/rapid-reply/prompts?mappingId=${mappingId}`
//         : '/api/admin/rapid-reply/prompts';
//       const response = await fetch(url);
//       if (!response.ok) throw new Error('Failed to fetch prompts');
//       return response.json();
//     },
//     enabled: !!mappingId || mappingId === undefined,
//   });
// };

// Component for editing a mapping
const MappingEditModal: React.FC<{
  open: boolean;
  onClose: () => void;
  mapping?: IRapidReplyMapping;
  availableModels: ModelInfo[];
  metrics?: any;
  maxLatencyThreshold?: number;
}> = ({ open, onClose, mapping, availableModels, metrics, maxLatencyThreshold = 2000 }) => {
  const saveMapping = useSaveMapping();
  const [formData, setFormData] = useState<Partial<IRapidReplyMapping>>({
    mainModelId: '',
    rapidModelId: '',
    enabled: true,
    priority: 1,
    systemPrompt: defaultPrompt,
    maxTokens: 100,
    responseStyle: 'auto',
    maxLatency: 1500,
  });

  useEffect(() => {
    if (mapping) {
      setFormData(mapping);
    } else {
      setFormData({
        mainModelId: '',
        rapidModelId: '',
        enabled: true,
        priority: 1,
        systemPrompt: defaultPrompt,
        maxTokens: 100,
        responseStyle: 'auto',
        maxLatency: 1500,
      });
    }
  }, [mapping]);

  const handleSave = async () => {
    try {
      await saveMapping.mutateAsync(formData);
      onClose();
    } catch (error) {
      console.error('Failed to save mapping:', error);
    }
  };

  // Filter models to get fast/mini models
  const rapidModels = availableModels.filter(
    model =>
      model.name.toLowerCase().includes('mini') ||
      model.name.toLowerCase().includes('nano') ||
      model.name.toLowerCase().includes('haiku') ||
      model.name.toLowerCase().includes('flash') ||
      model.name.toLowerCase().includes('small') ||
      model.name.toLowerCase().includes('fast')
  );

  // Get model latency from metrics
  const getModelLatency = (modelId: string): number | null => {
    if (!metrics?.modelBreakdown) return null;
    const modelMetric = metrics.modelBreakdown.find((m: any) => m.rapidModel === modelId);
    return modelMetric?.avgLatency || null;
  };

  // Get latency-based performance indicator
  const getPerformanceChip = (modelId: string) => {
    const latency = getModelLatency(modelId);

    if (latency === null) {
      // Fallback when no metrics available
      return { color: 'neutral', label: 'No data' };
    }

    // Use actual latency data with threshold
    const isFast = latency <= maxLatencyThreshold;
    return {
      color: isFast ? 'success' : 'danger',
      label: `${latency}ms - ${isFast ? 'Fast' : 'Slow'}`,
    };
  };

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog size="lg" sx={{ maxWidth: '1200px', width: '1000px', minWidth: '800px' }}>
        <DialogTitle>
          <Stack direction="row" spacing={1} alignItems="center">
            <BoltIcon />
            <Typography>{mapping ? 'Edit Mapping' : 'Create New Mapping'}</Typography>
          </Stack>
        </DialogTitle>
        <DialogContent>
          <Stack spacing={3}>
            <Grid container spacing={2}>
              <Grid xs={12} md={6}>
                <FormControl required>
                  <FormLabel>Main Model</FormLabel>
                  <Select
                    value={formData.mainModelId}
                    onChange={(_, value) => setFormData({ ...formData, mainModelId: value as string })}
                    placeholder="Select main model"
                  >
                    {availableModels.map(model => (
                      <Option key={model.id} value={model.id}>
                        {model.name}
                      </Option>
                    ))}
                  </Select>
                </FormControl>
              </Grid>
              <Grid xs={12} md={6}>
                <FormControl required>
                  <FormLabel>Rapid Model</FormLabel>
                  <Select
                    value={formData.rapidModelId}
                    onChange={(_, value) => setFormData({ ...formData, rapidModelId: value as string })}
                    placeholder="Select rapid model"
                  >
                    {rapidModels.map(model => {
                      const perfChip = getPerformanceChip(model.id);

                      return (
                        <Option key={model.id} value={model.id}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography>{model.name}</Typography>

                            <Chip size="sm" color={perfChip.color as any} variant="soft">
                              {perfChip.label}
                            </Chip>
                          </Stack>
                        </Option>
                      );
                    })}
                  </Select>
                </FormControl>
              </Grid>
            </Grid>

            <FormControl>
              <FormLabel>System Prompt</FormLabel>
              <Textarea
                value={formData.systemPrompt}
                onChange={e => setFormData({ ...formData, systemPrompt: e.target.value })}
                minRows={3}
                maxRows={6}
                placeholder="Enter the system prompt for rapid replies..."
              />
            </FormControl>

            <Grid container spacing={2}>
              <Grid xs={12} md={4}>
                <FormControl>
                  <FormLabel>Max Tokens</FormLabel>
                  <Input
                    type="number"
                    value={formData.maxTokens}
                    onChange={e => setFormData({ ...formData, maxTokens: parseInt(e.target.value) })}
                    slotProps={{
                      input: {
                        min: 10,
                        max: 150,
                      },
                    }}
                  />
                  {/* Help text */}
                  <Typography level="body-xs" sx={{ pt: 0.5 }}>
                    Number of tokens for rapid reply. Minimum 10 and maximum 150.
                  </Typography>
                </FormControl>
              </Grid>
              <Grid xs={12} md={4}>
                <FormControl>
                  <FormLabel>Response Style</FormLabel>
                  <Select
                    value={formData.responseStyle}
                    onChange={(_, value) => setFormData({ ...formData, responseStyle: value as any })}
                  >
                    {Object.values(RapidReplyResponseStylesCommon).map(style => (
                      <Option key={style} value={style}>
                        {style}
                      </Option>
                    ))}
                  </Select>
                </FormControl>
              </Grid>
              <Grid xs={12} md={4}>
                <FormControl>
                  <FormLabel>Max Latency Before Timeout (ms)</FormLabel>
                  <Input
                    type="number"
                    value={formData.maxLatency}
                    onChange={e => setFormData({ ...formData, maxLatency: parseInt(e.target.value) })}
                    slotProps={{
                      input: {
                        min: 500,
                        max: 5000,
                      },
                    }}
                  />
                </FormControl>
                {/* Help text */}
                <Typography level="body-xs" sx={{ pt: 0.5 }}>
                  Maximum latency before stopping the rapid reply attempt. Minimum 500 and maximum 5000.
                </Typography>
              </Grid>
            </Grid>

            <Grid container spacing={2}>
              <Grid xs={12} md={4}>
                <FormControl>
                  <FormLabel>Fallback Priority</FormLabel>
                  <Input
                    type="number"
                    value={formData.priority}
                    onChange={e => setFormData({ ...formData, priority: parseInt(e.target.value) })}
                    slotProps={{
                      input: {
                        min: 1,
                        max: 100,
                      },
                    }}
                  />
                </FormControl>
              </Grid>
              <Grid xs={12} md={8}>
                <FormControl style={{ justifyContent: 'flex-start' }}>
                  <FormLabel>Status</FormLabel>
                  <Switch
                    checked={formData.enabled}
                    onChange={e => setFormData({ ...formData, enabled: e.target.checked })}
                    endDecorator={formData.enabled ? 'Enabled' : 'Disabled'}
                    color={formData.enabled ? 'success' : 'neutral'}
                    style={{ justifyContent: 'flex-start', width: '100%' }}
                  />
                </FormControl>
              </Grid>
            </Grid>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button variant="plain" color="neutral" onClick={onClose}>
            Cancel
          </Button>
          <Button startDecorator={<SaveIcon />} onClick={handleSave} loading={saveMapping.isPending}>
            Save Mapping
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
};

// Main component
const RapidReplyTab: React.FC = () => {
  const [activeTab, setActiveTab] = useState(0);
  const [editingMapping, setEditingMapping] = useState<IRapidReplyMapping | undefined>();
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [testModelId, setTestModelId] = useState<string>('');
  const [testInput, setTestInput] = useState<string>('Test message for rapid reply');
  const [testHistory, setTestHistory] = useState<any[]>([]);

  // Fetch data
  const { settings: adminSettings } = useAdminSettingsCache();
  const { data: experimentalSettings } = useExperimentalFeatureSettings();
  // use feature enabled with defaults
  const isFeatureEnabled =
    experimentalSettings?.find(s => s.settingName === 'EnableRapidReply')?.settingValue === 'true';
  const { data: modelInfos } = useModelInfo();
  const { data: mappings, isLoading: mappingsLoading } = useRapidReplyMappings();
  const { data: metrics } = useRapidReplyMetrics();
  // const { data: prompts } = useRapidReplyPrompts(); // Will be used for prompt management feature

  // Mutations
  const deleteMapping = useDeleteMapping();
  const testConfiguration = useTestConfiguration();
  const updateAdminSettings = useUpdateSettings();

  // Local state for rapid reply specific settings
  const [localSettings, setLocalSettings] = useState({
    transitionMode: 'replace' as const,
    fallbackBehavior: 'continue' as const,
    maxAcceptableLatency: 2000,
    minSuccessRate: 90,
  });
  const [originalSettings, setOriginalSettings] = useState(localSettings);

  // Local state for rapid reply enabled status (for immediate UI updates)
  const [localRapidReplyEnabled, setLocalRapidReplyEnabled] = useState(false);

  useEffect(() => {
    // Initialize settings from admin settings
    const rapidReplySettings = adminSettings.RapidReplySettings as any;
    const newSettings = {
      transitionMode: rapidReplySettings?.transitionMode || 'replace',
      fallbackBehavior: rapidReplySettings?.fallbackBehavior || 'continue',
      maxAcceptableLatency: rapidReplySettings?.maxAcceptableLatency || 2000,
      minSuccessRate: rapidReplySettings?.minSuccessRate || 90,
    };
    setLocalSettings(newSettings);
    setOriginalSettings(newSettings);

    // Initialize rapid reply enabled status
    setLocalRapidReplyEnabled(isFeatureEnabled);
  }, [adminSettings, isFeatureEnabled]);

  const handleCreateMapping = () => {
    setEditingMapping(undefined);
    setIsEditModalOpen(true);
  };

  const handleEditMapping = (mapping: IRapidReplyMapping) => {
    setEditingMapping(mapping);
    setIsEditModalOpen(true);
  };

  const handleDeleteMapping = async (id: string) => {
    if (confirm('Are you sure you want to delete this mapping?')) {
      try {
        await deleteMapping.mutateAsync(id);
      } catch (error) {
        console.error('Failed to delete mapping:', error);
      }
    }
  };

  // Check if settings have changed
  const hasSettingsChanged = () => {
    return JSON.stringify(originalSettings) !== JSON.stringify(localSettings);
  };

  const handleSaveSettings = async () => {
    try {
      // Create a clean RapidReplySettings object with only the fields we need
      const cleanRapidReplySettings = {
        transitionMode: localSettings.transitionMode,
        fallbackBehavior: localSettings.fallbackBehavior,
        maxAcceptableLatency: localSettings.maxAcceptableLatency,
        minSuccessRate: localSettings.minSuccessRate,
      };

      // Omit 'enabled' here - it's controlled by the EnableRapidReply setting
      await updateAdminSettings.mutateAsync({
        key: 'RapidReplySettings',
        value: cleanRapidReplySettings as any,
      });
      setOriginalSettings(localSettings); // Update original settings after successful save
    } catch (error) {
      console.error('Failed to save settings:', error);
    }
  };

  const handleToggleRapidReply = async (enabled: boolean) => {
    // Update local state immediately for responsive UI
    setLocalRapidReplyEnabled(enabled);

    try {
      // Update the main EnableRapidReply setting
      await updateAdminSettings.mutateAsync({
        key: 'EnableRapidReply',
        value: enabled,
      });

      // Create a clean RapidReplySettings object with only the fields we need
      const cleanRapidReplySettings = {
        transitionMode: localSettings.transitionMode,
        fallbackBehavior: localSettings.fallbackBehavior,
        maxAcceptableLatency: localSettings.maxAcceptableLatency,
        minSuccessRate: localSettings.minSuccessRate,
      };

      // Update RapidReplySettings with clean data
      await updateAdminSettings.mutateAsync({
        key: 'RapidReplySettings',
        value: cleanRapidReplySettings as any,
      });

      console.log(`✅ Successfully updated Rapid Reply to ${enabled}`);
    } catch (error) {
      console.error('Failed to update Rapid Reply setting:', error);
      // Revert local state on error
      setLocalRapidReplyEnabled(!enabled);
    }
  };

  const handleTestConfiguration = async () => {
    if (!testModelId) {
      alert('Please select a model to test');
      return;
    }

    try {
      const result = await testConfiguration.mutateAsync({
        mainModelId: testModelId,
        testInput,
      });
      console.log('Test result:', result);

      // Add to test history
      const historyEntry = {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        modelId: testModelId,
        testInput,
        result: result,
        success: result.success,
      };
      setTestHistory(prev => [historyEntry, ...prev.slice(0, 9)]); // Keep last 10 tests
    } catch (error) {
      console.error('Test failed:', error);
    }
  };

  // Use local state for immediate UI updates, fallback to server state
  const isRapidReplyEnabled = localRapidReplyEnabled;

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          justifyContent="space-between"
        >
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ xs: 'flex-start', sm: 'center' }}>
            <Stack direction="row" spacing={2} alignItems="center">
              <BoltIcon sx={{ fontSize: 28, color: 'primary.500' }} />
              <Typography level="h2">Rapid Reply Configuration</Typography>
              <ContextHelpButton helpId="admin/rapid-reply" tooltipText="Rapid Reply Help" />
            </Stack>
            {isRapidReplyEnabled && (
              <Chip color="success" variant="soft" size="sm">
                Active
              </Chip>
            )}
          </Stack>
          <Button
            variant="outlined"
            startDecorator={<RefreshIcon />}
            onClick={() => window.location.reload()}
            sx={{ width: { xs: '100%', sm: 'auto' } }}
          >
            Refresh
          </Button>
        </Stack>
      </Box>

      {/* Content */}
      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        <Tabs value={activeTab} onChange={(_, value) => setActiveTab(value as number)}>
          <TabList sx={{ overflowX: 'auto' }}>
            <Tab>
              <Stack direction="row" spacing={2} alignItems="center">
                <PsychologyIcon />
                <Typography sx={{ display: { xs: 'none', sm: 'block' } }}>Models</Typography>
                {mappings?.mappings?.length > 0 && (
                  <Badge badgeContent={mappings.mappings.length} color="primary" size="sm" />
                )}
              </Stack>
            </Tab>
            <Tab>
              <Stack direction="row" spacing={1} alignItems="center">
                <SpeedIcon />
                <Typography sx={{ display: { xs: 'none', sm: 'block' } }}>Metrics</Typography>
              </Stack>
            </Tab>
            <Tab>
              <Stack direction="row" spacing={1} alignItems="center">
                <PlayArrowIcon />
                <Typography sx={{ display: { xs: 'none', sm: 'block' } }}>Test</Typography>
              </Stack>
            </Tab>
          </TabList>

          {/* Models Tab */}
          <TabPanel value={0} sx={{ p: 2 }}>
            <Grid container spacing={3}>
              {/* General Settings Section */}
              <Grid xs={12}>
                <Card>
                  <CardContent>
                    <Typography level="title-lg">General Settings</Typography>

                    <Stack
                      spacing={3}
                      direction={{ xs: 'column', md: 'row' }}
                      sx={{ alignItems: { xs: 'stretch', md: 'flex-end' } }}
                    >
                      <FormControl sx={{ flex: { xs: '1', md: '0 1 auto' } }}>
                        <FormLabel>Feature Status</FormLabel>
                        <Switch
                          checked={isRapidReplyEnabled}
                          onChange={e => handleToggleRapidReply(e.target.checked)}
                          endDecorator={isRapidReplyEnabled ? 'Enabled' : 'Disabled'}
                          color={isRapidReplyEnabled ? 'success' : 'neutral'}
                          disabled={updateAdminSettings.isPending}
                          sx={{ alignSelf: 'flex-start' }}
                        />
                      </FormControl>

                      <FormControl sx={{ flex: { xs: '1', md: '1' } }}>
                        <FormLabel>Transition Mode</FormLabel>
                        <Select
                          value={localSettings.transitionMode || 'replace'}
                          onChange={(_, value) => setLocalSettings({ ...localSettings, transitionMode: value as any })}
                        >
                          {RapidReplyTransitionModes.map(mode => (
                            <Option key={mode} value={mode} disabled={mode === 'enhance'}>
                              {mode}
                            </Option>
                          ))}
                        </Select>
                      </FormControl>

                      <FormControl sx={{ flex: { xs: '1', md: '1' } }}>
                        <FormLabel>Fallback Behavior</FormLabel>
                        <Select
                          value={localSettings.fallbackBehavior || 'continue'}
                          onChange={(_, value) =>
                            setLocalSettings({ ...localSettings, fallbackBehavior: value as any })
                          }
                          disabled
                        >
                          {RapidReplyFallbackBehaviors.map(behavior => (
                            <Option key={behavior} value={behavior}>
                              {behavior}
                            </Option>
                          ))}
                        </Select>
                      </FormControl>

                      <Button
                        variant="solid"
                        startDecorator={<SaveIcon />}
                        onClick={handleSaveSettings}
                        loading={updateAdminSettings.isPending}
                        disabled={!hasSettingsChanged() || updateAdminSettings.isPending}
                        sx={{ width: { xs: '100%', md: 'auto' } }}
                      >
                        Save Settings
                      </Button>
                    </Stack>
                  </CardContent>
                </Card>
              </Grid>

              {/* Model Mappings Section */}
              <Grid xs={12}>
                <Card>
                  <CardContent>
                    <Stack spacing={2}>
                      <Stack
                        direction={{ xs: 'column', sm: 'row' }}
                        justifyContent="space-between"
                        alignItems={{ xs: 'stretch', sm: 'center' }}
                        spacing={2}
                      >
                        <Typography level="title-lg">Model Mappings</Typography>
                        <Button
                          variant="solid"
                          startDecorator={<AddIcon />}
                          onClick={handleCreateMapping}
                          size="sm"
                          sx={{ width: { xs: '100%', sm: 'auto' } }}
                        >
                          New Mapping
                        </Button>
                      </Stack>

                      {mappingsLoading ? (
                        <LinearProgress />
                      ) : mappings?.mappings?.length === 0 ? (
                        <Alert color="neutral">
                          <Stack spacing={2} alignItems="center" sx={{ py: 2 }}>
                            <Typography level="body-md" color="neutral">
                              No model mappings configured yet
                            </Typography>
                            <Button
                              variant="solid"
                              startDecorator={<AddIcon />}
                              onClick={handleCreateMapping}
                              size="sm"
                            >
                              Create First Mapping
                            </Button>
                          </Stack>
                        </Alert>
                      ) : (
                        <Sheet
                          variant="outlined"
                          sx={{
                            borderRadius: 'sm',
                            overflow: 'auto',
                            maxHeight: '400px',
                            overflowX: { xs: 'auto', sm: 'visible' },
                          }}
                        >
                          <Table hoverRow size="sm" sx={{ minWidth: { xs: '800px', sm: 'auto' } }}>
                            <thead>
                              <tr>
                                <th>Main Model</th>
                                <th>Rapid Model</th>
                                <th style={{ width: '7.5%' }}>Fallback Priority</th>
                                <th style={{ width: '7.5%' }}>Max Tokens</th>
                                <th style={{ width: '10%' }}>Response Style</th>
                                <th>Max Latency Before Timeout (ms)</th>
                                <th style={{ width: '7.5%' }}>Status</th>
                                <th style={{ width: '7.5%' }}>Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {mappings?.mappings?.map((mapping: IRapidReplyMapping) => (
                                <tr key={mapping.id}>
                                  <td>
                                    <Stack spacing={0.5}>
                                      <Typography level="body-sm" fontWeight="md">
                                        {mapping.mainModelId}
                                      </Typography>
                                    </Stack>
                                  </td>
                                  <td>
                                    <Typography level="body-sm" fontWeight="md">
                                      {mapping.rapidModelId}
                                    </Typography>
                                  </td>
                                  <td>
                                    <Typography level="body-sm" fontWeight="md">
                                      {mapping.priority || ''}
                                    </Typography>
                                  </td>
                                  <td>
                                    <Typography level="body-sm" fontWeight="md">
                                      {mapping.maxTokens}
                                    </Typography>
                                  </td>
                                  <td>
                                    <Typography level="body-sm" fontWeight="md">
                                      {mapping.responseStyle}
                                    </Typography>
                                  </td>
                                  <td>
                                    <Typography level="body-sm" fontWeight="md">
                                      {mapping.maxLatency}
                                    </Typography>
                                  </td>
                                  <td>
                                    <Chip size="sm" color={mapping.enabled ? 'success' : 'neutral'} variant="soft">
                                      {mapping.enabled ? 'Active' : 'Disabled'}
                                    </Chip>
                                  </td>
                                  <td>
                                    <Stack direction="row" spacing={0.5}>
                                      <IconButton size="sm" variant="plain" onClick={() => handleEditMapping(mapping)}>
                                        <EditIcon />
                                      </IconButton>
                                      <IconButton
                                        size="sm"
                                        variant="plain"
                                        color="danger"
                                        onClick={() => handleDeleteMapping(mapping.id)}
                                      >
                                        <DeleteIcon />
                                      </IconButton>
                                    </Stack>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </Table>
                        </Sheet>
                      )}
                    </Stack>
                  </CardContent>
                </Card>
              </Grid>
            </Grid>
          </TabPanel>

          {/* Metrics Tab */}
          <TabPanel value={1} sx={{ p: 2 }} data-testid="metrics-tab-panel">
            <Stack spacing={3}>
              {/* Performance Settings Section */}
              <Card>
                <CardContent>
                  <Grid container spacing={3}>
                    <Grid xs={12} md={8}>
                      <Stack spacing={2}>
                        <Typography level="title-lg">Performance Thresholds</Typography>
                        <Grid container spacing={2}>
                          <Grid xs={12} sm={6}>
                            <FormControl>
                              <FormLabel>Max Acceptable Latency (ms)</FormLabel>
                              <Input
                                type="number"
                                value={localSettings.maxAcceptableLatency ?? ''}
                                onChange={e => {
                                  const value = e.target.value === '' ? 2000 : parseInt(e.target.value);
                                  setLocalSettings({ ...localSettings, maxAcceptableLatency: value });
                                }}
                                slotProps={{
                                  input: {
                                    min: 500,
                                    max: 5000,
                                  },
                                }}
                              />
                            </FormControl>
                          </Grid>
                          <Grid xs={12} sm={6}>
                            <FormControl>
                              <FormLabel>Min Success Rate (%)</FormLabel>
                              <Input
                                type="number"
                                value={localSettings.minSuccessRate ?? ''}
                                onChange={e => {
                                  const value = e.target.value === '' ? 90 : parseInt(e.target.value);
                                  setLocalSettings({ ...localSettings, minSuccessRate: value });
                                }}
                                slotProps={{
                                  input: {
                                    min: 0,
                                    max: 100,
                                  },
                                }}
                              />
                            </FormControl>
                          </Grid>
                        </Grid>
                      </Stack>
                    </Grid>
                    <Grid xs={12} md={4}>
                      <Stack spacing={2} sx={{ height: '100%', justifyContent: 'center' }}>
                        <Button
                          variant="solid"
                          startDecorator={<SaveIcon />}
                          onClick={handleSaveSettings}
                          loading={updateAdminSettings.isPending}
                          disabled={!hasSettingsChanged() || updateAdminSettings.isPending}
                          size="lg"
                        >
                          Save Thresholds
                        </Button>
                      </Stack>
                    </Grid>
                  </Grid>
                </CardContent>
              </Card>

              {/* Metrics Component */}
              <RapidReplyMetrics
                metrics={metrics}
                thresholds={{
                  maxLatency: localSettings.maxAcceptableLatency ?? 2000,
                  minSuccessRate: localSettings.minSuccessRate ?? 90,
                }}
              />
            </Stack>
          </TabPanel>

          {/* Test Tab */}
          <TabPanel value={2} sx={{ p: 2 }}>
            <Grid container spacing={3}>
              <Grid xs={12} md={6}>
                <Card>
                  <CardContent>
                    <Stack spacing={3}>
                      <Typography level="title-lg">Test Configuration</Typography>

                      <FormControl>
                        <FormLabel>Select Model to Test</FormLabel>
                        <Select
                          value={testModelId}
                          onChange={(_, value) => setTestModelId(value as string)}
                          placeholder="Choose a main model"
                        >
                          {modelInfos?.map((model: ModelInfo) => (
                            <Option key={model.id} value={model.id}>
                              {model.name}
                            </Option>
                          ))}
                        </Select>
                      </FormControl>

                      <FormControl>
                        <FormLabel>Test Input</FormLabel>
                        <Textarea
                          value={testInput}
                          onChange={e => setTestInput(e.target.value)}
                          minRows={3}
                          placeholder="Enter a test message..."
                        />
                        <Typography level="body-xs" sx={{ pt: 0.5 }}>
                          This message will be sent to the rapid reply system to test the configuration.
                        </Typography>
                      </FormControl>

                      <FormControl>
                        <FormLabel>Quick Test Messages</FormLabel>
                        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                          {[
                            'Hello, how are you?',
                            'Explain photosynthesis in simple terms',
                            'Write a short poem about technology',
                            'What is the capital of France?',
                            'Help me debug this code: function test() { return "hello"; }',
                          ].map((message, index) => (
                            <Button
                              key={index}
                              size="sm"
                              variant="outlined"
                              onClick={() => setTestInput(message)}
                              sx={{ mb: 1 }}
                            >
                              {message.substring(0, 30)}...
                            </Button>
                          ))}
                        </Stack>
                      </FormControl>

                      <Stack direction="row" spacing={2}>
                        <Button
                          variant="solid"
                          startDecorator={<PlayArrowIcon />}
                          onClick={handleTestConfiguration}
                          loading={testConfiguration.isPending}
                          disabled={!testModelId}
                          sx={{ flex: 1 }}
                        >
                          Run Test
                        </Button>
                        {testHistory.length > 0 && (
                          <Button variant="outlined" color="neutral" onClick={() => setTestHistory([])} size="sm">
                            Clear History
                          </Button>
                        )}
                      </Stack>
                    </Stack>
                  </CardContent>
                </Card>
              </Grid>

              <Grid xs={12} md={6}>
                {/* Test History */}
                {testHistory.length > 0 && (
                  <Card sx={{ mb: 3 }}>
                    <CardContent>
                      <Stack spacing={2}>
                        <Typography level="title-lg">Recent Tests</Typography>
                        <Stack spacing={1}>
                          {testHistory.slice(0, 3).map(entry => (
                            <Sheet
                              key={entry.id}
                              variant="outlined"
                              sx={{
                                p: 2,
                                borderRadius: 'sm',
                                cursor: 'pointer',
                                '&:hover': { backgroundColor: 'background.level1' },
                              }}
                              onClick={() => {
                                setTestModelId(entry.modelId);
                                setTestInput(entry.testInput);
                              }}
                            >
                              <Stack direction="row" justifyContent="space-between" alignItems="center">
                                <Stack spacing={0.5}>
                                  <Typography level="body-sm">
                                    <strong>{entry.modelId}</strong>
                                  </Typography>
                                  <Typography level="body-xs" sx={{ opacity: 0.7 }}>
                                    {new Date(entry.timestamp).toLocaleString()}
                                  </Typography>
                                  <Typography level="body-xs" sx={{ opacity: 0.8 }}>
                                    {entry.testInput.substring(0, 50)}...
                                  </Typography>
                                </Stack>
                                <Chip size="sm" color={entry.success ? 'success' : 'danger'}>
                                  {entry.success ? 'SUCCESS' : 'FAILED'}
                                </Chip>
                              </Stack>
                            </Sheet>
                          ))}
                        </Stack>
                      </Stack>
                    </CardContent>
                  </Card>
                )}

                {testConfiguration.data && (
                  <Card>
                    <CardContent>
                      <Stack spacing={2}>
                        <Typography level="title-lg">Test Results</Typography>

                        {testConfiguration.data.success ? (
                          <Alert color="success" startDecorator={<CheckCircleIcon />}>
                            <Typography>{testConfiguration.data.message}</Typography>
                          </Alert>
                        ) : (
                          <Alert color="warning" startDecorator={<WarningIcon />}>
                            <Typography>{testConfiguration.data.message || testConfiguration.data.error}</Typography>
                          </Alert>
                        )}

                        {/* Quick Summary */}
                        {testConfiguration.data.testResults && (
                          <Sheet variant="soft" sx={{ p: 2, borderRadius: 'sm' }}>
                            <Stack direction="row" spacing={2} justifyContent="space-around" sx={{ flexWrap: 'wrap' }}>
                              <Stack alignItems="center">
                                <Typography level="title-sm">Rapid Reply</Typography>
                                <Typography
                                  level="h4"
                                  color={
                                    testConfiguration.data.testResults.performance?.latencyCheck?.passed
                                      ? 'success'
                                      : 'danger'
                                  }
                                >
                                  {testConfiguration.data.testResults.performance?.latency}ms
                                </Typography>
                              </Stack>
                              <Stack alignItems="center">
                                <Typography level="title-sm">TTFVT</Typography>
                                <Typography
                                  level="h4"
                                  color={
                                    (testConfiguration.data.testResults.performance?.ttfvt || 0) <= 1000
                                      ? 'success'
                                      : 'warning'
                                  }
                                >
                                  {testConfiguration.data.testResults.performance?.ttfvt || 0}ms
                                </Typography>
                              </Stack>

                              <Stack alignItems="center">
                                <Typography level="title-sm">Response</Typography>
                                <Typography
                                  level="h4"
                                  color={
                                    testConfiguration.data.testResults.rapidReplyTest?.success ? 'success' : 'danger'
                                  }
                                >
                                  {testConfiguration.data.testResults.rapidReplyTest?.responseLength || 0}
                                </Typography>
                                <Typography level="body-xs">chars</Typography>
                              </Stack>
                            </Stack>
                          </Sheet>
                        )}

                        {testConfiguration.data.testResults && (
                          <Stack spacing={3}>
                            <Divider />

                            {/* Configuration Section */}
                            <Stack spacing={2}>
                              <Typography level="title-md">Configuration</Typography>
                              <Sheet variant="soft" sx={{ p: 2, borderRadius: 'sm' }}>
                                <Stack spacing={1}>
                                  <Typography level="body-sm">
                                    <strong>Main Model:</strong>{' '}
                                    {testConfiguration.data.testResults.configuration?.mainModel}
                                  </Typography>
                                  <Typography level="body-sm">
                                    <strong>Rapid Model:</strong>{' '}
                                    {testConfiguration.data.testResults.configuration?.rapidModel}
                                  </Typography>
                                  <Typography level="body-sm">
                                    <strong>Max Tokens:</strong>{' '}
                                    {testConfiguration.data.testResults.configuration?.maxTokens}
                                  </Typography>
                                  <Typography level="body-sm">
                                    <strong>Response Style:</strong>{' '}
                                    {testConfiguration.data.testResults.configuration?.responseStyle}
                                  </Typography>
                                  <Typography level="body-sm">
                                    <strong>Max Latency:</strong>{' '}
                                    {testConfiguration.data.testResults.configuration?.maxLatency}ms
                                  </Typography>
                                  <Typography level="body-sm">
                                    <strong>System Prompt:</strong>{' '}
                                    {testConfiguration.data.testResults.configuration?.systemPrompt}
                                  </Typography>
                                </Stack>
                              </Sheet>
                            </Stack>

                            {/* Performance Section */}
                            {testConfiguration.data.testResults.performance && (
                              <Stack spacing={2}>
                                <Typography level="title-md">Performance</Typography>
                                <Sheet variant="soft" sx={{ p: 2, borderRadius: 'sm' }}>
                                  <Stack spacing={1}>
                                    <Typography level="body-sm">
                                      <strong>Total Latency:</strong>{' '}
                                      {testConfiguration.data.testResults.performance.actualLatency}ms
                                    </Typography>
                                    <Typography level="body-sm">
                                      <strong>Rapid Reply Latency:</strong>{' '}
                                      {testConfiguration.data.testResults.performance.rapidReplyLatency}ms
                                    </Typography>
                                    <Typography level="body-sm">
                                      <strong>TTFVT (Time to First Visible Token):</strong>{' '}
                                      {testConfiguration.data.testResults.performance.rapidReplyTtfvt}ms
                                    </Typography>
                                    <Typography level="body-sm">
                                      <strong>Max Configured Latency:</strong>{' '}
                                      {testConfiguration.data.testResults.performance.maxConfiguredLatency}ms
                                    </Typography>
                                    <Typography level="body-sm">
                                      <strong>Total Latency Check:</strong>
                                      <Chip
                                        size="sm"
                                        color={
                                          testConfiguration.data.testResults.performance.latencyCheck.passed
                                            ? 'success'
                                            : 'danger'
                                        }
                                        sx={{ ml: 1 }}
                                      >
                                        {testConfiguration.data.testResults.performance.latencyCheck.passed
                                          ? 'PASSED'
                                          : 'FAILED'}
                                      </Chip>
                                    </Typography>
                                    <Typography level="body-sm">
                                      {testConfiguration.data.testResults.performance.latencyCheck.message}
                                    </Typography>
                                    <Typography level="body-sm">
                                      <strong>Rapid Reply Latency Check:</strong>
                                      <Chip
                                        size="sm"
                                        color={
                                          testConfiguration.data.testResults.performance.latencyCheck.passed
                                            ? 'success'
                                            : 'danger'
                                        }
                                        sx={{ ml: 1 }}
                                      >
                                        {testConfiguration.data.testResults.performance.latencyCheck.passed
                                          ? 'PASSED'
                                          : 'FAILED'}
                                      </Chip>
                                    </Typography>
                                    <Typography level="body-sm">
                                      {testConfiguration.data.testResults.performance.latencyCheck.message}
                                    </Typography>
                                    <Typography level="body-sm">
                                      <strong>Tokens Used:</strong>{' '}
                                      {testConfiguration.data.testResults.performance.tokensUsed}
                                    </Typography>
                                    <Typography level="body-sm">
                                      <strong>Estimated Cost:</strong> $
                                      {testConfiguration.data.testResults.performance.estimatedCost?.toFixed(4) ||
                                        '0.0000'}
                                    </Typography>
                                    {testConfiguration.data.testResults.performance.timing && (
                                      <>
                                        <Divider />
                                        <Typography level="body-sm">
                                          <strong>Timing Breakdown:</strong>
                                        </Typography>
                                        <Typography level="body-xs">
                                          Test Start:{' '}
                                          {new Date(
                                            testConfiguration.data.testResults.performance.timing.testStartTime
                                          ).toLocaleTimeString()}
                                        </Typography>
                                        <Typography level="body-xs">
                                          Rapid Reply Start:{' '}
                                          {new Date(
                                            testConfiguration.data.testResults.performance.timing.rapidReplyStartTime
                                          ).toLocaleTimeString()}
                                        </Typography>
                                        <Typography level="body-xs">
                                          Rapid Reply End:{' '}
                                          {new Date(
                                            testConfiguration.data.testResults.performance.timing.rapidReplyEndTime
                                          ).toLocaleTimeString()}
                                        </Typography>
                                        <Typography level="body-xs">
                                          Test End:{' '}
                                          {new Date(
                                            testConfiguration.data.testResults.performance.timing.testEndTime
                                          ).toLocaleTimeString()}
                                        </Typography>
                                      </>
                                    )}
                                  </Stack>
                                </Sheet>
                              </Stack>
                            )}

                            {/* Rapid Reply Test Results */}
                            {testConfiguration.data.testResults.rapidReplyTest && (
                              <Stack spacing={2}>
                                <Typography level="title-md">Rapid Reply Response</Typography>
                                <Sheet variant="soft" sx={{ p: 2, borderRadius: 'sm' }}>
                                  <Stack spacing={1}>
                                    <Typography level="body-sm">
                                      <strong>Test Input:</strong>{' '}
                                      {testConfiguration.data.testResults.rapidReplyTest.testInput}
                                    </Typography>
                                    <Typography level="body-sm">
                                      <strong>Response Length:</strong>{' '}
                                      {testConfiguration.data.testResults.rapidReplyTest.responseLength} characters
                                    </Typography>
                                    <Typography level="body-sm">
                                      <strong>Word Count:</strong>{' '}
                                      {testConfiguration.data.testResults.rapidReplyTest.responseWordCount} words
                                    </Typography>
                                    {testConfiguration.data.testResults.rapidReplyTest.response && (
                                      <>
                                        <Typography level="body-sm">
                                          <strong>Response:</strong>
                                        </Typography>
                                        <Sheet
                                          variant="outlined"
                                          sx={{
                                            p: 2,
                                            borderRadius: 'sm',
                                            backgroundColor: 'background.level1',
                                            maxHeight: '200px',
                                            overflow: 'auto',
                                          }}
                                        >
                                          <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap' }}>
                                            {testConfiguration.data.testResults.rapidReplyTest.response}
                                          </Typography>
                                        </Sheet>
                                      </>
                                    )}
                                    {testConfiguration.data.testResults.rapidReplyTest.error && (
                                      <Alert color="danger" size="sm">
                                        <Typography level="body-sm">
                                          <strong>Error:</strong>{' '}
                                          {testConfiguration.data.testResults.rapidReplyTest.error}
                                        </Typography>
                                      </Alert>
                                    )}
                                  </Stack>
                                </Sheet>
                              </Stack>
                            )}

                            {/* Settings Section */}
                            {testConfiguration.data.testResults.settings && (
                              <Stack spacing={2}>
                                <Typography level="title-md">Current Settings</Typography>
                                <Sheet variant="soft" sx={{ p: 2, borderRadius: 'sm' }}>
                                  <Stack spacing={1}>
                                    <Typography level="body-sm">
                                      <strong>Global Enabled:</strong>
                                      <Chip
                                        size="sm"
                                        color={
                                          testConfiguration.data.testResults.settings.globalEnabled
                                            ? 'success'
                                            : 'neutral'
                                        }
                                        sx={{ ml: 1 }}
                                      >
                                        {testConfiguration.data.testResults.settings.globalEnabled ? 'YES' : 'NO'}
                                      </Chip>
                                    </Typography>
                                    <Typography level="body-sm">
                                      <strong>Transition Mode:</strong>{' '}
                                      {testConfiguration.data.testResults.settings.transitionMode}
                                    </Typography>
                                    <Typography level="body-sm">
                                      <strong>Show Indicator:</strong>
                                      <Chip
                                        size="sm"
                                        color={
                                          testConfiguration.data.testResults.settings.showIndicator
                                            ? 'success'
                                            : 'neutral'
                                        }
                                        sx={{ ml: 1 }}
                                      >
                                        {testConfiguration.data.testResults.settings.showIndicator ? 'YES' : 'NO'}
                                      </Chip>
                                    </Typography>
                                    <Typography level="body-sm">
                                      <strong>Fallback Behavior:</strong>{' '}
                                      {testConfiguration.data.testResults.settings.fallbackBehavior}
                                    </Typography>
                                    <Typography level="body-sm">
                                      <strong>Allowed User Tags:</strong>{' '}
                                      {testConfiguration.data.testResults.settings.allowedUserTags?.join(', ') ||
                                        'None'}
                                    </Typography>
                                  </Stack>
                                </Sheet>
                              </Stack>
                            )}

                            {/* Prompts Section */}
                            {testConfiguration.data.testResults.prompts && (
                              <Stack spacing={2}>
                                <Typography level="title-md">Applicable Prompts</Typography>
                                <Sheet variant="soft" sx={{ p: 2, borderRadius: 'sm' }}>
                                  <Stack spacing={1}>
                                    <Typography level="body-sm">
                                      <strong>Total Prompts:</strong> {testConfiguration.data.testResults.prompts.total}
                                    </Typography>
                                    <Typography level="body-sm">
                                      <strong>Active Prompts:</strong>{' '}
                                      {testConfiguration.data.testResults.prompts.active}
                                    </Typography>
                                    {testConfiguration.data.testResults.prompts.applicable?.length > 0 && (
                                      <>
                                        <Typography level="body-sm">
                                          <strong>Applicable Prompts:</strong>
                                        </Typography>
                                        <Stack spacing={1}>
                                          {testConfiguration.data.testResults.prompts.applicable.map(
                                            (prompt: any, index: number) => (
                                              <Sheet key={index} variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
                                                <Typography level="body-sm">
                                                  <strong>{prompt.name}</strong> (ID: {prompt.id})
                                                </Typography>
                                                <Typography level="body-sm">
                                                  Domains: {prompt.domains?.join(', ') || 'None'}
                                                </Typography>
                                              </Sheet>
                                            )
                                          )}
                                        </Stack>
                                      </>
                                    )}
                                  </Stack>
                                </Sheet>
                              </Stack>
                            )}

                            {/* Recommendations Section */}
                            {testConfiguration.data.recommendations &&
                              testConfiguration.data.recommendations.length > 0 && (
                                <Stack spacing={2}>
                                  <Typography level="title-md">Recommendations</Typography>
                                  <Stack spacing={1}>
                                    {testConfiguration.data.recommendations.map((rec: string, index: number) => (
                                      <Alert key={index} color="neutral" size="sm">
                                        <Typography level="body-sm">{rec}</Typography>
                                      </Alert>
                                    ))}
                                  </Stack>
                                </Stack>
                              )}
                          </Stack>
                        )}
                      </Stack>
                    </CardContent>
                  </Card>
                )}
              </Grid>
            </Grid>
          </TabPanel>
        </Tabs>
      </Box>

      {/* Edit Modal */}
      {isEditModalOpen && modelInfos && (
        <MappingEditModal
          open={isEditModalOpen}
          onClose={() => setIsEditModalOpen(false)}
          mapping={editingMapping}
          availableModels={modelInfos}
          metrics={metrics}
          maxLatencyThreshold={localSettings.maxAcceptableLatency ?? 2000}
        />
      )}
    </Box>
  );
};

export default RapidReplyTab;
