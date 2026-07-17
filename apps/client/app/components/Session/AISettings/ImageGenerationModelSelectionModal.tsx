import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Modal,
  ModalDialog,
  Typography,
  Box,
  Button,
  Select,
  Option,
  Input,
  Slider,
  Stack,
  Tooltip,
  Switch,
  Grid,
  Alert,
  useTheme,
} from '@mui/joy';
import { Settings as SettingsIcon } from '@mui/icons-material';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useShallow } from 'zustand/react/shallow';
import ModelSelection from '../ModelSelection';
import {
  ModelName,
  IMAGE_MODELS,
  ImageModels,
  BFL_IMAGE_MODELS,
  BFL_SAFETY_TOLERANCE,
  GEMINI_IMAGE_MODELS,
  IMAGE_SIZE_CONSTRAINTS,
  OpenAIImageQuality,
  OpenAIImageSize,
  OpenAIImageStyle,
  isGPTImageModel,
  isGPTImage2Model,
} from '@bike4mind/common';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';

import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import {
  getModelPriceTier,
  isNewModel,
  getModelSpeedFromStats,
  getModelSpeedVariant,
  getModelSpeedTooltip,
} from '@client/app/utils/aiSettingsUtils';
import MetadataChip from './MetaDataChips';
import { useModelStats } from '@client/app/hooks/data/useModelStats';
import { ContextHelpButton } from '@client/app/components/help';
interface ImageGenerationModelSelectionModalProps {
  open: boolean;
  onClose: () => void;
}

// Models that support image editing
// FLUX-PRO-FILL now auto-generates masks server-side for chat-based editing.
// All Gemini image models support editing, so derive that portion from
// GEMINI_IMAGE_MODELS to keep this in sync as new Gemini models are added.
const EDIT_SUPPORTED_MODELS = [
  ImageModels.GPT_IMAGE_1,
  ImageModels.GPT_IMAGE_1_5,
  ImageModels.GPT_IMAGE_1_MINI,
  ImageModels.GPT_IMAGE_2,
  ImageModels.FLUX_PRO_FILL,
  ...GEMINI_IMAGE_MODELS,
];

// Always defaults to GPT_IMAGE_2 for best chat-based editing experience (no mask required)
const getDefaultEditModel = (generationModel: string): ModelName => {
  // For Gemini generation, use the same Gemini model for editing (they support it well)
  if ((GEMINI_IMAGE_MODELS as readonly string[]).includes(generationModel)) {
    return generationModel as ModelName;
  }
  // For all other cases (BFL, OpenAI, etc.), default to GPT_IMAGE_2
  // This avoids mask requirements and provides great chat-based editing
  return ImageModels.GPT_IMAGE_2;
};

