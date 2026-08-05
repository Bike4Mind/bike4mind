import React, { ChangeEvent, startTransition, useCallback, useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import {
  Box,
  Modal,
  ModalDialog,
  Sheet,
  Button,
  IconButton,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  Typography,
  Stack,
  Input,
  Slider,
  Grid,
  Checkbox,
  Tooltip,
  Select,
  Option,
  Switch,
  Divider,
} from '@mui/joy';
import {
  Close as CloseIcon,
  Check as CheckIcon,
  RestartAlt as RestartAltIcon,
  KeyboardArrowDown as KeyboardArrowDownIcon,
  ArrowBack as ArrowBackIcon,
} from '@mui/icons-material';
import type { Theme } from '@mui/joy/styles';
import { useTheme } from '@mui/joy';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import {
  B4MLLMTools,
  BFL_SAFETY_TOLERANCE,
  ChatModels,
  FIXED_TEMPERATURE_MODELS,
  NO_TEMPERATURE_MODELS,
  IMAGE_SIZE_CONSTRAINTS,
  isBflImageModel,
  ModelBackend,
  ModelInfo,
  ModelName,
  ChatModelName,
  ImageModels,
  OpenAIImageQuality,
  OpenAIImageSize,
  OpenAIImageStyle,
  REASONING_SUPPORTED_MODELS,
  UserReasoningEffort,
  isGPTImage2Model,
  isGPTImageModel,
  isKontextModel as isKontextImageModel,
} from '@bike4mind/common';
import { INFINITE_VALUE } from '@client/app/components/FibonacciSlider';
import { ResearchModeConfiguration, ResearchModeState } from '@client/app/types/ResearchMode';
import { useLLM, LLMContextProps } from '@client/app/contexts/LLMContext';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useShallow } from 'zustand/react/shallow';
import { ResearchConfigPanel } from './ResearchConfigPanel';
import ToolsSection from './ToolsSection';
import { AudioGenerationSettings } from './AudioGenerationSettings';
import SquareSlideToggle from '@client/app/components/SquareSlideToggle';

import ModelSelection, { getModelBackend } from '../ModelSelection';
import {
  BEDROCK_BADGE_BG,
  CapabilityIndicators,
  CornerBadge,
  MetricIndicators,
  ModelSpeed,
  NEW_BADGE_BG,
  SelectedCheckIcon,
  SpecPill,
  formatContextWindow,
  formatNumber,
} from './modelIndicators';
import MetadataChip from './MetaDataChips';
import {
  buildModelSelectionPatch,
  ChipVariant,
  computeDefaultMaxTokens,
  getModelPriceTier,
  getModelSpeedFromStats,
  getModelSpeedTooltip,
  getModelSpeedVariant,
  getPriceTierTooltip,
  isNewModel,
} from '@client/app/utils/aiSettingsUtils';
import { useModelStats } from '@client/app/hooks/data/useModelStats';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import { useUser } from '@client/app/contexts/UserContext';
import { api } from '@client/app/contexts/ApiContext';
import { MobileTopBar } from '@client/app/components/MobileTopBar';
import { brand, grayAlpha, green, greenAlpha } from '@client/app/utils/themes/colors';

import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import { ContextHelpButton, FieldTooltip, FIELD_TOOLTIPS } from '@client/app/components/help';
import { useAdvancedAISettings } from './useAdvancedAISettingsStore';
import { HEADER_ICON_BUTTON_SX } from './headerIconButtonSx';
import { TabIntro } from './TabIntro';
import { isImageModel } from '@client/app/utils/commands';
import { updateSessionToServer } from '@client/app/utils/sessionsAPICalls';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { ImageTemplatePanel } from '../ImageTemplates/ImageTemplatePanel';

const commonInputStyles = (_mode: string) => ({
  width: '120px',
  height: '36px',
  '& input[type=number]::-webkit-inner-spin-button, & input[type=number]::-webkit-outer-spin-button': {
    opacity: 1,
    marginRight: '-1px',
  },
  '& input': {
    textAlign: 'center',
  },
  borderRadius: 8,
  border: `1px solid`,
  borderColor: 'border.solid',
  // `aiSettings.background` (not `.backgroundColor`, which doesn't exist on the palette) -
  // surfaced by removing the `any` cast that was previously masking this.
  backgroundColor: (theme: Theme) => theme.palette.aiSettings.background,
  color: 'text.primary',
});

const commonSelectStyles = (mode: string) => ({
  ...commonInputStyles(mode || 'light'),
  fontSize: '14px',
  '& .MuiSelect-button': {
    textAlign: 'center',
    justifyContent: 'center',
  },
});

const commonTextTitleStyles = {
  color: 'text.primary',
  fontSize: '16px',
};

interface ImageSettingOption {
  value: string;
  label: string;
}

// `onChange` uses method syntax (not an arrow-function property) so TS applies bivariant
// parameter checking - the concrete settings built in `imageSettings` each have a narrower
// `onChange` (e.g. `(value: OpenAIImageSize | null) => void`) that wouldn't otherwise satisfy
// this shared, wider signature.
interface ImageSettingItem {
  label: string;
  type: 'select' | 'input';
  value: string | undefined;
  tooltip?: string;
  options?: ImageSettingOption[];
  inputProps?: Record<string, unknown>;
  onChange(value: string | number | null | undefined): void;
}

const getAvailableSizes = (model: string) => {
  if (isGPTImage2Model(model)) {
    return IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.sizes;
  } else if (isGPTImageModel(model)) {
    return IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.sizes;
  } else if (isBflImageModel(model)) {
    if (isKontextImageModel(model)) return [];
    return IMAGE_SIZE_CONSTRAINTS.BFL.sizes;
  }
  return IMAGE_SIZE_CONSTRAINTS.BFL.sizes;
};

const getModelConstraintKey = (model: string) => {
  if (isGPTImage2Model(model)) return 'GPT_IMAGE_2';
  if (isGPTImageModel(model)) return 'GPT_IMAGE_1';
  if (isBflImageModel(model)) return 'BFL';
  return 'GPT_IMAGE_1';
};

const BASE_REASONING_EFFORT_OPTIONS: { value: UserReasoningEffort; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low (Fast)' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High (Best)' },
];

const XHIGH_OPTION = { value: 'xhigh' as UserReasoningEffort, label: 'Extra High (Best)' };

const GPT5_2_MODEL_IDS: ReadonlySet<string> = new Set([ChatModels.GPT5_2, ChatModels.GPT5_2_CHAT_LATEST]);

