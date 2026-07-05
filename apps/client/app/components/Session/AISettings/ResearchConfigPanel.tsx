import { FC } from 'react';
import { Box, Card, Typography, Button, Input, IconButton, Stack, Select, Option, Divider, Tooltip } from '@mui/joy';
import { Close as CloseIcon, KeyboardArrowDown } from '@mui/icons-material';
import { ResearchModeConfiguration } from '@client/app/types/ResearchMode';
import { ChatModelName, ChatModels, NO_TEMPERATURE_MODELS } from '@bike4mind/common';
import { useAccessibleModels } from '@client/app/hooks/useAccessibleModels';

interface ResearchConfigPanelProps {
  index: number;
  config?: ResearchModeConfiguration;
  onUpdate: (updates: Partial<ResearchModeConfiguration>) => void;
  onRemove: () => void;
}

const inputStyles = {
  fontSize: '14px',
  width: '100%',
  '& input[type=number]::-webkit-inner-spin-button, & input[type=number]::-webkit-outer-spin-button': {
    opacity: 1,
    marginRight: '-1px',
  },
} as const;

// Stacked label + full-width number input. Stacking (rather than a space-between
// row with a fixed-width input) keeps the fields legible in the narrow 4-across
// Research Mode grid, where the previous hardcoded input width left no room for
// the label and caused label/value collisions (e.g. "Tempera", "Contex400,000").
const ParameterField: FC<{
  testId: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  parse?: (raw: string) => number;
}> = ({ testId, label, value, onChange, min, max, step, parse = parseFloat }) => (
  <Box data-testid={testId} sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
    <Typography level="body-xs" sx={{ color: 'text.primary50', fontSize: '14px' }}>
      {label}
    </Typography>
    <Input
      size="sm"
      type="number"
      value={value}
      // Clearing the field yields parseFloat('')/parseInt('') -> NaN; drop it so
      // NaN never lands in config.parameters (and never feeds a controlled input).
      onChange={e => {
        const next = parse(e.target.value);
        if (Number.isNaN(next)) return;
        onChange(next);
      }}
      slotProps={{ input: { 'aria-label': label, min, max, step, style: { textAlign: 'center' } } }}
      sx={inputStyles}
    />
  </Box>
);

