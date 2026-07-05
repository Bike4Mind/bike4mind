import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  Box,
  Typography,
  Alert,
  Stack,
  CircularProgress,
  Snackbar,
  Card,
  Table,
  Sheet,
  Chip,
  Input,
  Button,
  Tabs,
  TabList,
  Tab,
  TabPanel,
} from '@mui/joy';
import SaveIcon from '@mui/icons-material/Save';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { getModels } from '@client/app/utils/llm';
import { ModelInfo } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { NotificationState, ModelCostOverride } from '../types';
import { PriceTierTag } from './PriceTierTag';
import { calculateModelCost } from '../utils/modelCostCalculations';

export const ModelCostSettings: React.FC = () => {
  const [selectedModelType, setSelectedModelType] = useState<string>('text');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);
  const [modelCostOverrides, setModelCostOverrides] = useState<Record<string, ModelCostOverride>>({});
  const [savedModelCosts, setSavedModelCosts] = useState<Record<string, ModelCostOverride>>({});
  const [notification, setNotification] = useState<NotificationState>({
    open: false,
    message: '',
    color: 'neutral',
  });
  const [isSaving, setIsSaving] = useState(false);
  const isMobile = useIsMobile();

  // Fetch any custom pricing from AdminSettings
  const fetchCustomPricing = useCallback(async (baseModels: ModelInfo[]) => {
    try {
      const response = await api.get('/api/settings');

      if (response.data && Array.isArray(response.data)) {
        const customPricingOverrides: Record<string, ModelCostOverride> = {};

        response.data.forEach((setting: { settingName?: string; settingValue?: string }) => {
          if (setting.settingName && setting.settingName.startsWith('modelPricing_')) {
            const modelId = setting.settingName.replace('modelPricing_', '');
            try {
              const overrideData = JSON.parse(setting.settingValue ?? '');
              customPricingOverrides[modelId] = overrideData;
            } catch (error) {
              console.error('Error parsing pricing data for model %s:', modelId, error);
            }
          }
        });

        setSavedModelCosts(customPricingOverrides);
      }
    } catch (error) {
      console.error('Error fetching custom pricing from admin settings:', error);
    }
  }, []);

  useEffect(() => {
    const fetchModels = async () => {
      setIsLoadingModels(true);
      setModelLoadError(null);
      try {
        const modelsData = await getModels();
        setModels(modelsData);
        await fetchCustomPricing(modelsData);
      } catch (error) {
        console.error('Failed to fetch models:', error);
        setModelLoadError('Failed to load model pricing information');
      } finally {
        setIsLoadingModels(false);
      }
    };

    fetchModels();
  }, [fetchCustomPricing]);

  // Group models by type
  const { textModels, imageModels } = useMemo(() => {
    const text: ModelInfo[] = [];
    const image: ModelInfo[] = [];

    models.forEach(model => {
      if (model.type === 'text') {
        text.push(model);
      } else if (model.type === 'image') {
        image.push(model);
      }
    });

    return {
      textModels: text,
      imageModels: image,
    };
  }, [models]);

  // Get current or override cost for a model
  const getCurrentModelCost = (model: ModelInfo): { inputCost: number; outputCost: number } => {
    // Check if we have a current override for this model (user changes)
    if (modelCostOverrides[model.id]) {
      return modelCostOverrides[model.id];
    }

    // Check if we have saved custom costs for this model
    if (savedModelCosts[model.id]) {
      return savedModelCosts[model.id];
    }

    // Fall back to the calculated cost
    return calculateModelCost(model);
  };

  const updateModelCost = (modelId: string, field: 'inputCost' | 'outputCost', value: string) => {
    const numValue = parseFloat(value);
    if (isNaN(numValue)) return;
    setModelCostOverrides(prev => {
      const model = models.find(m => m.id === modelId);
      // Get the baseline cost (saved or calculated)
      const baselineCost = savedModelCosts[modelId] || calculateModelCost(model!);

      return {
        ...prev,
        [modelId]: {
          inputCost: field === 'inputCost' ? numValue : (prev[modelId]?.inputCost ?? baselineCost.inputCost),
          outputCost: field === 'outputCost' ? numValue : (prev[modelId]?.outputCost ?? baselineCost.outputCost),
        },
      };
    });
  };

  const hasUnsavedChanges = Object.keys(modelCostOverrides).length > 0;

  // Save model cost overrides using AdminSettings pattern
  const handleSave = async () => {
    setIsSaving(true);
    try {
      const savePromises = [];

      for (const [modelId, overrides] of Object.entries(modelCostOverrides)) {
        const settingName = `modelPricing_${modelId}`;
        savePromises.push(
          api.put('/api/settings/model-pricing', {
            key: settingName,
            value: JSON.stringify(overrides),
          })
        );
      }
      await Promise.all(savePromises);
      setNotification({
        open: true,
        message: 'Model pricing settings saved successfully!',
        color: 'success',
      });

      setSavedModelCosts(prev => ({
        ...prev,
        ...modelCostOverrides,
      }));

      setModelCostOverrides({});
    } catch (error) {
      console.error('Error saving model pricing settings:', error);
      setNotification({
        open: true,
        message: `Error saving settings: ${(error as Error)?.message || 'Unknown error'}`,
        color: 'danger',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setModelCostOverrides({});
    setNotification({
      open: true,
      message: 'Changes reverted to previous values',
      color: 'neutral',
    });
  };

  // Revert all models back to default calculated costs
  const handleRevertToDefaults = () => {
    const defaultOverrides: Record<string, ModelCostOverride> = {};

    models.forEach(model => {
      const defaultCost = calculateModelCost(model);
      defaultOverrides[model.id] = defaultCost;
    });

    setModelCostOverrides(defaultOverrides);
    setNotification({
      open: true,
      message: 'All models reverted to default calculated costs. Click "Save Changes" to apply.',
      color: 'warning',
    });
  };

  return (
    <Box sx={{ p: { xs: 1, sm: 2 } }}>
      <Stack spacing={2} sx={{ mb: 2 }}>
        <Alert
          color="warning"
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            justifyContent: 'space-between',
            alignItems: { xs: 'stretch', sm: 'center' },
            gap: { xs: 2, sm: 0 },
          }}
        >
          <Typography level="title-sm">
            Note: These settings control how many credits are charged for each model. Changes will affect all new
            requests immediately.
          </Typography>
          <Button
            variant="outlined"
            color="neutral"
            size="sm"
            onClick={handleRevertToDefaults}
            disabled={isLoadingModels}
            sx={{ width: { xs: '100%', sm: 'auto' }, flexShrink: 0 }}
          >
            Revert back to default costing
          </Button>
        </Alert>
      </Stack>

      {isLoadingModels ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      ) : modelLoadError ? (
        <Alert color="danger" sx={{ mb: 2 }}>
          {modelLoadError}
        </Alert>
      ) : (
        <Tabs
          value={selectedModelType}
          onChange={(_, value) => setSelectedModelType(value as string)}
          sx={{ width: '100%' }}
        >
          <TabList sx={{ justifyContent: 'center' }}>
            <Tab value="text">Text Models</Tab>
            <Tab value="image">Image Models</Tab>
          </TabList>

          <TabPanel value="text" sx={{ p: 0, mt: 2 }}>
            {textModels.length > 0 ? (
              isMobile ? (
                <Stack spacing={1}>
                  {textModels.map(model => {
                    const { inputCost, outputCost } = getCurrentModelCost(model);
                    const isEdited = !!modelCostOverrides[model.id];
                    return (
                      <Card key={model.id} variant="outlined" sx={{ p: 1, gap: 0 }}>
                        <Stack direction="row" justifyContent="space-between" alignItems="center">
                          <Typography level="body-sm" fontWeight="md">
                            {model.name}
                          </Typography>
                          <Stack direction="row" spacing={0.5}>
                            <PriceTierTag model={model} />
                            {isEdited && (
                              <Chip size="sm" color="warning">
                                Modified
                              </Chip>
                            )}
                          </Stack>
                        </Stack>
                        {model.description && (
                          <Typography level="body-xs" color="neutral">
                            {model.description.substring(0, 60)}
                            {model.description.length > 60 ? '...' : ''}
                          </Typography>
                        )}
                        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 1, mt: 0.75 }}>
                          <Input
                            size="sm"
                            type="number"
                            value={inputCost}
                            onChange={e => updateModelCost(model.id, 'inputCost', e.target.value)}
                            startDecorator={<Typography level="body-xs">In</Typography>}
                            endDecorator="cr"
                            slotProps={{ input: { min: 0, step: 0.1 } }}
                          />
                          <Input
                            size="sm"
                            type="number"
                            value={outputCost}
                            onChange={e => updateModelCost(model.id, 'outputCost', e.target.value)}
                            startDecorator={<Typography level="body-xs">Out</Typography>}
                            endDecorator="cr"
                            slotProps={{ input: { min: 0, step: 0.1 } }}
                          />
                        </Box>
                      </Card>
                    );
                  })}
                </Stack>
              ) : (
                <Sheet sx={{ maxHeight: '500px', overflow: 'auto' }}>
                  <Table stickyHeader hoverRow>
                    <thead>
                      <tr>
                        <th style={{ width: '40%' }}>Model Name</th>
                        <th style={{ width: '20%' }}>Price Tier</th>
                        <th style={{ width: '20%' }}>Input Cost</th>
                        <th style={{ width: '20%' }}>Output Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {textModels.map(model => {
                        const { inputCost, outputCost } = getCurrentModelCost(model);
                        const isEdited = !!modelCostOverrides[model.id];
                        return (
                          <tr key={model.id}>
                            <td>
                              <Typography level="body-sm" fontWeight="md">
                                {model.name}
                              </Typography>
                              {model.description && (
                                <Typography level="body-xs" color="neutral">
                                  {model.description.substring(0, 60)}
                                  {model.description.length > 60 ? '...' : ''}
                                </Typography>
                              )}
                            </td>
                            <td>
                              <Stack direction="row" spacing={1} alignItems="center">
                                <PriceTierTag model={model} />
                                {isEdited && (
                                  <Chip size="sm" color="warning">
                                    Modified
                                  </Chip>
                                )}
                              </Stack>
                            </td>
                            <td>
                              <Input
                                size="sm"
                                type="number"
                                value={inputCost}
                                onChange={e => updateModelCost(model.id, 'inputCost', e.target.value)}
                                endDecorator="credits"
                                slotProps={{ input: { min: 0, step: 0.1 } }}
                                sx={{ maxWidth: 120 }}
                              />
                            </td>
                            <td>
                              <Input
                                size="sm"
                                type="number"
                                value={outputCost}
                                onChange={e => updateModelCost(model.id, 'outputCost', e.target.value)}
                                endDecorator="credits"
                                slotProps={{ input: { min: 0, step: 0.1 } }}
                                sx={{ maxWidth: 120 }}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </Table>
                </Sheet>
              )
            ) : (
              <Alert color="neutral">No text models available.</Alert>
            )}
          </TabPanel>

          <TabPanel value="image" sx={{ p: 0, mt: 2 }}>
            {imageModels.length > 0 ? (
              isMobile ? (
                <Stack spacing={1}>
                  {imageModels.map(model => {
                    const { inputCost } = getCurrentModelCost(model);
                    const isEdited = !!modelCostOverrides[model.id];
                    return (
                      <Card key={model.id} variant="outlined" sx={{ p: 1, gap: 0 }}>
                        <Stack direction="row" justifyContent="space-between" alignItems="center">
                          <Typography level="body-sm" fontWeight="md">
                            {model.name}
                          </Typography>
                          <Stack direction="row" spacing={0.5}>
                            <PriceTierTag model={model} />
                            {isEdited && (
                              <Chip size="sm" color="warning">
                                Modified
                              </Chip>
                            )}
                          </Stack>
                        </Stack>
                        {model.description && (
                          <Typography level="body-xs" color="neutral">
                            {model.description.substring(0, 60)}
                            {model.description.length > 60 ? '...' : ''}
                          </Typography>
                        )}
                        <Input
                          size="sm"
                          type="number"
                          value={inputCost}
                          onChange={e => updateModelCost(model.id, 'inputCost', e.target.value)}
                          startDecorator={<Typography level="body-xs">Gen</Typography>}
                          endDecorator="credits"
                          slotProps={{ input: { min: 0, step: 0.1 } }}
                          sx={{ mt: 0.75 }}
                        />
                      </Card>
                    );
                  })}
                </Stack>
              ) : (
                <Sheet sx={{ maxHeight: '500px', overflow: 'auto' }}>
                  <Table stickyHeader hoverRow>
                    <thead>
                      <tr>
                        <th style={{ width: '50%' }}>Model Name</th>
                        <th style={{ width: '20%' }}>Price Tier</th>
                        <th style={{ width: '30%' }}>Generation Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {imageModels.map(model => {
                        const { inputCost } = getCurrentModelCost(model);
                        const isEdited = !!modelCostOverrides[model.id];
                        return (
                          <tr key={model.id}>
                            <td>
                              <Typography level="body-sm" fontWeight="md">
                                {model.name}
                              </Typography>
                              {model.description && (
                                <Typography level="body-xs" color="neutral">
                                  {model.description.substring(0, 60)}
                                  {model.description.length > 60 ? '...' : ''}
                                </Typography>
                              )}
                            </td>
                            <td>
                              <Stack direction="row" spacing={1} alignItems="center">
                                <PriceTierTag model={model} />
                                {isEdited && (
                                  <Chip size="sm" color="warning">
                                    Modified
                                  </Chip>
                                )}
                              </Stack>
                            </td>
                            <td>
                              <Input
                                size="sm"
                                type="number"
                                value={inputCost}
                                onChange={e => updateModelCost(model.id, 'inputCost', e.target.value)}
                                endDecorator="credits"
                                slotProps={{ input: { min: 0, step: 0.1 } }}
                                sx={{ maxWidth: 160 }}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </Table>
                </Sheet>
              )
            ) : (
              <Alert color="neutral">No image models available.</Alert>
            )}
          </TabPanel>
        </Tabs>
      )}

      {/* Save/Reset Buttons - Outside of tabs so they're always visible */}
      {hasUnsavedChanges && (
        <Card variant="outlined" sx={{ p: 2, mt: 2 }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            justifyContent="space-between"
            alignItems={{ xs: 'stretch', sm: 'center' }}
          >
            <Typography level="body-sm" color="warning">
              You have unsaved changes to {Object.keys(modelCostOverrides).length} model
              {Object.keys(modelCostOverrides).length === 1 ? '' : 's'}
            </Typography>
            <Stack direction="row" spacing={1}>
              <Button variant="outlined" color="neutral" onClick={handleReset} sx={{ flex: { xs: 1, sm: 'none' } }}>
                Reset
              </Button>
              <Button
                color="success"
                startDecorator={<SaveIcon />}
                onClick={handleSave}
                loading={isSaving}
                disabled={isSaving}
                sx={{ flex: { xs: 1, sm: 'none' } }}
              >
                Save Changes
              </Button>
            </Stack>
          </Stack>
        </Card>
      )}

      <Snackbar
        open={notification.open}
        color={notification.color}
        onClose={() => setNotification(prev => ({ ...prev, open: false }))}
        autoHideDuration={5000}
        variant="soft"
        sx={{ maxWidth: 400 }}
      >
        {notification.message}
      </Snackbar>
    </Box>
  );
};