const ImageGenerationModelSelectionModal: React.FC<ImageGenerationModelSelectionModalProps> = ({ open, onClose }) => {
  const {
    model: contextModel,
    imageModel: contextImageModel,
    imageEditModel: contextImageEditModel,
    setLLM,
    size: _size,
    quality: _quality,
    style: _style,
    seed: _seed,
    output_format: _output_format,
    width: _width,
    height: _height,
    aspect_ratio: _aspect_ratio,
    safety_tolerance: _safety_tolerance,
    prompt_upsampling: _prompt_upsampling,
    temperature: _temperature,
  } = useLLM(
    useShallow(s => ({
      model: s.model,
      imageModel: s.imageModel,
      imageEditModel: s.imageEditModel,
      setLLM: s.setLLM,
      size: s.size,
      quality: s.quality,
      style: s.style,
      seed: s.seed,
      output_format: s.output_format,
      width: s.width,
      height: s.height,
      aspect_ratio: s.aspect_ratio,
      safety_tolerance: s.safety_tolerance,
      prompt_upsampling: s.prompt_upsampling,
      temperature: s.temperature,
    }))
  );

  const theme = useTheme();
  const mode = theme.palette.mode;

  // Seed mode no longer used directly; seed handled via imageSettings input

  const { data: modelInfoRepo } = useModelInfo();
  const { data: stats } = useModelStats();

  // Valid = a static image model OR a runtime-discovered image model (e.g. a
  // self-hosted `local-image/<checkpoint>` id, which is not in the static enum).
  const isValidModelName = (model: string): model is ModelName => {
    if (IMAGE_MODELS.some(imageModel => imageModel === model)) return true;
    return !!modelInfoRepo?.some(m => m.id === model && m.type === 'image');
  };

  // Initialize with validated model or fallback to first image model
  const [selectedModel, setSelectedModel] = useState<ModelName>(() => {
    // Prefer imageModel from context if valid, otherwise fall back to current model, else first available
    if (isValidModelName(contextImageModel)) return contextImageModel;
    return isValidModelName(contextModel) ? contextModel : IMAGE_MODELS[0];
  });

  // Initialize edit model with validated model or smart default
  const [selectedEditModel, setSelectedEditModel] = useState<ModelName>(() => {
    if (isValidModelName(contextImageEditModel)) return contextImageEditModel;
    // Smart default based on generation model
    return getDefaultEditModel(contextImageModel || selectedModel);
  });

  const selectedModelInfo = useMemo(
    () => modelInfoRepo?.find(m => m.id === selectedModel) || null,
    [modelInfoRepo, selectedModel]
  );

  // BFL model handling uses contextModel directly for settings rendering

  // Calculate model metadata
  const priceTierInfo = useMemo(() => {
    if (!selectedModelInfo) return { tier: 'Low', variant: 'green' as const };
    return getModelPriceTier(selectedModelInfo);
  }, [selectedModelInfo]);

  const modelSpeed = getModelSpeedFromStats(selectedModelInfo?.id || '', stats?.avgResponseTime ?? {});
  const isNew = selectedModelInfo ? isNewModel(selectedModelInfo) : false;

  // Sync with context when modal opens
  useEffect(() => {
    if (!open) return;
    if (isValidModelName(contextImageModel)) {
      setSelectedModel(contextImageModel);
    } else if (isValidModelName(contextModel)) {
      setSelectedModel(contextModel);
    }
    // Sync edit model
    if (isValidModelName(contextImageEditModel)) {
      setSelectedEditModel(contextImageEditModel);
    }
    // modelInfoRepo: a local-image context model only validates once the repo
    // has loaded, so re-run when it arrives.
  }, [open, contextModel, contextImageModel, contextImageEditModel, modelInfoRepo]);

  const handleModelChange = useCallback(
    (newModel: ModelName) => {
      setSelectedModel(newModel);
      // Immediately sync the context image model so UI that reads contextImageModel updates live
      const updates: Parameters<typeof setLLM>[0] = { imageModel: newModel, lastUsedImageModel: newModel };
      // If switching to a GPT model with an incompatible size (e.g. a BFL-only size like '1440x810'),
      // reset to the default GPT size so we don't send an invalid size to the backend.
      if (
        isGPTImageModel(newModel) &&
        _size &&
        !IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.sizes.includes(
          _size as (typeof IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.sizes)[number]
        )
      ) {
        updates.size = IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.defaultSize;
      }
      setLLM(updates);
    },
    [setLLM, _size]
  );

  const handleEditModelChange = useCallback(
    (newModel: ModelName) => {
      setSelectedEditModel(newModel);
      // Immediately sync the context so UI that reads contextImageEditModel updates live
      setLLM({ imageEditModel: newModel, lastUsedImageEditModel: newModel });
    },
    [setLLM]
  );

  const handleSave = () => {
    // Picking a model here only set imageModel (a config value); the assistant only gets the
    // image tool when 'image_generation' is in the tools array (the separate toggle in
    // ToolsSection). Enable it on save so the gear panel and the tool toggle can't disagree -
    // otherwise the user selects a model, sees it "selected", and chat reports no image tools.
    const currentTools = useLLM.getState().tools ?? [];
    setLLM({
      imageModel: selectedModel,
      imageEditModel: selectedEditModel,
      lastUsedImageModel: selectedModel,
      lastUsedImageEditModel: selectedEditModel,
      tools: currentTools.includes('image_generation') ? currentTools : [...currentTools, 'image_generation'],
    });
    onClose();
  };

  const handleCancel = () => {
    // Reset to original models
    if (isValidModelName(contextModel)) {
      setSelectedModel(contextModel);
    }
    if (isValidModelName(contextImageEditModel)) {
      setSelectedEditModel(contextImageEditModel);
    }
    onClose();
  };

  const commonInputStyles = {
    width: '100%',
    borderRadius: 6,
    border: 'none',
    backgroundColor: (theme: any) => theme.palette.aiSettings.inputBackground,
    color: 'text.primary',
  };

  const commonSelectStyles = {
    borderRadius: 6,
    border: 'none',
    backgroundColor: (theme: any) => theme.palette.aiSettings.inputBackground,
    color: 'text.primary',
  };

  const getModelConstraintKey = (modelId: string) => {
    if (isGPTImage2Model(modelId)) return 'GPT_IMAGE_2';
    if (isGPTImageModel(modelId)) return 'GPT_IMAGE_1';
    if ((BFL_IMAGE_MODELS as readonly string[]).includes(modelId)) return 'BFL';
    return 'GPT_IMAGE_1';
  };
  const isKontextModel =
    contextImageModel === ImageModels.FLUX_KONTEXT_PRO || contextImageModel === ImageModels.FLUX_KONTEXT_MAX;
  const getAvailableSizes = (modelId: string) => {
    if (isGPTImage2Model(modelId)) return IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.sizes;
    if (isGPTImageModel(modelId)) return IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.sizes;
    if ((BFL_IMAGE_MODELS as readonly string[]).includes(modelId)) {
      if (isKontextModel) return [];
      return IMAGE_SIZE_CONSTRAINTS.BFL.sizes;
    }
    return IMAGE_SIZE_CONSTRAINTS.BFL.sizes;
  };

  // Default quality logic (mirrors AdvancedAISettings)
  const getDefaultQuality = (modelId: string): OpenAIImageQuality => {
    if (isGPTImageModel(modelId)) {
      return 'low';
    }
    return 'standard';
  };

  // Ensure quality defaults appropriately when image model context changes
  useEffect(() => {
    const defaultQuality = getDefaultQuality(contextImageModel);
    if (_quality !== defaultQuality) {
      setLLM({ quality: defaultQuality });
    }
  }, [contextImageModel, _quality, setLLM]);

  const imageSettings = [
    // Temperature (generic input like AdvancedAIModal renders via imageSettings mapping here)
    {
      label: 'Temperature',
      type: 'input' as const,
      value: (_temperature ?? 0.9).toString(),
      onChange: (value: number | undefined) => {
        if (typeof value === 'number' && !isNaN(value)) setLLM({ temperature: value });
      },
      inputProps: {
        type: 'number',
        slotProps: { input: { min: 0, max: 2, step: 0.1 } },
      },
      testId: 'image-setting-temperature-input',
    },
    // Image Size (hidden for Kontext)
    ...(!isKontextModel
      ? [
          {
            label: 'Image Size',
            type: 'select' as const,
            value: _size || IMAGE_SIZE_CONSTRAINTS[getModelConstraintKey(contextImageModel)].defaultSize,
            onChange: (value: OpenAIImageSize | null) => value && setLLM({ size: value }),
            options: getAvailableSizes(contextImageModel).map(s => ({ value: s, label: s })),
            testId: 'image-setting-size-select',
          },
        ]
      : []),
    {
      label: 'Quality',
      type: 'select' as const,
      value: _quality,
      onChange: (value: OpenAIImageQuality | null) => value && setLLM({ quality: value }),
      options: isGPTImageModel(contextImageModel)
        ? [
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
          ]
        : [
            { value: 'standard', label: 'Standard' },
            { value: 'hd', label: 'HD' },
          ],
      testId: 'image-setting-quality-select',
    },
    // Style (not for GPT-Image or BFL models)
    ...(!isGPTImageModel(contextImageModel) && !(BFL_IMAGE_MODELS as readonly string[]).includes(contextImageModel)
      ? [
          {
            label: 'Style',
            type: 'select' as const,
            value: _style,
            onChange: (value: OpenAIImageStyle | null) => value && setLLM({ style: value }),
            options: [
              { value: 'vivid', label: 'Vivid' },
              { value: 'natural', label: 'Natural' },
            ],
            testId: 'image-setting-style-select',
          },
        ]
      : []),
    {
      label: 'Seed',
      type: 'input' as const,
      value: _seed?.toString() ?? '',
      onChange: (value: number | undefined) => setLLM({ seed: typeof value === 'number' ? value : null }),
      tooltip: 'Set a specific seed for reproducible images (leave empty for random)',
      inputProps: {
        type: 'number',
        placeholder: 'Random',
      },
      testId: 'image-setting-seed-input',
    },
    // Width/Height are BFL-specific parameters; GPT Image models use the Image Size dropdown instead
    ...(!isKontextModel && (BFL_IMAGE_MODELS as readonly string[]).includes(contextImageModel)
      ? [
          {
            label: 'Width',
            type: 'input' as const,
            value: _width?.toString() ?? '',
            onChange: (value: number | undefined) => setLLM({ width: value }),
            inputProps: {
              type: 'number',
              placeholder: 'Auto',
              slotProps: { input: { min: 256, max: 4096, step: 8 } },
            },
            testId: 'image-setting-width-input',
          },
          {
            label: 'Height',
            type: 'input' as const,
            value: _height?.toString() ?? '',
            onChange: (value: number | undefined) => setLLM({ height: value }),
            inputProps: {
              type: 'number',
              placeholder: 'Auto',
              slotProps: { input: { min: 256, max: 4096, step: 8 } },
            },
            testId: 'image-setting-height-input',
          },
        ]
      : []),
    {
      label: 'Aspect Ratio',
      type: 'select' as const,
      value: _aspect_ratio?.toString() ?? '',
      onChange: (value: string | null) => setLLM({ aspect_ratio: value ? value : undefined }),
      options: [
        { value: '', label: 'Auto' },
        { value: '16:9', label: '16:9' },
        { value: '4:3', label: '4:3' },
        { value: '1:1', label: '1:1' },
        { value: '3:4', label: '3:4' },
        { value: '9:16', label: '9:16' },
      ],
      testId: 'image-setting-aspect-select',
    },
    {
      label: 'Output Format',
      type: 'select' as const,
      value: (_output_format ?? 'jpeg') as 'jpeg' | 'png',
      onChange: (value: 'jpeg' | 'png' | null) => value && setLLM({ output_format: value }),
      options: [
        { value: 'jpeg', label: 'JPEG' },
        { value: 'png', label: 'PNG' },
      ],
      testId: 'image-setting-format-select',
    },
  ];

  return (
    <Modal
      open={open}
      onClose={(event, reason) => {
        if (reason === 'backdropClick') {
          return;
        }
        onClose();
      }}
      sx={{
        zIndex: 1500,
      }}
    >
      <ModalDialog
        data-testid="image-generation-settings-modal"
        sx={{
          maxWidth: 1400,
          width: '90vw',
          maxHeight: '85vh',
          borderRadius: 'md',
          p: 3,
          boxShadow: 'lg',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <SettingsIcon sx={{ fontSize: '1.5rem', color: 'primary.500' }} />
          <Typography level="h4">Image Generation Settings</Typography>
          <ContextHelpButton helpId="features/image-processing-generation" tooltipText="Learn about Image Generation" />
        </Box>

        <Typography level="body-sm" sx={{ mb: 3, color: 'text.secondary' }}>
          Select an AI image generation model and configure its settings.
        </Typography>

        {/* Two-column layout */}
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' },
            gap: 3,
            flex: 1,
            minHeight: 0,
          }}
        >
          {/* LEFT PANEL: Model Selection */}
          <Box
            sx={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              overflowY: 'auto',
              ...scrollbarStyles,
            }}
          >
            <ModelSelection
              model={selectedModel}
              setModel={handleModelChange}
              imageModel={true}
              showAllModels={false}
              modelFilter="image"
            />
          </Box>

          {/* RIGHT PANEL: Model Details and Settings */}
          <Box
            sx={{
              flex: 1,
              backgroundColor: 'background.panel2',
              borderRadius: '8px',
              px: 3,
              py: 2,
              display: 'flex',
              flexDirection: 'column',
              overflowY: 'auto',
              border: '1px solid',
              borderColor: theme => theme.palette.aiSettings.modal.borderColor,
              ...scrollbarStyles,
            }}
          >
            {/* Model Header */}
            {selectedModelInfo && (
              <Box sx={{ mb: 3 }}>
                <Typography level="h3" sx={{ mb: 1 }}>
                  {selectedModelInfo.name}
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.secondary', mb: 2 }}>
                  {selectedModelInfo.description}
                </Typography>

                {/* Metadata Badges */}
                <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1, mb: 2 }}>
                  {isNew && <MetadataChip label="New" mode={mode} variant="blue" />}
                  <MetadataChip label={priceTierInfo.tier} mode={mode} variant={priceTierInfo.variant} />
                  {modelSpeed && (
                    <MetadataChip
                      label={modelSpeed.charAt(0).toUpperCase() + modelSpeed.slice(1)}
                      mode={mode}
                      variant={getModelSpeedVariant(modelSpeed as 'fast' | 'medium' | 'slow')}
                      tooltip={getModelSpeedTooltip(modelSpeed as 'fast' | 'medium' | 'slow')}
                    />
                  )}
                  {selectedModelInfo.max_tokens && (
                    <MetadataChip label={`${selectedModelInfo.max_tokens} max`} mode={mode} variant="default" />
                  )}
                  {selectedModelInfo.contextWindow && (
                    <MetadataChip
                      label={`${(selectedModelInfo.contextWindow / 1000).toFixed(1)}M ctx`}
                      mode={mode}
                      variant="default"
                    />
                  )}
                </Stack>

                {!selectedModelInfo.supportsTools && (
                  <Typography level="body-sm" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
                    Tools not supported
                  </Typography>
                )}

                {/* GPT-Image Model Info */}
                {isGPTImageModel(selectedModel) && (
                  <Typography
                    level="body-xs"
                    sx={{
                      color: 'primary.800',
                      fontSize: '14px',
                      fontWeight: '500',
                      mt: 2,
                    }}
                  >
                    This model has specific parameter constraints. Some settings like Style are not available, and
                    invalid parameters will be automatically adjusted to compatible values.
                  </Typography>
                )}
              </Box>
            )}

            {/* Advanced Settings */}
            <Typography level="title-lg" sx={{ mb: 2 }}>
              Advanced Settings
            </Typography>

            <Grid container spacing={2} sx={{ px: 0, mb: 2 }}>
              {/* Image Model Settings (generic rendering) */}
              {imageSettings.map(setting => (
                <Grid key={setting.label} xs={12} md={6}>
                  <Box sx={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '20px' }}>
                    <Typography level="body-sm">{setting.label}</Typography>
                    <Box sx={{ minWidth: '120px' }}>
                      {setting.type === 'select' && (
                        <Select
                          value={setting.value}
                          onChange={(_, newValue: any) => setting.onChange(newValue)}
                          sx={commonSelectStyles}
                          slotProps={{ listbox: { sx: { zIndex: 2000 } } }}
                          data-testid={(setting as any).testId}
                        >
                          {(setting as any).options.map((option: any) => (
                            <Option key={option.value} value={option.value}>
                              {option.label}
                            </Option>
                          ))}
                        </Select>
                      )}
                      {setting.type === 'input' && (
                        <Input
                          sx={commonInputStyles}
                          size="sm"
                          variant="outlined"
                          color="primary"
                          value={(setting as any).value}
                          {...(setting as any).inputProps}
                          onChange={(e: any) => {
                            const raw = e.target.value;
                            const val = raw === '' ? undefined : Number(raw);
                            (setting as any).onChange(val);
                          }}
                          data-testid={(setting as any).testId}
                        />
                      )}
                    </Box>
                  </Box>
                </Grid>
              ))}
            </Grid>

            {/* BFL-specific Prompt Upsampling & Safety controls */}
            {(BFL_IMAGE_MODELS as readonly string[]).includes(contextImageModel) && (
              <Grid container spacing={2}>
                <Grid xs={12} md={6}>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Tooltip title="Enhances prompt quality for better image generation">
                      <Typography level="body-sm" sx={{ mb: 0.5 }}>
                        Prompt Upsampling
                      </Typography>
                    </Tooltip>
                    <Switch
                      checked={_prompt_upsampling ?? false}
                      onChange={(e: any) => setLLM({ prompt_upsampling: e.target.checked })}
                      color={_prompt_upsampling ? 'success' : 'neutral'}
                      data-testid="prompt-upsampling-switch"
                    />
                  </Box>
                </Grid>
                <Grid xs={12} md={6}>
                  <Box>
                    <Tooltip title="Controls content filtering: 0=Strictest, 2=Most permissive (hard-capped)">
                      <Typography level="body-sm" sx={{ mb: 0.5 }}>
                        Safety Tolerance: {_safety_tolerance ?? BFL_SAFETY_TOLERANCE.DEFAULT}
                      </Typography>
                    </Tooltip>
                    <Input
                      type="number"
                      value={_safety_tolerance ?? BFL_SAFETY_TOLERANCE.DEFAULT}
                      onChange={e => setLLM({ safety_tolerance: Number(e.target.value) })}
                      slotProps={{ input: { min: BFL_SAFETY_TOLERANCE.MIN, max: BFL_SAFETY_TOLERANCE.MAX, step: 1 } }}
                      sx={commonInputStyles}
                    />
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, pt: 2 }}>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', px: 0.5 }}>
                        <Typography level="body-xs" sx={{ color: 'text.secondary', fontWeight: 500 }}>
                          🛡️ Family-friendly
                        </Typography>
                        <Typography level="body-xs" sx={{ color: 'text.secondary', fontWeight: 500 }}>
                          🎨 Creative
                        </Typography>
                      </Box>
                      <Slider
                        aria-label="Safety Tolerance"
                        value={_safety_tolerance ?? BFL_SAFETY_TOLERANCE.DEFAULT}
                        min={BFL_SAFETY_TOLERANCE.MIN}
                        max={BFL_SAFETY_TOLERANCE.MAX}
                        step={1}
                        onChange={(_, newValue) => {
                          if (typeof newValue === 'number') setLLM({ safety_tolerance: newValue });
                        }}
                        valueLabelDisplay="auto"
                        data-testid="safety-tolerance-slider"
                        marks={[
                          { value: 0, label: '🛡️ Safe' },
                          { value: 1, label: '📝 Mild' },
                          { value: 2, label: '🎨 Creative' },
                        ]}
                        sx={{
                          '--Slider-trackSize': '6px',
                          '--Slider-thumbSize': '14px',
                          '--Slider-thumbWidth': '14px',
                          '& .MuiSlider-mark': {
                            display: 'block',
                            height: '8px',
                            width: '2px',
                            backgroundColor: 'var(--joy-palette-neutral-400)',
                          },
                          '& .MuiSlider-markLabel': { fontSize: '0.75rem', fontWeight: 500, marginTop: '8px' },
                        }}
                      />
                    </Box>
                  </Box>
                </Grid>
              </Grid>
            )}

            {/* Image Editing Model Section */}
            <Box sx={{ mt: 4, mb: 3 }}>
              <Typography level="title-lg" sx={{ mb: 1 }}>
                Image Editing Model
                <ContextHelpButton helpId="image-edit-model" />
              </Typography>
              <Typography level="body-sm" sx={{ color: 'text.secondary', mb: 2 }}>
                Choose which model to use when editing images via chat commands.
              </Typography>

              {/* Edit Model Selection */}
              <Box sx={{ mb: 2 }}>
                <Select
                  value={selectedEditModel as any}
                  onChange={(_, newValue: any) => handleEditModelChange(newValue as ModelName)}
                  sx={{ ...commonSelectStyles, width: '100%' }}
                  slotProps={{ listbox: { sx: { zIndex: 2000 } } }}
                  data-testid="edit-model-select"
                >
                  {EDIT_SUPPORTED_MODELS.map(modelId => {
                    const modelInfo = modelInfoRepo?.find(m => m.id === modelId);
                    const isMaskRequired = modelId === ImageModels.FLUX_PRO_FILL;
                    return (
                      <Option key={modelId} value={modelId as any}>
                        {modelInfo?.name || modelId}
                        {isMaskRequired && ' (requires mask)'}
                        {!isMaskRequired && ' ✓'}
                      </Option>
                    );
                  })}
                </Select>
              </Box>

              {/* Warning for mask-required models */}
              {selectedEditModel === ImageModels.FLUX_PRO_FILL && (
                <Alert color="warning" sx={{ mt: 2 }}>
                  <Typography level="body-sm">
                    <strong>⚠️ Mask Required:</strong> FLUX-PRO-FILL requires a mask image to specify edit areas.
                    <br />
                    <br />
                    <strong>For chat-based editing without masks, switch to:</strong>
                    <br />• GPT-Image-1.5 (recommended, best quality)
                    <br />• GPT-Image-1-Mini (cost-effective)
                    <br />• Gemini models (natural language editing)
                  </Typography>
                </Alert>
              )}

              {/* Info about recommended models */}
              {selectedEditModel !== ImageModels.FLUX_PRO_FILL && (
                <Alert color="success" sx={{ mt: 2 }}>
                  <Typography level="body-sm">
                    <strong>✓ Chat-Friendly:</strong> This model works great for natural language image editing via
                    chat. No mask images required!
                  </Typography>
                </Alert>
              )}
            </Box>

            {/* Action Buttons */}
            <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', mt: 3 }}>
              <Button variant="outlined" color="neutral" onClick={handleCancel} data-testid="image-model-cancel-btn">
                Cancel
              </Button>
              <Button variant="solid" color="primary" onClick={handleSave} data-testid="image-model-select-btn">
                Select Model
              </Button>
            </Box>
          </Box>
        </Box>
      </ModalDialog>
    </Modal>
  );
};

export default ImageGenerationModelSelectionModal;