const ReasoningEffortSelector: React.FC<{
  model: ModelName;
  commonInputStyles: typeof commonInputStyles;
  mode: 'dark' | 'light';
}> = ({ model, commonInputStyles, mode }) => {
  const isGPT52 = GPT5_2_MODEL_IDS.has(model);
  const options = isGPT52
    ? [...BASE_REASONING_EFFORT_OPTIONS.map(o => (o.value === 'high' ? { ...o, label: 'High' } : o)), XHIGH_OPTION]
    : BASE_REASONING_EFFORT_OPTIONS;
  const { currentUser, setCurrentUser } = useUser();
  const currentValue: UserReasoningEffort = currentUser?.preferredReasoningEffort ?? 'auto';

  // Reset to 'auto' if current value is 'xhigh' but model doesn't support it
  useEffect(() => {
    if (currentValue === 'xhigh' && !isGPT52 && currentUser) {
      api
        .put(`/api/users/${currentUser.id}/update`, { preferredReasoningEffort: 'auto' })
        .then(response => setCurrentUser(response.data))
        .catch(err => console.error('Failed to reset reasoning effort:', err));
    }
  }, [model]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleChange = async (_: unknown, newValue: UserReasoningEffort | null) => {
    if (!currentUser || newValue === null) return;
    try {
      const response = await api.put(`/api/users/${currentUser.id}/update`, {
        preferredReasoningEffort: newValue,
      });
      setCurrentUser(response.data);
    } catch (error) {
      console.error('Failed to update reasoning effort preference:', error);
    }
  };

  return (
    <Grid xs={12} md={6}>
      <Box
        sx={{
          display: 'flex',
          justifyContent: { xs: 'flex-start', sm: 'flex-end' },
          alignItems: 'center',
          gap: '20px',
        }}
      >
        <Tooltip title="Controls how much reasoning the model does. Lower = faster, Higher = more thorough">
          <Typography level="body-sm" sx={{ flex: { xs: '1 1 0%', sm: '0 0 auto' } }}>
            Reasoning Effort
          </Typography>
        </Tooltip>
        <Select
          value={currentValue}
          onChange={handleChange}
          indicator={<KeyboardArrowDownIcon />}
          sx={{
            ...commonInputStyles(mode || 'light'),
            minWidth: { xs: 'auto', sm: '6rem' },
            height: 32,
            p: 1,
            flex: { xs: '1 1 0%', sm: '0 0 auto' },
            '& .MuiSelect-button': {
              textAlign: 'center',
              paddingBlock: '4px',
              fontSize: '0.875rem',
            },
            '& .MuiSelect-indicator': {
              color: 'var(--joy-palette-text-tertiary)',
              transition: '0.2s',
              width: '20px',
              height: '20px',
            },
            '& .MuiSelect-endDecorator': {
              marginRight: '4px',
            },
            '&[aria-expanded="true"] .MuiSelect-indicator': {
              transform: 'rotate(180deg)',
            },
            '&:hover': {
              borderColor: 'var(--joy-palette-neutral-400)',
            },
            '&.Mui-focused': {
              borderColor: 'var(--joy-palette-primary-500)',
              boxShadow: '0 0 0 3px var(--joy-palette-primary-200)',
            },
          }}
          slotProps={{
            button: {
              sx: {
                whiteSpace: 'nowrap',
                justifyContent: 'center',
              },
            },
            listbox: {
              sx: {
                '& .MuiOption-root': {
                  justifyContent: 'center',
                  fontSize: '0.875rem',
                },
              },
            },
          }}
        >
          {options.map(opt => (
            <Option key={opt.value} value={opt.value}>
              {opt.label}
            </Option>
          ))}
        </Select>
      </Box>
    </Grid>
  );
};

interface SelectedModelDetailsProps {
  modelInfo: ModelInfo | null;
  model: ModelName;
  setLLM: (updates: Partial<LLMContextProps>) => void;
  setSpokenWords: (words: number) => void;
  historyLines: number;
  setHistoryLines: (lines: number) => void;
  isImageModel: (model: ModelName) => boolean;
  isKontextModel: boolean;
  priceTierInfo: { tier: string; variant: ChipVariant };
  maxTokens: number;
  maxContextWindow: number;
  getPriceTierTooltip: (tier: string) => string;
  metricsLoading: boolean;
  modelSpeed: ModelSpeed | null;
  getModelSpeedVariant: (speed: 'fast' | 'medium' | 'slow') => ChipVariant;
  getModelSpeedTooltip: (speed: 'fast' | 'medium' | 'slow') => string;
  INFINITE_VALUE: number;
  BFL_SAFETY_TOLERANCE: { DEFAULT: number; MIN: number; MAX: number };
  ImageModels: typeof ImageModels;
  tools: B4MLLMTools[];
  onRollDice: () => void;
  isMobile: boolean;
  max_tokens: number;
  temperature: number;
  handleTemperatureChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  spokenWords: number;
  liveAI: boolean;
  setLiveAI: (enabled: boolean) => void;
  stream: boolean;
  setStream: (enabled: boolean) => void;
  isQuestMasterFeatureEnabled: boolean;
  isQuestMasterEnabled: boolean;
  voiceOver: boolean;
  imageSettings: ImageSettingItem[];
  prompt_upsampling: boolean;
  safety_tolerance: number;
  commonTextTitleStyles: typeof commonTextTitleStyles;
  commonInputStyles: typeof commonInputStyles;
  commonSelectStyles: typeof commonSelectStyles;
  mode: 'dark' | 'light';
}

interface AdvancedAIModalProps {
  open: boolean;
  onClose: () => void;
  spokenWords: number;
  setSpokenWords: (words: number) => void;
  stream: boolean;
  setStream: (enabled: boolean) => void;
  voiceOver: boolean;
  onRollDice: () => void;
}

const ResetButton: React.FC<{
  modelInfo: ModelInfo;
  model: ModelName;
  setLLM: (updates: Partial<LLMContextProps>) => void;
  setSpokenWords: (words: number) => void;
  setHistoryLines: (lines: number) => void;
  isImageModel: (model: ModelName) => boolean;
  BFL_SAFETY_TOLERANCE: { DEFAULT: number; MIN: number; MAX: number };
  INFINITE_VALUE: number;
  ImageModels: typeof ImageModels;
  tooltip?: string;
  width?: string;
  height?: string;
  top?: string;
  right?: string;
}> = ({
  modelInfo,
  model,
  setLLM,
  setSpokenWords,
  setHistoryLines,
  isImageModel,
  BFL_SAFETY_TOLERANCE,
  INFINITE_VALUE,
  ImageModels,
  tooltip = 'Reset all settings to defaults',
  height = '32px',
}) => {
  const handleReset = () => {
    const defaultMaxTokens = computeDefaultMaxTokens(modelInfo);

    let quality: OpenAIImageQuality | undefined;

    if (!isImageModel(model)) {
      quality = undefined;
    } else if (model === ImageModels.GPT_IMAGE_1) {
      quality = 'low';
    } else {
      quality = 'standard';
    }

    setLLM({
      max_tokens: defaultMaxTokens,
      temperature: FIXED_TEMPERATURE_MODELS.has(model) ? 1.0 : 0.9,
      top_p: 1.0,
      size: isImageModel(model) ? '1024x1024' : undefined,
      quality,
      style: isImageModel(model) && model !== ImageModels.GPT_IMAGE_1 && !isBflImageModel(model) ? 'vivid' : undefined,
      seed: undefined,
      width: undefined,
      height: undefined,
      aspect_ratio: undefined,
      output_format: isImageModel(model) ? 'jpeg' : undefined,
      prompt_upsampling: isBflImageModel(model) ? false : undefined,
      safety_tolerance: isBflImageModel(model) ? BFL_SAFETY_TOLERANCE.DEFAULT : undefined,
    });
    setSpokenWords(200);
    setHistoryLines(INFINITE_VALUE);
  };
  return (
    <Tooltip title={tooltip}>
      <IconButton
        size="sm"
        variant="outlined"
        onClick={handleReset}
        sx={{
          p: 1,
          borderRadius: '6px',
          width: 'auto',
          height: `${height} !important`,
          minHeight: `${height} !important`,
          maxHeight: `${height} !important`,
          border: '1px solid',
          borderColor: 'var(--joy-palette-border-light)',
          '&:hover': {
            backgroundColor: 'primary.softHoverBg',
            borderColor: 'primary.main',
          },
        }}
      >
        <RestartAltIcon
          sx={{
            display: { xs: 'none', sm: 'block' },
            width: { xs: '12px', sm: '16px' },
            height: { xs: '12px', sm: '16px' },
            mr: { xs: 0, sm: 1 },
          }}
        />
        <Typography
          sx={{
            fontWeight: '400',
            fontSize: { xs: '12px', sm: '14px' },
            color: 'text.primary',
          }}
        >
          Reset
        </Typography>
      </IconButton>
    </Tooltip>
  );
};

// Catalog cutoffs are ISO dates whose day is always 01, i.e. month precision - so rendering
// the raw "2024-04-01" implies a day the data does not have.
const formatTrainingCutoff = (cutoff: string): string => {
  const parsed = dayjs(cutoff);
  return parsed.isValid() ? parsed.format('MMM YYYY') : cutoff;
};

// Larger than the model list's 24px: this screen has the room, and they are the only
// indicators on it rather than competing with a card's own controls.
const INDICATOR_SIZE = 32;

/**
 * Checked-state frame for the Advanced Settings checkboxes, matching the composer's Agent-mode
 * button: green border at 75% over a 10% green fill instead of Joy's solid green.
 *
 * Requires the checkbox to be pinned to `variant="outlined"` - Joy otherwise swaps to `solid`
 * on check, and these vars only feed the outlined variant. Set as CSS vars rather than
 * backgroundColor/borderColor because Joy resolves the variant through them, so a plain value
 * in sx is ignored. Keep in sync with AgentModeToggleButton.
 */
const AGENT_FRAME_CHECKBOX_SX = {
  '--variant-outlinedColor': green[800],
  '--variant-outlinedBorder': `${green[800]}BF`, // BF = 75%
  '--variant-outlinedHoverBorder': `${green[800]}BF`,
  '--variant-outlinedBg': greenAlpha[800][10],
  '--variant-outlinedHoverBg': greenAlpha[800][10],
  '--variant-outlinedActiveBg': greenAlpha[800][10],
  // Joy sizes the tick at --Checkbox-size, i.e. the full 20px box, leaving it edge to edge with
  // no breathing room inside the frame. The svg rule is not redundant: Joy's own icon reads the
  // var, but Stream passes a Material CheckIcon that ignores it.
  '--Icon-fontSize': '14px',
  '& svg': { fontSize: 'var(--Icon-fontSize)' },
} as const;

/**
 * Unchecked frame: the same border token the Reset button sitting beside these carries, so the
 * whole row reads as one set of controls, and the model list/grid card hover fill.
 *
 * The hover border is pinned to the resting value - Joy would otherwise tint it toward the
 * success palette on hover, which reads as a half-checked state. Active matches hover so a
 * click does not flash a third colour on the way to checked.
 */
const PLAIN_FRAME_CHECKBOX_SX = {
  '--variant-outlinedBorder': 'var(--joy-palette-border-light)',
  '--variant-outlinedHoverBorder': 'var(--joy-palette-border-light)',
  '--variant-outlinedHoverBg': 'var(--joy-palette-aiSettings-modelCard-hoverBackground)',
  '--variant-outlinedActiveBg': 'var(--joy-palette-aiSettings-modelCard-hoverBackground)',
} as const;

const SelectedModelDetails: React.FC<SelectedModelDetailsProps> = ({
  modelInfo,
  model,
  setLLM,
  setSpokenWords,
  setHistoryLines,
  historyLines,
  isImageModel,
  isKontextModel,
  priceTierInfo,
  maxTokens,
  maxContextWindow,
  getPriceTierTooltip,
  metricsLoading,
  modelSpeed,
  getModelSpeedVariant,
  getModelSpeedTooltip,
  INFINITE_VALUE,
  BFL_SAFETY_TOLERANCE,
  ImageModels,
  tools,
  onRollDice,
  isMobile,
  max_tokens,
  temperature,
  handleTemperatureChange,
  spokenWords,
  liveAI,
  setLiveAI,
  stream,
  setStream,
  isQuestMasterFeatureEnabled,
  isQuestMasterEnabled,
  voiceOver,
  imageSettings,
  prompt_upsampling,
  safety_tolerance,
  commonTextTitleStyles,
  commonInputStyles,
  commonSelectStyles,
  mode,
}) => {
  if (!modelInfo) return null;

  // Provider and capability notices, rendered as one stacked block below the description.
  const notices = [
    // Same test the picker groups by, so the notice can never disagree with the provider
    // section a model is filed under. A name-only check missed Sora.
    ...(getModelBackend(modelInfo) === 'OpenAI'
      ? ['This model shares session content with OpenAI for training purposes']
      : []),
    // The tools section is hidden outright for these models, so this line is the only
    // thing that explains the absence.
    ...(modelInfo.supportsTools ? [] : ['Selected AI model does not support tools']),
  ];

  return (
    <>
      {/* Selected Model Details */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          flexDirection: 'column',
        }}
      >
        {/* Chips and notices; the title, description and reset live in the dialog header */}
        <Box sx={{ width: '100%' }}>
          {notices.length > 0 && (
            <Stack direction="column" gap="4px" sx={{ mt: '16px' }}>
              {notices.map(notice => (
                <Typography
                  key={notice}
                  level="body-xs"
                  sx={{
                    color: brand[800],
                    fontSize: '14px',
                    fontWeight: '500',
                  }}
                >
                  {notice}
                </Typography>
              ))}
            </Stack>
          )}

          {/* Specs then capabilities in one run. The editable Input/Output controls live in the
              token allocation section below, so the numbers here state the model's own limits.
              Indicators are the same components as the model list, so the glyphs carry over. */}
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center" sx={{ mt: 2 }}>
            {modelInfo.trainingCutoff && (
              <SpecPill
                label="Cutoff"
                value={formatTrainingCutoff(modelInfo.trainingCutoff)}
                tooltip="Model knowledge cutoff - the model has no awareness of events after this date"
                size={INDICATOR_SIZE}
                filled
              />
            )}
            {/* Abbreviated to match the cards; the tooltips carry the exact figures, which the
                abbreviation cannot always represent (most values are powers of two). */}
            <SpecPill
              label="ctx"
              value={formatContextWindow(modelInfo.contextWindow)}
              tooltip={`${formatNumber(modelInfo.contextWindow)} token context window`}
              size={INDICATOR_SIZE}
              filled
            />
            <SpecPill
              label="max"
              value={formatContextWindow(modelInfo.max_tokens)}
              tooltip={`${formatNumber(modelInfo.max_tokens)} maximum output tokens`}
              size={INDICATOR_SIZE}
              filled
            />

            {modelInfo.disabled ? (
              <MetadataChip
                label="Unavailable"
                mode={mode}
                variant="red"
                tooltip={modelInfo.disabledReason ?? 'This model is currently unavailable'}
              />
            ) : (
              <>
                <MetricIndicators
                  priceTier={priceTierInfo}
                  modelSpeed={modelSpeed}
                  statsLoading={metricsLoading}
                  size={INDICATOR_SIZE}
                  filled
                />
                <CapabilityIndicators model={modelInfo} size={INDICATOR_SIZE} filled />
              </>
            )}
          </Stack>
        </Box>
      </Box>

      <Divider
        sx={{
          backgroundColor: grayAlpha[150][20],
          width: '100%',
          px: 4,
          height: '1px',
          mx: 'auto',
          my: '28px',
        }}
      />

      {/* Tool Components. Hidden for models that cannot run tools - the notice above the specs
          carries that message here, so ToolsSection's own centered placeholder would duplicate
          it. The placeholder stays in place for the composer's tools dropdown, which has no
          other surface to say it on. */}
      {modelInfo.supportsTools && (
        <>
          <ToolsSection
            tools={tools}
            setTools={newTools => setLLM({ tools: newTools })}
            model={model}
            onRollDice={onRollDice}
            columns={isMobile ? 1 : 2}
          />
          <Divider
            sx={{
              backgroundColor: grayAlpha[150][20],
              width: '100%',
              height: '1px',
              mx: 'auto',
              my: '28px',
            }}
          />
        </>
      )}

      {/* Advanced Settings */}
      <Box sx={{ p: 0 }}>
        <Grid
          container
          spacing={1}
          sx={{
            flexGrow: 1,
            display: 'flex',
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            mb: 2,
          }}
        >
          <Typography level="body-sm" sx={commonTextTitleStyles}>
            Advanced Settings
          </Typography>
          {/* Core Tools */}
          <Box
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '20px',
              mb: 0,
              alignItems: 'center',
              fontSize: '14px',
            }}
          >
            {/* Label before control throughout, matching the Smart tools and Research Mode
                toggles. */}
            {/* AI Toggle */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
              <Typography level="body-sm" sx={{ flexGrow: 0 }}>
                AI
              </Typography>
              <Checkbox
                checked={liveAI}
                onChange={() => setLiveAI(!liveAI)}
                disabled={voiceOver}
                title="Use AI"
                color="success"
                variant="outlined"
                sx={liveAI ? AGENT_FRAME_CHECKBOX_SX : PLAIN_FRAME_CHECKBOX_SX}
              />
            </Box>

            {/* Stream Toggle */}
            {!isImageModel(model) && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                <Typography level="body-sm" sx={{ flexGrow: 0 }}>
                  Stream
                </Typography>
                <Checkbox
                  checkedIcon={<CheckIcon sx={{ color: 'success.main' }} />}
                  checked={stream}
                  onChange={() => setStream(!stream)}
                  disabled={voiceOver}
                  title={stream ? 'Streaming responses' : 'Not streaming'}
                  color="success"
                  variant="outlined"
                  sx={stream ? AGENT_FRAME_CHECKBOX_SX : PLAIN_FRAME_CHECKBOX_SX}
                />
              </Box>
            )}

            {/* Quest Master Toggle */}
            {isQuestMasterFeatureEnabled && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                <Typography level="body-sm" sx={{ flexGrow: 0 }}>
                  Quest Master
                </Typography>
                {/* Wraps the control alone. Around the whole pair it fired from the label too and
                    centred itself across both, which read as belonging to neither. The native
                    `title` came off the checkbox with it - it duplicated this one. */}
                <Tooltip title="Enable Quest Master">
                  <Checkbox
                    checked={isQuestMasterEnabled}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setLLM({ isQuestMasterEnabled: e.target.checked })
                    }
                    color="success"
                    variant="outlined"
                    sx={isQuestMasterEnabled ? AGENT_FRAME_CHECKBOX_SX : PLAIN_FRAME_CHECKBOX_SX}
                  />
                </Tooltip>
              </Box>
            )}

            {/* Sits with the controls it resets. Everything handleReset touches - the token
                allocation below, temperature, spoken words, response history - lives in this
                section; tools are deliberately not among them, which is why this is not a
                whole-dialog reset. */}
            <ResetButton
              modelInfo={modelInfo}
              model={model}
              setLLM={setLLM}
              setSpokenWords={setSpokenWords}
              setHistoryLines={setHistoryLines}
              isImageModel={isImageModel}
              BFL_SAFETY_TOLERANCE={BFL_SAFETY_TOLERANCE}
              INFINITE_VALUE={INFINITE_VALUE}
              ImageModels={ImageModels}
              tooltip="Reset advanced settings (temperature, tokens, spoken words, response history) to defaults"
            />
          </Box>
        </Grid>

        {/* An output-token budget only means something for chat models. Image, video and
            transcription entries carry placeholder context values in the catalog (every Flux and
            gpt-image row is a flat 10000/10000), so the slider edited a number nothing reads.
            Gated on the catalog's own type rather than isImageModel(), which name-matches a
            hardcoded list and would read the selected model instead of the one on screen.

            Also hidden while previewing a model you have not selected: max_tokens is a single
            global value belonging to the active model, so pairing it with a previewed model's
            contextWindow renders a split that is not real - Input can even go negative, and the
            slider's value can fall outside its own max. "Use this model" brings it back. */}
        {modelInfo.type === 'text' && modelInfo.id === model && (
          <Box sx={{ p: 0, mb: '28px' }}>
            <Box
              sx={{
                display: isMobile ? 'block' : 'flex',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '20px',
              }}
            >
              {/* Context */}
              <Box sx={{ display: 'flex', mb: { xs: 2, sm: 0 }, alignItems: 'center', gap: '3px', flexShrink: 0 }}>
                <Typography level="body-sm" sx={commonTextTitleStyles}>
                  Context -{' '}
                </Typography>
                <Typography
                  level="body-sm"
                  sx={{ fontWeight: 'bold', color: brand[800], fontSize: '16px', whiteSpace: 'nowrap' }}
                >
                  {(modelInfo?.contextWindow ?? 0).toLocaleString().replace(/,/g, ' ')}
                </Typography>
              </Box>

              {/* Input */}
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '20px' }}>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    justifyContent: { xs: 'flex-start', sm: 'flex-end' },
                  }}
                >
                  <Typography level="body-sm">Input</Typography>
                  <FieldTooltip
                    ariaLabel="Help: Input tokens"
                    content={FIELD_TOOLTIPS.maxTokensInput}
                    data-testid="field-tooltip-input-tokens"
                  />
                  <Input
                    size="sm"
                    variant="outlined"
                    value={((modelInfo?.contextWindow ?? 0) - (max_tokens ?? 4096)).toLocaleString().replace(/,/g, ' ')}
                    sx={{
                      ...commonInputStyles(mode || 'light'),
                      fontSize: { xs: '12px', sm: '14px' },
                      width: { xs: '80px', sm: 'auto' },
                    }}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      const rawValue = e.target.value.replace(/\s/g, '');
                      const inputTokens = parseInt(rawValue, 10);
                      if (!isNaN(inputTokens) && inputTokens >= 0) {
                        const contextWindow = modelInfo?.contextWindow ?? 0;
                        const newMaxTokens = Math.max(
                          4096,
                          Math.min(contextWindow - inputTokens, modelInfo?.max_tokens ?? 16384)
                        );
                        setLLM({ max_tokens: newMaxTokens });
                      }
                    }}
                  />
                </Box>

                {/* Output */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography level="body-sm">Output</Typography>
                  <FieldTooltip
                    ariaLabel="Help: Output tokens"
                    content={FIELD_TOOLTIPS.maxTokensOutput}
                    data-testid="field-tooltip-output-tokens"
                  />
                  <Input
                    size="sm"
                    variant="outlined"
                    value={(max_tokens ?? 4096).toLocaleString().replace(/,/g, ' ')}
                    sx={{
                      ...commonInputStyles(mode || 'light'),
                      fontSize: { xs: '12px', sm: '14px' },
                      width: { xs: '80px', sm: 'auto' },
                    }}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      const rawValue = e.target.value.replace(/\s/g, '');
                      const outputTokens = parseInt(rawValue, 10);
                      if (
                        !isNaN(outputTokens) &&
                        outputTokens >= 4096 &&
                        outputTokens <= (modelInfo?.max_tokens ?? 16384)
                      ) {
                        setLLM({ max_tokens: outputTokens });
                      }
                    }}
                  />
                </Box>
              </Box>
            </Box>
            <Box sx={{ position: 'relative', width: '100%', marginBottom: '-20px' }}>
              <Slider
                aria-label="Token Allocation"
                value={max_tokens ?? Math.min(4096, Math.floor((modelInfo?.contextWindow ?? 8192) / 2))}
                min={Math.max(1024, Math.min(2048, Math.floor((modelInfo?.contextWindow ?? 8192) / 4)))}
                max={modelInfo?.max_tokens ?? 16384}
                step={256}
                onChange={(_, newValue) => {
                  if (typeof newValue === 'number') {
                    setLLM({ max_tokens: newValue });
                  }
                }}
                disableSwap
                valueLabelDisplay="auto"
                valueLabelFormat={value => `${value.toLocaleString().replace(/,/g, ' ')}`}
                sx={{
                  '--Slider-trackSize': '8px',
                  '--Slider-thumbSize': '16px',
                  '--Slider-thumbWidth': '16px',
                  '--Slider-valueLabelArrowSize': '10px',
                  width: '100%',
                  '& .MuiSlider-mark': {
                    display: 'none',
                  },
                  '& .MuiSlider-markLabel': {
                    display: 'none',
                  },
                  '& .MuiSlider-track': {
                    backgroundColor: 'primary.main',
                  },
                  '& .MuiSlider-thumb': {
                    backgroundColor: 'primary.main',
                  },
                }}
              />
            </Box>
          </Box>
        )}

        {/* GPT-Image-1 Model Info */}
        {model === ImageModels.GPT_IMAGE_1 && (
          <Typography
            level="body-xs"
            sx={{
              color: brand[800],
              fontSize: '14px',
              fontWeight: '500',
              mt: 2,
              mb: 2,
            }}
          >
            This model has specific parameter constraints. Some settings like Style are not available, and invalid
            parameters will be automatically adjusted to compatible values.
          </Typography>
        )}

        {/* Kontext Model Info */}
        {isKontextModel && (
          <Typography
            level="body-xs"
            sx={{
              color: brand[800],
              fontSize: '14px',
              fontWeight: '500',
              mt: 2,
              mb: 2,
            }}
          >
            This model transforms existing images. Either upload an image to the workbench or use a recently generated
            image from this conversation, then describe how you want it changed.
          </Typography>
        )}

        {/* Temperature and Randomness Settings */}
        <Grid container spacing={2} sx={{ fontSize: '14px' }}>
          {/* Temperature - hidden for models that reject the parameter */}
          {!NO_TEMPERATURE_MODELS.has(model) && (
            <Grid xs={12} md={6}>
              <Box
                sx={{
                  display: 'flex',
                  justifyContent: { xs: 'flex-start', sm: 'flex-end' },
                  alignItems: 'center',
                  pb: { xs: 0, sm: 2 },
                  gap: '20px',
                }}
              >
                <Box
                  sx={{
                    flex: { xs: '1 1 0%', sm: '0 0 auto' },
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.5,
                  }}
                >
                  <Typography level="body-sm">Temperature</Typography>
                  <FieldTooltip
                    ariaLabel="Help: Temperature"
                    content={
                      FIXED_TEMPERATURE_MODELS.has(model) ? FIELD_TOOLTIPS.fixedTemperature : FIELD_TOOLTIPS.temperature
                    }
                    data-testid="field-tooltip-temperature"
                  />
                </Box>
                <Input
                  sx={{
                    ...commonInputStyles(mode || 'light'),
                    flex: { xs: '1 1 0%', sm: '0 0 auto' },
                  }}
                  size="sm"
                  variant="outlined"
                  color="primary"
                  type="number"
                  value={FIXED_TEMPERATURE_MODELS.has(model) ? 1.0 : temperature}
                  onChange={handleTemperatureChange}
                  disabled={FIXED_TEMPERATURE_MODELS.has(model)}
                  slotProps={{
                    input: {
                      min: 0,
                      max: 2,
                      step: 0.1,
                    },
                  }}
                />
              </Box>
            </Grid>
          )}

          {!isImageModel(model) && (
            <Grid xs={12} md={6}>
              <Grid
                xs={6}
                sx={{
                  display: 'flex',
                  gap: '20px',
                  alignItems: 'center',
                  justifyContent: { xs: 'flex-start', sm: 'flex-end' },
                }}
              >
                <Box
                  sx={{
                    flex: { xs: '1 1 0%', sm: '0 0 auto' },
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.5,
                  }}
                >
                  <Typography level="body-sm">Response History</Typography>
                  <FieldTooltip
                    ariaLabel="Help: Response History"
                    content={FIELD_TOOLTIPS.responseHistory}
                    data-testid="field-tooltip-response-history"
                  />
                </Box>
                <Select
                  value={historyLines}
                  onChange={(_, newValue) => newValue && setHistoryLines(Number(newValue))}
                  indicator={<KeyboardArrowDownIcon />}
                  sx={{
                    ...commonInputStyles(mode || 'light'),
                    minWidth: { xs: 'auto', sm: '6rem' },
                    height: 32,
                    p: 1,
                    flex: { xs: '1 1 0%', sm: '0 0 auto' },
                    '& .MuiSelect-button': {
                      textAlign: 'center',
                      paddingBlock: '4px',
                      fontSize: '0.875rem',
                    },
                    '& .MuiSelect-indicator': {
                      color: 'var(--joy-palette-text-tertiary)',
                      transition: '0.2s',
                      width: '20px',
                      height: '20px',
                    },
                    '& .MuiSelect-endDecorator': {
                      marginRight: '4px',
                    },
                    '&[aria-expanded="true"] .MuiSelect-indicator': {
                      transform: 'rotate(180deg)',
                    },
                    '&:hover': {
                      borderColor: 'var(--joy-palette-neutral-400)',
                    },
                    '&.Mui-focused': {
                      borderColor: 'var(--joy-palette-primary-500)',
                      boxShadow: '0 0 0 3px var(--joy-palette-primary-200)',
                    },
                  }}
                  slotProps={{
                    button: {
                      sx: {
                        whiteSpace: 'nowrap',
                        justifyContent: 'center',
                      },
                    },
                    listbox: {
                      sx: {
                        '& .MuiOption-root': {
                          justifyContent: 'center',
                          fontSize: '0.875rem',
                        },
                      },
                    },
                  }}
                >
                  <Option value={1}>1</Option>
                  <Option value={2}>2</Option>
                  <Option value={3}>3</Option>
                  <Option value={5}>5</Option>
                  <Option value={8}>8</Option>
                  <Option value={13}>13</Option>
                  <Option value={21}>21</Option>
                  <Option value={34}>34</Option>
                  <Option value={INFINITE_VALUE}>∞</Option>
                </Select>
              </Grid>
            </Grid>
          )}

          {/* Spoken Words */}
          <Grid xs={12} md={6}>
            <Box
              sx={{
                display: 'flex',
                justifyContent: { xs: 'flex-start', sm: 'flex-end' },
                alignItems: 'center',
                gap: '20px',
              }}
            >
              <Tooltip title="Maximum number of words to speak in voice responses">
                <Typography level="body-sm" sx={{ textAlign: 'left', flex: { xs: '1 1 0%', sm: '0 0 auto' } }}>
                  Spoken Words
                </Typography>
              </Tooltip>
              <Input
                sx={{
                  ...commonInputStyles(mode || 'light'),
                  flex: { xs: '1 1 0%', sm: '0 0 auto' },
                }}
                size="sm"
                variant="outlined"
                color="primary"
                type="number"
                value={spokenWords}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const value = parseInt(e.target.value);
                  if (!isNaN(value) && value >= 0) {
                    setSpokenWords(value);
                  }
                }}
                slotProps={{
                  input: {
                    min: 0,
                    step: 10,
                  },
                }}
              />
            </Box>
          </Grid>

          {/* Reasoning Effort - only for reasoning-capable models */}
          {REASONING_SUPPORTED_MODELS.has(model) && (
            <ReasoningEffortSelector model={model} commonInputStyles={commonInputStyles} mode={mode} />
          )}
        </Grid>
      </Box>

      {/* Image Model Settings, with the Templates panel below */}
      {isImageModel(model) && (
        <>
          <Grid container spacing={2} sx={{ px: 1, mb: 2 }}>
            {imageSettings.map(setting => (
              <Grid key={setting.label} xs={12} md={6}>
                <Box
                  sx={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    gap: '20px',
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Typography level="body-sm">{setting.label}</Typography>
                    {setting.tooltip && <FieldTooltip ariaLabel={`Help: ${setting.label}`} content={setting.tooltip} />}
                  </Box>
                  <Box sx={{ minWidth: '120px' }}>
                    {setting.type === 'select' && (
                      <Select
                        value={setting.value}
                        onChange={(_, newValue) => setting.onChange(newValue)}
                        indicator={<KeyboardArrowDownIcon />}
                        sx={commonSelectStyles(mode || 'light')}
                      >
                        {setting.options?.map(option => (
                          <Option key={option.value} value={option.value}>
                            {option.label}
                          </Option>
                        ))}
                      </Select>
                    )}
                    {setting.type === 'input' && (
                      <Input
                        sx={commonInputStyles(mode || 'light')}
                        size="sm"
                        variant="outlined"
                        color="primary"
                        value={setting.value}
                        {...setting.inputProps}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                          const value = e.target.value === '' ? undefined : parseInt(e.target.value);
                          if (value !== undefined) {
                            setting.onChange(value);
                          }
                        }}
                      />
                    )}
                  </Box>
                </Box>
              </Grid>
            ))}
            {isBflImageModel(model) && (
              <>
                <Grid xs={12} md={6}>
                  <Box
                    sx={{
                      display: 'flex',
                      justifyContent: 'flex-end',
                      alignItems: 'center',
                      gap: '20px',
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Typography level="body-sm" sx={{ textAlign: 'right' }}>
                        Prompt Upsampling
                      </Typography>
                      <FieldTooltip ariaLabel="Help: Prompt Upsampling" content={FIELD_TOOLTIPS.promptEnhancement} />
                    </Box>
                    <Box sx={{ minWidth: '120px' }}>
                      <Switch
                        checked={prompt_upsampling ?? false}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setLLM({ prompt_upsampling: e.target.checked })
                        }
                        color={prompt_upsampling ? 'success' : 'neutral'}
                      />
                    </Box>
                  </Box>
                </Grid>
                <Grid xs={12} md={6}>
                  <Box
                    sx={{
                      display: 'flex',
                      justifyContent: 'flex-end',
                      alignItems: 'center',
                      gap: '20px',
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Typography level="body-sm" sx={{ textAlign: 'right' }}>
                        Safety Tolerance: {safety_tolerance ?? BFL_SAFETY_TOLERANCE.DEFAULT}
                      </Typography>
                      <FieldTooltip ariaLabel="Help: Safety Tolerance" content={FIELD_TOOLTIPS.safetyTolerance} />
                    </Box>
                    <Box sx={{ minWidth: '120px' }}>
                      <Input
                        sx={commonInputStyles(mode || 'light')}
                        size="sm"
                        variant="outlined"
                        color="primary"
                        type="number"
                        value={safety_tolerance ?? BFL_SAFETY_TOLERANCE.DEFAULT}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setLLM({ safety_tolerance: parseInt(e.target.value) })
                        }
                        slotProps={{
                          input: {
                            min: BFL_SAFETY_TOLERANCE.MIN,
                            max: BFL_SAFETY_TOLERANCE.MAX,
                            step: 1,
                          },
                        }}
                      />
                    </Box>
                  </Box>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, pt: 2 }}>
                    <Box
                      sx={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        px: 1,
                      }}
                    >
                      <Typography level="body-xs" sx={{ color: 'text.secondary', fontWeight: 500 }}>
                        🛡️ Family-friendly
                      </Typography>
                      <Typography level="body-xs" sx={{ color: 'text.secondary', fontWeight: 500 }}>
                        🌶️ Creative & Spicy
                      </Typography>
                    </Box>
                    <Slider
                      aria-label="Safety Tolerance"
                      value={safety_tolerance ?? BFL_SAFETY_TOLERANCE.DEFAULT}
                      min={BFL_SAFETY_TOLERANCE.MIN}
                      max={BFL_SAFETY_TOLERANCE.MAX}
                      step={1}
                      onChange={(_, newValue) => {
                        if (typeof newValue === 'number') {
                          setLLM({ safety_tolerance: newValue });
                        }
                      }}
                      valueLabelDisplay="auto"
                      marks={[
                        { value: 0, label: '🛡️ Safe' },
                        { value: 2, label: '📝 Mild' },
                        { value: 4, label: '🎨 Balanced' },
                        { value: 6, label: '🌶️ Spicy' },
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
                        '& .MuiSlider-markLabel': {
                          fontSize: '0.75rem',
                          fontWeight: 500,
                          marginTop: '8px',
                        },
                      }}
                    />
                  </Box>
                </Grid>
              </>
            )}
          </Grid>
          <ImageTemplatePanel />
        </>
      )}

      {/* Bottom padding to match left panel spacing */}
      <Box sx={{ pb: 4 }} />
    </>
  );
};