export const ResearchConfigPanel: FC<ResearchConfigPanelProps> = ({ index, config, onUpdate, onRemove }) => {
  const { accessibleTextModels } = useAccessibleModels();
  const isEmpty = !config;

  // Use accessible text models only (filtered by user role/permissions)
  const textModels = accessibleTextModels || [];

  // Full name of the currently-selected model, for the hover tooltip below (the Select
  // is deliberately narrow and clips the label - see the Tooltip around it).
  const selectedModel = config ? textModels.find(m => m.id === config.model) : undefined;

  // Newer Anthropic models (Opus 4.7/4.8, Sonnet 5, Fable 5) reject temperature/
  // top_p/top_k with a 400 - hide the sampling-parameter inputs for them, matching
  // the gating in AdvancedAIModal. Max Tokens is supported by every model.
  const supportsSamplingParams = config ? !NO_TEMPERATURE_MODELS.has(config.model) : true;

  return (
    <Card
      variant={'soft'}
      sx={{
        p: 2,
        height: '100%',
        backgroundColor: isEmpty ? 'transparent' : 'primary.softBg',
        border: '1px solid',
        borderColor: 'border.light',
        flex: 1,
      }}
    >
      {isEmpty ? (
        <Box
          sx={{
            textAlign: 'center',
            py: 3,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            flex: 1,
          }}
        >
          <Typography level="body-sm" sx={{ color: 'neutral.500', mb: 1, fontSize: '16px' }}>
            Configuration {index + 1}
          </Typography>
          <Button
            size="sm"
            variant="soft"
            onClick={() =>
              onUpdate({
                enabled: true,
                model: (textModels[0]?.id as ChatModels) || ChatModels.GPT4_1,
                parameters: {
                  temperature: 0.7,
                  maxTokens: 4096,
                },
              })
            }
            sx={{
              width: '80px',
              fontWeight: '400',
              border: '1px solid',
              borderColor: 'border.light',
              borderRadius: '8px',
              backgroundColor: 'background.body',
              color: 'text.primary',
              '&:hover': {
                backgroundColor: 'primary.softBg',
              },
            }}
          >
            + Add
          </Button>
        </Box>
      ) : (
        <>
          {/* Model Dropdown */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
            {/* The Select is deliberately narrow (minWidth 0) in the 4-across grid, so the
                selected label hard-clips (SelectButton is nowrap + overflow:hidden). Wrap the
                whole Select in a Tooltip so the full model name is discoverable on hover.
                Wrapping the control - rather than the value inside the button via renderValue -
                keeps the hover target reliable (a Tooltip nested in the button doesn't fire). */}
            <Tooltip
              title={selectedModel?.name ?? ''}
              placement="top"
              disableHoverListener={!selectedModel?.name}
              sx={{ maxWidth: 320 }}
            >
              <Select
                data-testid="research-model-select"
                size="sm"
                value={config.model || ''}
                onChange={(_, value) => value && onUpdate({ model: value as ChatModelName })}
                indicator={<KeyboardArrowDown sx={{ color: 'text.primary', fontSize: '12px' }} />}
                placeholder="Select a model"
                sx={{
                  fontSize: '14px',
                  // minWidth: 0 lets the Select shrink inside the narrow 4-across card so
                  // the fixed-size close button beside it stays in-bounds (was minWidth 120px +
                  // mr 16px, which overflowed the card and clipped the X).
                  minWidth: 0,
                  flex: 1,
                  '& .MuiSelect-listbox': {
                    border: 'none',
                    boxShadow: 'none',
                  },
                }}
                slotProps={{
                  listbox: {
                    sx: {
                      border: 'none !important',
                      boxShadow: 'var(--joy-shadow-md)',
                      '&::before': {
                        display: 'none',
                      },
                      '&::after': {
                        display: 'none',
                      },
                      '& .MuiOption-root': {
                        borderTop: 'none !important',
                        borderBottom: 'none !important',
                        '&::before': {
                          display: 'none',
                        },
                        '&::after': {
                          display: 'none',
                        },
                      },
                      '& .MuiList-root': {
                        border: 'none !important',
                        '&::before': {
                          display: 'none',
                        },
                        '&::after': {
                          display: 'none',
                        },
                      },
                    },
                  },
                }}
              >
                {textModels.map(model => (
                  <Option key={model.id} value={model.id}>
                    {model.name}
                  </Option>
                ))}
              </Select>
            </Tooltip>

            {/* Close button */}
            <IconButton
              size="sm"
              onClick={onRemove}
              sx={{
                flexShrink: 0,
                color: 'neutral.500',
                '&:hover': { color: 'danger.500' },
                border: '1px solid',
                borderColor: 'border.light',
              }}
            >
              <CloseIcon sx={{ fontSize: '18px' }} />
            </IconButton>
          </Box>

          <Stack spacing={3}>
            {/* Context and Max Output */}
            {config.model && textModels && (
              <Box>
                {(() => {
                  const modelInfo = textModels.find(m => m.id === config.model);
                  if (!modelInfo) return null;

                  return (
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, alignItems: 'baseline' }}>
                        <Typography level="body-xs" sx={{ color: 'text.primary50', fontSize: '14px', flexShrink: 0 }}>
                          Context:
                        </Typography>
                        <Typography
                          level="body-xs"
                          sx={{ color: 'text.primary', fontSize: '14px', textAlign: 'right', minWidth: 0 }}
                        >
                          {modelInfo.contextWindow?.toLocaleString() || 'Unknown'} tokens
                        </Typography>
                      </Box>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, alignItems: 'baseline' }}>
                        <Typography level="body-xs" sx={{ color: 'text.primary50', fontSize: '14px', flexShrink: 0 }}>
                          Max Output:
                        </Typography>
                        <Typography
                          level="body-xs"
                          sx={{ color: 'text.primary', fontSize: '14px', textAlign: 'right', minWidth: 0 }}
                        >
                          {modelInfo.max_tokens?.toLocaleString() || 'Unknown'} tokens
                        </Typography>
                      </Box>
                    </Box>
                  );
                })()}
              </Box>
            )}

            {config.model && (
              <>
                <Divider
                  sx={{
                    backgroundColor: 'border.light',
                    opacity: 0.7,
                    width: '100%',
                    px: 4,
                    height: '1px',
                    mx: 'auto',
                  }}
                />

                {/* Parameters */}
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
                  {supportsSamplingParams && (
                    <ParameterField
                      testId="research-param-temperature"
                      label="Temperature"
                      value={config.parameters.temperature ?? 0.7}
                      onChange={temperature => onUpdate({ parameters: { ...config.parameters, temperature } })}
                      min={0}
                      max={2}
                      step={0.1}
                    />
                  )}

                  <ParameterField
                    testId="research-param-max-tokens"
                    label="Max Tokens"
                    value={config.parameters.maxTokens ?? 4096}
                    onChange={maxTokens => onUpdate({ parameters: { ...config.parameters, maxTokens } })}
                    min={1}
                    max={128000}
                    step={1024}
                    parse={raw => parseInt(raw, 10)}
                  />

                  {supportsSamplingParams && (
                    <>
                      <ParameterField
                        testId="research-param-top-p"
                        label="Top P (0-1)"
                        value={config.parameters.topP ?? 1}
                        onChange={topP => onUpdate({ parameters: { ...config.parameters, topP } })}
                        min={0}
                        max={1}
                        step={0.1}
                      />

                      <ParameterField
                        testId="research-param-frequency-penalty"
                        label="Frequency penalty (-2 to 2)"
                        value={config.parameters.frequencyPenalty ?? 0}
                        onChange={frequencyPenalty =>
                          onUpdate({ parameters: { ...config.parameters, frequencyPenalty } })
                        }
                        min={-2}
                        max={2}
                        step={0.1}
                      />
                    </>
                  )}
                </Box>
              </>
            )}
          </Stack>
        </>
      )}
    </Card>
  );
};
