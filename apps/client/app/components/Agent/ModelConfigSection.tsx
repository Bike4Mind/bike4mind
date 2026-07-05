import React from 'react';
import { Card, Typography, FormControl, FormLabel, Input, Select, Option, Box, ListItemDecorator } from '@mui/joy';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { FormState } from '../../types/agentForm';
import { useAccessibleModels } from '../../hooks/useAccessibleModels';

interface ModelConfigSectionProps {
  formState: FormState;
  onModelChange: (value: string) => void;
  onImageModelChange: (value: string) => void;
  onTemperatureChange: (value: number) => void;
  onMaxTokensChange: (value: number) => void;
  readOnly?: boolean;
}

const ModelConfigSection: React.FC<ModelConfigSectionProps> = ({
  formState,
  onModelChange,
  onImageModelChange,
  onTemperatureChange,
  onMaxTokensChange,
  readOnly = false,
}) => {
  const { accessibleTextModels, accessibleImageModels } = useAccessibleModels();

  // Group models by backend for the dropdown
  const groupedModels = accessibleTextModels.reduce(
    (acc, model) => {
      const backend = model.backend;
      if (!acc[backend]) acc[backend] = [];
      acc[backend].push(model);
      return acc;
    },
    {} as Record<string, typeof accessibleTextModels>
  );

  // Group image models by backend for the image-model dropdown
  const groupedImageModels = accessibleImageModels.reduce(
    (acc, model) => {
      const backend = model.backend;
      if (!acc[backend]) acc[backend] = [];
      acc[backend].push(model);
      return acc;
    },
    {} as Record<string, typeof accessibleImageModels>
  );

  return (
    <Card
      variant="outlined"
      sx={{
        backgroundColor: theme => theme.palette.background.body,
        border: theme => `1px solid ${theme.palette.border.soft}`,
        borderRadius: '8px',
        p: { xs: 2, sm: 3 },
        gap: 0,
        height: '100%',
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        <Typography level="title-md">Model Configuration</Typography>
        <Typography level="body-xs" sx={{ mt: 0.5, mb: 3, color: 'text.primary50' }}>
          AI model, image model, temperature, and token limits for this agent
        </Typography>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr 1fr' }, gap: 2 }}>
        {/* Model Selector */}
        <FormControl size="sm">
          <FormLabel sx={{ fontWeight: 400, color: 'text.primary50' }}>Model</FormLabel>
          <Select
            size="sm"
            sx={{
              border: '1px solid',
              borderColor: 'border.input',
              backgroundColor: 'background.panel',
              color: 'text.primary',
              boxShadow: 'none',
            }}
            indicator={<KeyboardArrowDownIcon />}
            value={formState.preferredModel}
            onChange={(_, value) => onModelChange(value || '')}
            disabled={readOnly}
            data-testid="model-config-model-select"
          >
            <Option value="">System Default (GPT-4.1 Mini)</Option>
            {Object.entries(groupedModels).map(([backend, models]) => [
              <Option key={`header-${backend}`} value={`__header_${backend}`} disabled>
                <ListItemDecorator>
                  <Typography level="body-xs" sx={{ fontWeight: 700, textTransform: 'uppercase' }}>
                    {backend}
                  </Typography>
                </ListItemDecorator>
              </Option>,
              ...models.map(model => (
                <Option key={model.id} value={model.id}>
                  {model.name}
                </Option>
              )),
            ])}
          </Select>
        </FormControl>

        {/* Temperature Input */}
        <FormControl size="sm">
          <FormLabel sx={{ fontWeight: 400, color: 'text.primary50' }}>Temperature</FormLabel>
          <Input
            size="sm"
            type="number"
            sx={{
              border: '1px solid',
              borderColor: 'border.input',
              backgroundColor: 'background.panel',
              color: 'text.primary',
              boxShadow: 'none',
            }}
            slotProps={{
              input: {
                min: 0,
                max: 2,
                step: 0.1,
              },
            }}
            value={formState.temperature}
            onChange={e => {
              const val = parseFloat(e.target.value);
              if (!isNaN(val) && val >= 0 && val <= 2) {
                onTemperatureChange(val);
              }
            }}
            readOnly={readOnly}
            data-testid="model-config-temperature-input"
          />
        </FormControl>

        {/* Max Tokens Input */}
        <FormControl size="sm">
          <FormLabel sx={{ fontWeight: 400, color: 'text.primary50' }}>Max Tokens</FormLabel>
          <Input
            size="sm"
            type="number"
            sx={{
              border: '1px solid',
              borderColor: 'border.input',
              backgroundColor: 'background.panel',
              color: 'text.primary',
              boxShadow: 'none',
            }}
            slotProps={{
              input: {
                min: 1,
                max: 128000,
                step: 100,
              },
            }}
            value={formState.maxTokens}
            onChange={e => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val >= 1 && val <= 128000) {
                onMaxTokensChange(val);
              }
            }}
            readOnly={readOnly}
            data-testid="model-config-max-tokens-input"
          />
        </FormControl>
      </Box>

      {/* Image Model Selector - overrides the image model used when this agent
          generates images. Empty = inherit the caller's image selection / system
          default. Its own row so it sits apart from the text-model knobs. */}
      <Box sx={{ mt: 2, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr 1fr' }, gap: 2 }}>
        <FormControl size="sm">
          <FormLabel sx={{ fontWeight: 400, color: 'text.primary50' }}>Image Model</FormLabel>
          <Select
            size="sm"
            sx={{
              border: '1px solid',
              borderColor: 'border.input',
              backgroundColor: 'background.panel',
              color: 'text.primary',
              boxShadow: 'none',
            }}
            indicator={<KeyboardArrowDownIcon />}
            value={formState.preferredImageModel}
            onChange={(_, value) => onImageModelChange(value || '')}
            disabled={readOnly}
            data-testid="model-config-image-model-select"
          >
            <Option value="">System Default</Option>
            {Object.entries(groupedImageModels).map(([backend, models]) => [
              <Option key={`img-header-${backend}`} value={`__img_header_${backend}`} disabled>
                <ListItemDecorator>
                  <Typography level="body-xs" sx={{ fontWeight: 700, textTransform: 'uppercase' }}>
                    {backend}
                  </Typography>
                </ListItemDecorator>
              </Option>,
              ...models.map(model => (
                <Option key={model.id} value={model.id}>
                  {model.name}
                </Option>
              )),
            ])}
          </Select>
        </FormControl>
      </Box>
    </Card>
  );
};

export default ModelConfigSection;