// Renders the full-width model list. Per-model details open in a separate
// responsive dialog via onViewDetails.
const AISettingsTab: React.FC<{
  model: ModelName;
  handleModelSelection: (model: ModelName) => void;
  onSelectionComplete: () => void;
  modelFilter: 'all' | 'text' | 'image' | 'video';
  handleModelChange: (filter: 'all' | 'text' | 'image' | 'video') => void;
  isMobile: boolean;
  onViewDetails: (model: ModelInfo) => void;
}> = ({
  model,
  handleModelSelection,
  onSelectionComplete,
  modelFilter,
  handleModelChange,
  isMobile,
  onViewDetails,
}) => {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        // Widen past the modal's 24px padding so the scrollbar rides ~4px from the window
        // edge instead of cutting through the header icons. The content inset comes from
        // ModelSelection's own pr, not from here.
        width: { xs: '100%', sm: 'calc(100% + 20px)' },
        height: '100%',
        ...scrollbarStyles,
        '&::-webkit-scrollbar-track': {
          background: 'transparent',
        },
      }}
    >
      <ModelSelection
        model={model}
        setModel={handleModelSelection}
        onSelectionComplete={onSelectionComplete}
        imageModel={modelFilter === 'image'}
        showAllModels={modelFilter === 'all'}
        modelFilter={modelFilter}
        onModelFilterChange={handleModelChange}
        onSettingsClick={onViewDetails}
        stickyHeader={
          !isMobile && (
            <TabIntro
              title="AI Settings"
              description="Choose an AI model, then open its settings to tune it to your needs."
            />
          )
        }
      />
    </Box>
  );
};

const ResearchModeTab: React.FC<{
  researchMode: ResearchModeState;
  setLLM: (updates: Partial<LLMContextProps>) => void;
  addResearchConfiguration: (config: ResearchModeConfiguration) => void;
  updateResearchConfiguration: (id: string, updates: Partial<ResearchModeConfiguration>) => void;
  removeResearchConfiguration: (id: string) => void;
  modelInfoRepo: ModelInfo[] | null;
  model: ModelName;
  temperature: number;
  max_tokens: number;
  top_p: number;
}> = ({
  researchMode,
  setLLM,
  addResearchConfiguration,
  updateResearchConfiguration,
  removeResearchConfiguration,
  modelInfoRepo,
  model,
  temperature,
  max_tokens,
  top_p,
}) => {
  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        px: 0,
      }}
    >
      {/* Research Mode Header */}
      <Box sx={{ mb: 3 }}>
        <Box
          sx={{
            mt: '20px',
            mb: 2,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            flexDirection: { xs: 'column', md: 'row' },
            gap: { xs: 2, md: 4 },
          }}
        >
          <TabIntro
            title="Research Mode"
            description="Run the same prompt against up to four model/parameter configurations side-by-side. Token usage scales with the number of configurations."
            titleAdornment={
              <ContextHelpButton
                helpId="features/research-mode"
                tooltipText="Learn about Research Mode"
                size="sm"
                sx={HEADER_ICON_BUTTON_SX}
              />
            }
            mt={0}
          />

          <Stack
            direction="row"
            alignItems="center"
            spacing="12px"
            justifyContent={{ xs: 'flex-start', md: 'center' }}
            sx={{
              width: { xs: '100%', md: 'auto' },
              flexShrink: 0,
            }}
          >
            <Typography level="title-sm" sx={{ fontWeight: 'normal', fontSize: '14px', textAlign: 'right' }}>
              Enable
            </Typography>
            <SquareSlideToggle
              checked={researchMode.enabled}
              onChange={e => setLLM({ researchMode: { ...researchMode, enabled: e.target.checked } })}
            />
          </Stack>
        </Box>

        {/* Cost estimation for Research Mode */}
        {researchMode.configurations.length > 0 && researchMode.enabled && (
          <Typography
            level="body-xs"
            sx={{
              color: brand[800],
              fontSize: '14px',
              fontWeight: '500',
              mt: 1,
            }}
          >
            This will send your prompt to {researchMode.configurations.length} different models/configurations
            simultaneously. <br />
            Token usage will be approximately {researchMode.configurations.length}x higher than a single request.
          </Typography>
        )}
      </Box>

      {/* Research Mode Configurations */}
      {researchMode.enabled && (
        <Grid container spacing={2}>
          {[0, 1, 2, 3].map(index => {
            const config = researchMode.configurations[index];
            return (
              <Grid key={index} xs={12} md={6}>
                <ResearchConfigPanel
                  index={index}
                  config={config}
                  onUpdate={updates => {
                    if (config) {
                      // If model is being updated, also update the label
                      if (updates.model) {
                        const newModelInfo = modelInfoRepo?.find(m => m.id === updates.model);
                        updates.label = newModelInfo?.name || updates.model;
                      }
                      updateResearchConfiguration(config.id, updates);
                    } else {
                      const selectedModel = (updates.model || model) as ChatModelName;
                      const modelInfo = modelInfoRepo?.find(m => m.id === selectedModel);
                      addResearchConfiguration({
                        id: 'research-config-' + Date.now() + Math.random(),
                        enabled: true,
                        model: selectedModel,
                        parameters: {
                          temperature: temperature,
                          maxTokens: max_tokens,
                          topP: top_p,
                        },
                        label: modelInfo?.name || selectedModel || `Config ${index + 1}`,
                        ...updates,
                      });
                    }
                  }}
                  onRemove={() => config && removeResearchConfiguration(config.id)}
                />
              </Grid>
            );
          })}
        </Grid>
      )}

      {/* Bottom padding */}
      <Box sx={{ pb: 4 }} />
    </Box>
  );
};

export const AdvancedAIModal: React.FC<AdvancedAIModalProps> = ({
  open,
  onClose,
  spokenWords,
  setSpokenWords,
  stream,
  setStream,
  voiceOver,
  onRollDice,
}) => {
  const theme = useTheme();
  const mode = theme.palette.mode;
  const isMobile = useIsMobile();

  const [
    activeTab,
    setActiveTab,
    liveAI,
    setLiveAI,
    historyLines,
    setHistoryLines,
    modelDetailsOpen,
    setModelDetailsOpen,
  ] = useAdvancedAISettings(
    useShallow(state => [
      state.activeTab,
      state.setActiveTab,
      state.liveAI,
      state.setLiveAI,
      state.historyLines,
      state.setHistoryLines,
      state.modelDetailsOpen,
      state.setModelDetailsOpen,
    ])
  );

  const { setState: setLLM } = useLLM;
  const researchMode = useLLM(state => state.researchMode);
  const { addResearchConfiguration, removeResearchConfiguration, updateResearchConfiguration } = useLLM(
    useShallow(s => ({
      addResearchConfiguration: s.addResearchConfiguration,
      removeResearchConfiguration: s.removeResearchConfiguration,
      updateResearchConfiguration: s.updateResearchConfiguration,
    }))
  );
  const tools = useLLM(state => state.tools);

  const [
    model,
    temperature,
    max_tokens,
    size,
    quality,
    style,
    isQuestMasterEnabled,
    safety_tolerance,
    prompt_upsampling,
    seed,
    output_format,
    width,
    height,
    aspect_ratio,
    top_p,
  ] = useLLM(
    useShallow(s => [
      s.model,
      s.temperature,
      s.max_tokens,
      s.size,
      s.quality,
      s.style,
      s.isQuestMasterEnabled,
      s.safety_tolerance,
      s.prompt_upsampling,
      s.seed,
      s.output_format,
      s.width,
      s.height,
      s.aspect_ratio,
      s.top_p,
    ])
  );

  const typedModel = model as ModelName;
  const safeTemperature = temperature ?? 0;
  const safeMaxTokens = max_tokens ?? 4096;
  const safeTopP = top_p ?? 1;
  const safePromptUpsampling = prompt_upsampling ?? false;
  const safeSafetyTolerance = safety_tolerance ?? 0;

  const { isFeatureEnabled } = useFeatureEnabled();
  const isQuestMasterFeatureEnabled = isFeatureEnabled('enableQuestMaster');

  const { data: modelInfoRepo } = useModelInfo();
  const modelInfo = useMemo(() => {
    if (!modelInfoRepo || !model) return null;
    return modelInfoRepo.find(m => m.id === model) ?? null;
  }, [model, modelInfoRepo]);

  const { currentSessionId } = useSessions();

  const { data: stats, isLoading: metricsLoading } = useModelStats();

  const { settings: userSettings } = useUserSettings();

  const modelSpeed = getModelSpeedFromStats(modelInfo?.id ?? '', stats?.avgResponseTime ?? {});
  const isResearchModeFeatureEnabled = userSettings.experimentalFeatures?.enableResearchMode === true;

  const isKontextModel = isKontextImageModel(model);

  const { maxContextWindow, maxTokens } = useMemo(() => {
    if (!modelInfoRepo) return { maxContextWindow: 0, maxTokens: 0 };
    let maxCtx = 0;
    let maxTok = 0;
    modelInfoRepo.forEach(m => {
      if (m.contextWindow > maxCtx) maxCtx = m.contextWindow;
      if (m.max_tokens > maxTok) maxTok = m.max_tokens;
    });
    return { maxContextWindow: maxCtx, maxTokens: maxTok };
  }, [modelInfoRepo]);

  const priceTierInfo: { tier: string; variant: ChipVariant } = modelInfo
    ? getModelPriceTier(modelInfo)
    : { tier: 'Low', variant: 'green' };

  const handleModelSelection = useCallback(
    (newModel: ModelName) => {
      if (newModel === model) return;
      const newModelInfo = modelInfoRepo?.find(m => m.id === newModel);
      if (newModelInfo) {
        startTransition(() => {
          setLLM(buildModelSelectionPatch(newModelInfo));
        });
        if (currentSessionId) {
          void updateSessionToServer({ id: currentSessionId, lastUsedModel: newModel }).catch(err =>
            console.error('Failed to persist model selection:', err)
          );
        }
      }
    },
    [modelInfoRepo, model, setLLM, currentSessionId]
  );

  const handleTemperatureChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setLLM({ temperature: parseFloat(event.target.value) });
    },
    [setLLM]
  );

  const [modelFilter, setModelFilter] = useState<'all' | 'text' | 'image' | 'video'>(() =>
    isImageModel(model) ? 'image' : 'text'
  );
  // Auto-switch to the correct tab when the modal opens
  useEffect(() => {
    if (open) {
      setModelFilter(isImageModel(model) ? 'image' : 'text');
    }
  }, [open, model]);
  const handleModelChange = useCallback((value: 'all' | 'text' | 'image' | 'video') => {
    setModelFilter(value);
  }, []);

  const imageSettings = useMemo(
    () => [
      ...(isKontextModel
        ? []
        : [
            {
              label: 'Image Size',
              type: 'select' as const,
              value: size || IMAGE_SIZE_CONSTRAINTS[getModelConstraintKey(model)].defaultSize,
              onChange: (value: OpenAIImageSize | null) => value && setLLM({ size: value }),
              options: getAvailableSizes(model).map(s => ({ value: s, label: s })),
              tooltip: FIELD_TOOLTIPS.imageSize,
            },
          ]),
      {
        label: 'Quality',
        tooltip: FIELD_TOOLTIPS.imageQuality,
        type: 'select' as const,
        value: quality,
        onChange: (value: OpenAIImageQuality | null) => value && setLLM({ quality: value }),
        options:
          model === ImageModels.GPT_IMAGE_1
            ? [
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
              ]
            : [
                { value: 'standard', label: 'Standard' },
                { value: 'hd', label: 'HD' },
              ],
      },
      ...(model !== ImageModels.GPT_IMAGE_1 && !isBflImageModel(model)
        ? [
            {
              label: 'Style',
              type: 'select' as const,
              value: style,
              onChange: (value: OpenAIImageStyle | null) => value && setLLM({ style: value }),
              options: [
                { value: 'vivid', label: 'Vivid' },
                { value: 'natural', label: 'Natural' },
              ],
            },
          ]
        : []),
      {
        label: 'Seed',
        type: 'input' as const,
        value: seed?.toString() ?? '',
        onChange: (value: number | null) => setLLM({ seed: value }),
        tooltip: FIELD_TOOLTIPS.imageSeed,
        inputProps: { type: 'number', placeholder: 'Random' },
      },
      // Width/Height are BFL-specific parameters; GPT Image models use the Image Size dropdown instead
      ...(!isKontextModel && isBflImageModel(model)
        ? [
            {
              label: 'Width',
              type: 'input' as const,
              value: width?.toString() ?? '',
              onChange: (value: number | undefined) => setLLM({ width: value }),
              tooltip: 'Custom width in pixels (BFL models only)',
              inputProps: {
                type: 'number',
                placeholder: 'Auto',
                slotProps: { input: { min: 256, max: 4096, step: 8 } },
              },
            },
            {
              label: 'Height',
              type: 'input' as const,
              value: height?.toString() ?? '',
              onChange: (value: number | undefined) => setLLM({ height: value }),
              tooltip: 'Custom height in pixels (BFL models only)',
              inputProps: {
                type: 'number',
                placeholder: 'Auto',
                slotProps: { input: { min: 256, max: 4096, step: 8 } },
              },
            },
          ]
        : []),
      {
        label: 'Aspect Ratio',
        type: 'select' as const,
        value: aspect_ratio?.toString() ?? '',
        onChange: (value: string | null) => setLLM({ aspect_ratio: value ? value : undefined }),
        tooltip: FIELD_TOOLTIPS.aspectRatio,
        options: [
          { value: '', label: 'Auto' },
          { value: '16:9', label: '16:9' },
          { value: '4:3', label: '4:3' },
          { value: '1:1', label: '1:1' },
          { value: '3:4', label: '3:4' },
          { value: '9:16', label: '9:16' },
        ],
      },
      {
        label: 'Output Format',
        type: 'select' as const,
        value: (output_format ?? 'jpeg') as 'jpeg' | 'png',
        onChange: (value: 'jpeg' | 'png' | null) => value && setLLM({ output_format: value }),
        options: [
          { value: 'jpeg', label: 'JPEG' },
          { value: 'png', label: 'PNG' },
        ],
      },
    ],
    [model, isKontextModel, size, quality, style, seed, width, height, aspect_ratio, output_format, setLLM]
  );

  // Model detail dialog. `modelDetailsOpen` is lifted to the shared store so the
  // composer Templates button can open it directly; `detailsModel` (which model's
  // header/metadata to show) stays local.
  const [detailsModel, setDetailsModel] = useState<ModelInfo | null>(null);

  const handleViewDetails = (model: ModelInfo) => {
    setDetailsModel(model);
    setModelDetailsOpen(true);
  };

  const handleDetailsClose = () => {
    setModelDetailsOpen(false);
    setDetailsModel(null);
  };

  // When opened without a specific model (e.g. the composer Templates button),
  // `detailsModel` is null and the dialog falls back to the active `modelInfo`
  // at render (header + SelectedModelDetails), so it shows the current image
  // settings + templates panel. No effect needed - the fallback does the work.

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ModalDialog
          data-testid="ai-settings-modal"
          sx={{
            width: isMobile ? '100vw' : 'min(820px, 92vw)',
            height: isMobile ? '100dvh' : '85vh',
            maxWidth: isMobile ? '100vw' : '92vw',
            maxHeight: 'none',
            borderRadius: isMobile ? 0 : undefined,
            margin: isMobile ? 0 : undefined,
            border: isMobile ? 'none' : undefined,
            p: 0,
            overflow: 'hidden',
          }}
        >
          <Sheet
            sx={{
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              padding: '0px',
              height: '100%',
              borderRadius: isMobile ? 0 : undefined,
            }}
          >
            {/* Mobile Header with Back Button and Title */}
            {isMobile && <MobileTopBar title="AI Settings" onClose={onClose} />}
            {/* MAIN CONTENT */}
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0px',
                width: '100%',
                height: '100%',
                // Mobile keeps zero vertical padding: the TabPanel heights below are calc'd
                // against a full-height viewport.
                padding: { xs: '0 16px', sm: '24px' },
              }}
            >
              {/* Close Button and Help */}
              <Box
                sx={{
                  width: '100%',
                  display: { xs: 'none', sm: 'flex' },
                  justifyContent: 'flex-end',
                  alignItems: 'center',
                  gap: '8px',
                  p: 0,
                  height: '28px',
                  position: { sm: 'absolute' },
                  top: { sm: '8px' },
                  right: { sm: '8px' },
                  // Above the sticky model-list header (zIndex 10), which otherwise slides
                  // over these on scroll.
                  zIndex: 20,
                }}
              >
                <ContextHelpButton
                  helpId="features/ai-models"
                  tooltipText="Learn about AI Models"
                  size="sm"
                  sx={HEADER_ICON_BUTTON_SX}
                />
                <IconButton
                  variant="plain"
                  size="sm"
                  data-testid="ai-settings-close-btn"
                  sx={HEADER_ICON_BUTTON_SX}
                  onClick={onClose}
                >
                  <CloseIcon sx={{ fontSize: '16px' }} />
                </IconButton>
              </Box>

              {/* Tabs: AI Settings + Audio always available; Research Mode only when its
                  feature flag is on. Audio-generation defaults are model-independent, so
                  they get their own top-level tab rather than hiding in a per-model panel. */}
              <Tabs
                value={activeTab}
                onChange={(_, newValue) => setActiveTab(newValue as 'ai-settings' | 'research-mode' | 'audio')}
                sx={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <TabList
                  sx={theme => ({
                    backgroundColor: 'transparent',
                    borderBottom: `1px solid ${theme.palette.divider}`,
                    // Desktop spacing lives on the title instead, so it scrolls away and the
                    // sticky search row pins right under the tabs. Mobile has no title.
                    mb: { xs: 2, sm: 0 },
                    p: 0,
                    boxShadow: 'none',
                    maxHeight: '32px',
                    height: { sm: '32px' },
                    display: 'flex',
                    gap: '4px',
                    // Tabs inherit `min-block-size: var(--ListItem-minHeight)` (36px at sizeMd),
                    // which would outgrow the 32px bar.
                    '--ListItem-minHeight': '32px',
                    '& .MuiTab-root': {
                      fontSize: '14px',
                      fontWeight: 400,
                      paddingBlock: 0,
                      paddingInline: '12px',
                      color: 'text.primary50',
                      flex: { xs: '1 1 0%', sm: '0 0 auto' },
                      minWidth: 0,
                      whiteSpace: 'nowrap',
                      textAlign: 'center',
                      transition: 'background 0.2s, color 0.2s',
                      // Joy's own :hover rule for the plain variant outranks a bare `&:hover`
                      // here, so the tint has to go through its variant var.
                      '&:not(.Mui-selected)': {
                        '--variant-plainHoverBg': theme.palette.notebooklist.hoverBg,
                        '&:hover': {
                          color: 'text.primary',
                        },
                      },
                      '&.Mui-selected': {
                        color: 'text.primary',
                      },
                    },
                  })}
                >
                  <Tab value="ai-settings">AI Settings</Tab>

                  {isResearchModeFeatureEnabled && <Tab value="research-mode">Research Mode</Tab>}

                  <Tab value="audio" data-testid="ai-settings-audio-tab">
                    Audio
                  </Tab>
                </TabList>

                {/* AI SETTINGS TAB */}
                <TabPanel value="ai-settings" sx={{ p: 0, height: 'calc(100% - 37px)' }}>
                  {activeTab === 'ai-settings' && (
                    <AISettingsTab
                      model={typedModel}
                      handleModelSelection={handleModelSelection}
                      onSelectionComplete={onClose}
                      modelFilter={modelFilter}
                      handleModelChange={handleModelChange}
                      isMobile={isMobile}
                      onViewDetails={handleViewDetails}
                    />
                  )}
                </TabPanel>

                {/* RESEARCH MODE TAB */}
                {isResearchModeFeatureEnabled && (
                  <TabPanel
                    value="research-mode"
                    sx={{
                      p: 0,
                      overflowY: 'auto',
                      overflowX: 'hidden',
                      height: { xs: 'calc(100dvh - 180px)', sm: 'auto' },
                    }}
                  >
                    {activeTab === 'research-mode' && (
                      <ResearchModeTab
                        researchMode={researchMode}
                        setLLM={setLLM}
                        addResearchConfiguration={addResearchConfiguration}
                        updateResearchConfiguration={updateResearchConfiguration}
                        removeResearchConfiguration={removeResearchConfiguration}
                        modelInfoRepo={modelInfoRepo ?? null}
                        model={typedModel}
                        temperature={safeTemperature}
                        max_tokens={safeMaxTokens}
                        top_p={safeTopP}
                      />
                    )}
                  </TabPanel>
                )}

                {/* AUDIO TAB - model-independent defaults for the in-app audio generator */}
                <TabPanel
                  value="audio"
                  sx={{ p: 0, overflowY: 'auto', overflowX: 'hidden', height: 'calc(100% - 37px)' }}
                >
                  {activeTab === 'audio' && (
                    <Box>
                      <TabIntro
                        title="Audio Generation"
                        description={
                          <>Defaults for the in-app audio generator (Files Manager &rarr; Generate Audio).</>
                        }
                      />
                      <Box sx={{ mt: 2 }}>
                        <AudioGenerationSettings />
                      </Box>
                    </Box>
                  )}
                </TabPanel>
              </Tabs>
            </Box>
          </Sheet>
        </ModalDialog>
      </Modal>

      {/* Model detail and settings dialog - responsive: fullscreen on phone, centered dialog on desktop */}
      <Modal
        open={modelDetailsOpen}
        onClose={handleDetailsClose}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1300,
        }}
      >
        <ModalDialog
          data-testid="model-details-dialog"
          sx={{
            // Matches the model-list modal exactly so the window does not resize when you
            // open a model's settings.
            width: isMobile ? '100vw' : 'min(820px, 92vw)',
            height: isMobile ? '100dvh' : '85vh',
            maxWidth: isMobile ? '100vw' : '92vw',
            maxHeight: isMobile ? '100dvh' : '85vh',
            margin: 0,
            borderRadius: isMobile ? 0 : 'lg',
            padding: 0,
            overflow: 'hidden',
            ...(isMobile ? { position: 'fixed', transform: 'none', top: 0, left: 0 } : {}),
          }}
        >
          <Sheet
            sx={{
              width: '100%',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              borderRadius: isMobile ? 0 : 'lg',
            }}
          >
            {/* Detail content */}
            <Box
              sx={{
                flex: 1,
                overflowY: 'auto',
                pt: 0,
                px: { xs: 2, sm: 3 },
                pb: { xs: 2, sm: 3 },
                ...scrollbarStyles,
              }}
            >
              <Box
                sx={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 2,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 1,
                  // Breaks out of the container's side padding so the background covers edge to
                  // edge as content scrolls under. Nothing to compensate vertically - the
                  // container has no top padding.
                  mx: { xs: '-16px', sm: '-24px' },
                  px: { xs: '16px', sm: '24px' },
                  py: '16px',
                  backgroundColor: 'background.surface',
                  // Same token as the dialog's own outline: ModalDialog carries no explicit
                  // border, so its window edge is Joy's outlined-variant border.
                  borderBottom: '1px solid',
                  borderColor: 'neutral.outlinedBorder',
                }}
              >
                <Button
                  variant="plain"
                  size="sm"
                  data-testid="model-details-back-btn"
                  onClick={handleDetailsClose}
                  startDecorator={<ArrowBackIcon sx={{ fontSize: '16px' }} />}
                  sx={{
                    ...HEADER_ICON_BUTTON_SX,
                    '--Button-gap': '4px',
                    // Joy's own plain-variant :hover rule outranks the backgroundColor in
                    // HEADER_ICON_BUTTON_SX, so the fill has to be cleared through its var.
                    '--variant-plainHoverBg': 'transparent',
                    '--variant-plainActiveBg': 'transparent',
                    minHeight: 'auto',
                    px: 0,
                    fontSize: '14px',
                    fontWeight: 400,
                  }}
                >
                  Back to models
                </Button>

                {/* Commit control. Opening this screen no longer selects the model (see
                    ModelSelection's onSettingsClick), so it is a preview until this is pressed -
                    and pressing it deliberately leaves the dialog open so the settings below can
                    be adjusted straight after. */}
                {(() => {
                  const shown = detailsModel ?? modelInfo;
                  if (!shown) return null;
                  if (shown.id === typedModel) {
                    // Tick trails the label here, unlike the cards: this sits at the row's right
                    // edge, so leading with the glyph would leave it floating mid-row.
                    return (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <Typography
                          data-testid="model-current-label"
                          sx={{ color: 'text.primary', fontSize: '14px', fontWeight: 400 }}
                        >
                          Current model
                        </Typography>
                        <SelectedCheckIcon />
                      </Box>
                    );
                  }
                  return (
                    <Button
                      variant="solid"
                      color="primary"
                      size="sm"
                      data-testid="model-use-btn"
                      disabled={shown.disabled}
                      onClick={() => handleModelSelection(shown.id)}
                      sx={{ fontSize: '14px', fontWeight: 400, flexShrink: 0 }}
                    >
                      Use this model
                    </Button>
                  );
                })()}
              </Box>

              <Box sx={{ mt: '24px' }}>
                {(() => {
                  const shown = detailsModel ?? modelInfo;
                  if (!shown) return null;
                  const showNew = isNewModel(shown);
                  const showBedrock = shown.backend === ModelBackend.Bedrock;
                  if (!showNew && !showBedrock) return null;
                  return (
                    <Box sx={{ display: 'flex', gap: '4px', mb: '8px' }}>
                      {showNew && (
                        <CornerBadge
                          testId={`model-new-badge-${shown.id}`}
                          label="New"
                          tooltip="Released in the last 3 months"
                          background={NEW_BADGE_BG}
                        />
                      )}
                      {showBedrock && (
                        <CornerBadge
                          testId={`bedrock-badge-${shown.id}`}
                          label="AWS Bedrock"
                          tooltip="Hosted on AWS Bedrock, not the provider's own API"
                          background={BEDROCK_BADGE_BG}
                        />
                      )}
                    </Box>
                  );
                })()}

                <TabIntro
                  title={(detailsModel ?? modelInfo)?.name ?? ''}
                  description={(detailsModel ?? modelInfo)?.description}
                  mt={0}
                />
              </Box>

              {/* Selected Model Details */}
              <SelectedModelDetails
                modelInfo={detailsModel ?? modelInfo}
                model={typedModel}
                setLLM={setLLM}
                setSpokenWords={setSpokenWords}
                historyLines={historyLines}
                setHistoryLines={setHistoryLines}
                isImageModel={isImageModel}
                isKontextModel={isKontextModel}
                priceTierInfo={priceTierInfo}
                maxTokens={maxTokens}
                maxContextWindow={maxContextWindow}
                getPriceTierTooltip={getPriceTierTooltip}
                metricsLoading={metricsLoading}
                modelSpeed={modelSpeed}
                getModelSpeedVariant={getModelSpeedVariant}
                getModelSpeedTooltip={getModelSpeedTooltip}
                INFINITE_VALUE={INFINITE_VALUE}
                BFL_SAFETY_TOLERANCE={BFL_SAFETY_TOLERANCE}
                ImageModels={ImageModels}
                tools={tools}
                onRollDice={onRollDice}
                isMobile={isMobile}
                max_tokens={safeMaxTokens}
                temperature={safeTemperature}
                handleTemperatureChange={handleTemperatureChange}
                spokenWords={spokenWords}
                liveAI={liveAI}
                setLiveAI={setLiveAI}
                stream={stream}
                setStream={setStream}
                isQuestMasterFeatureEnabled={isQuestMasterFeatureEnabled}
                isQuestMasterEnabled={isQuestMasterEnabled}
                voiceOver={voiceOver}
                imageSettings={imageSettings}
                prompt_upsampling={safePromptUpsampling}
                safety_tolerance={safeSafetyTolerance}
                commonTextTitleStyles={commonTextTitleStyles}
                commonInputStyles={commonInputStyles}
                commonSelectStyles={commonSelectStyles}
                mode={mode}
              />
            </Box>
          </Sheet>
        </ModalDialog>
      </Modal>
    </>
  );
};
