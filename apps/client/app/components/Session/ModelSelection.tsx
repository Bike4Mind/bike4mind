import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Typography,
  Radio,
  Stack,
  Input,
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Select,
  Option,
  CircularProgress,
  IconButton,
  Tooltip,
} from '@mui/joy';
import {
  Chat as ChatIcon,
  Image as ImageIcon,
  Videocam as VideoIcon,
  Check as CheckIcon,
  StarRounded,
  StarBorderRounded,
} from '@mui/icons-material';
import ClearIcon from '@mui/icons-material/Clear';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AdminPanelSettingsOutlinedIcon from '@mui/icons-material/AdminPanelSettingsOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import ViewListOutlinedIcon from '@mui/icons-material/ViewListOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import SpeedIcon from '@mui/icons-material/Speed';
import AttachMoneyIcon from '@mui/icons-material/AttachMoney';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import ConstructionIcon from '@mui/icons-material/Construction';
// Named for tools, but this is the thinking glyph: ToolsSection renders it on the Thinking
// row and ToolIndicators uses it as tool-indicator-thinking.
import SupportsToolsIcon from '@client/app/components/svgs/SupportsToolsIcon';
import { useNavigate } from '@tanstack/react-router';
import { useUser } from '@client/app/contexts/UserContext';
import { useAdminModal } from '@client/app/components/admin/useAdminModal';
import { AdminTab } from '@client/app/components/admin/adminSidebarConfig';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { useAccessibleModels } from '@client/app/hooks/useAccessibleModels';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import { ModelName, ModelInfo, ModelBackend, SpeechToTextModels, isModelDeprecated } from '@bike4mind/common';
import SearchIcon from '@mui/icons-material/Search';
import { sortModelsForPicker } from '@client/app/utils/modelRanking';
import { useTheme } from '@mui/joy';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { useLLM } from '@client/app/contexts/LLMContext';
import {
  ChipVariant,
  getModelPriceTier,
  isOpenAIModel,
  getModelSpeedVariant,
  getModelSpeedTooltip,
  getModelSpeedFromStats,
  getPriceTierTooltip,
  isNewModel,
} from '@client/app/utils/aiSettingsUtils';
import MetadataChip from './AISettings/MetaDataChips';
import { useModelStats } from '@client/app/hooks/data/useModelStats';
import { isImageModel } from '@client/app/utils/commands';
import { green, greenAlpha, orange, red } from '@client/app/utils/themes/colors';
import { useFavoriteModels } from '@client/app/hooks/useFavoriteModels';
import { useIsMobile } from '@client/app/hooks/useIsMobile';

// List of model IDs to exclude from the dropdown
// Add any model IDs you want to hide here
const emptyRecord: Record<string, number> = {};

const EXCLUDED_MODEL_IDS: ModelName[] = [
  // Now handled in admin settings

  // ChatModels.CLAUDE_3_HAIKU_BEDROCK, // claude-3-haiku
  // ChatModels.LLAMA3_INSTRUCT_8B_V1, // llama3-instruct-8b
  // ChatModels.JURASSIC2_ULTRA, // j2-ultra
  // ChatModels.JURASSIC2_MID, // j2-mid
  // ChatModels.TITAN_TEXT_G1_EXPRESS, // titan-text-express
  // ChatModels.TITAN_TEXT_G1_LITE, // titan-text-lite

  // Speech to Text Models only, not in the regular model list
  SpeechToTextModels.WHISPER_1,
  SpeechToTextModels.AWS_TRANSCRIBE,
];

const checkBoxStyle = {
  mr: 1,
  '&.Mui-checked .MuiRadio-radio': {
    borderColor: green[800],
    backgroundColor: greenAlpha[800][20],
  },
  '&.Mui-checked .MuiRadio-icon': {
    color: green[800],
  },
} as const;

// Function to get backend logo path
const getBackendLogo = (backend: string): string | null => {
  const logoMap: Record<string, string> = {
    OpenAI: '/images/logos/llm/llm-logo-openai.png',
    Anthropic: '/images/logos/llm/llm-logo-anthropic.png',
    Meta: '/images/logos/llm/llm-logo-meta.png',
    'Black Forest Labs': '/images/logos/llm/llm-logo-bfl.png',
    xAI: '/images/logos/XAI_Logo.svg',
  };

  return logoMap[backend] || null;
};

// Marks a card as AWS Bedrock-hosted. Deliberately separate from getBackendLogo() above: that
// map returns provider logos (OpenAI, Anthropic, ...) keyed by who authored the model, whereas
// this marks the hosting platform - any provider's model can be Bedrock-hosted, so it's a
// different axis, not another entry. Amazon Bedrock's own teal, so the badge reads as the
// platform rather than as another status colour.
const BEDROCK_BADGE_BG = '#01A88D';

// Global image cache to prevent re-requests
const imageCache = new Map<string, string>();

// Function to preload and cache images
const preloadAndCacheImage = (src: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    if (imageCache.has(src)) {
      resolve(imageCache.get(src)!);
      return;
    }

    const img = new Image();
    img.onload = () => {
      // Create a data URL to ensure the image is fully cached
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx?.drawImage(img, 0, 0);
      const dataUrl = canvas.toDataURL();

      imageCache.set(src, dataUrl);
      resolve(dataUrl);
    };
    img.onerror = reject;
    img.src = src;
  });
};

// Preload all backend logos
const preloadBackendLogos = async () => {
  const logoMap: Record<string, string> = {
    OpenAI: '/images/logos/llm/llm-logo-openai.png',
    Anthropic: '/images/logos/llm/llm-logo-anthropic.png',
    Meta: '/images/logos/llm/llm-logo-meta.png',
    'Black Forest Labs': '/images/logos/llm/llm-logo-bfl.png',
    xAI: '/images/logos/XAI_Logo.svg',
  };

  const preloadPromises = Object.values(logoMap).map(src => preloadAndCacheImage(src));
  await Promise.allSettled(preloadPromises);
};

// Preload images on module load
preloadBackendLogos();

interface ModelSelectionProps {
  model: ModelName;
  setModel: (model: ModelName) => void;
  onSelectionComplete?: () => void;
  imageModel: boolean;
  showAllModels?: boolean;
  modelFilter?: 'all' | 'text' | 'image' | 'video';
  onModelFilterChange?: (filter: 'all' | 'text' | 'image' | 'video') => void;
  onSettingsClick?: (model: ModelInfo) => void;
  isResearchModeFeatureEnabled?: boolean;
  /** Rendered inside the sticky header, above the search/filter row, so it pins with it. */
  stickyHeader?: React.ReactNode;
}

// Format large numbers with commas
const formatNumber = (num: number): string => {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

// Format context window size nicely (e.g., "200K" instead of "200000")
const formatContextWindow = (size: number): string => {
  if (size >= 1000000) {
    return `${(size / 1000000).toFixed(1)}M`;
  } else if (size >= 1000) {
    return `${Math.round(size / 1000)}K`;
  }
  return formatNumber(size);
};

// Section label for models running on the operator's own hardware (self-host).
export const SELF_HOSTED_BACKEND = 'Local / Self-Hosted';

// Function to determine backend from model name/ID. Exported for grouping tests.
export const getModelBackend = (model: ModelInfo): string => {
  // Self-host: Ollama (text) and the local Stable-Diffusion backend (image) both
  // run on the operator's hardware, so group them in a dedicated "Local /
  // Self-Hosted" section rather than "Other". In the hosted product the same
  // Ollama backend is remote, so this only applies when the bundle was built with
  // B4M_SELF_HOST (inlined by next.config.mjs) - which is also the only context a
  // local image model is enumerated in.
  if (
    (model.backend === ModelBackend.Ollama || model.backend === ModelBackend.LocalImage) &&
    process.env.B4M_SELF_HOST === 'true'
  ) {
    return SELF_HOSTED_BACKEND;
  }

  const modelName = model.name.toLowerCase();
  const modelId = model.id.toLowerCase();
  const modelDescription = model.description?.toLowerCase();

  // OpenAI models
  if (isOpenAIModel(modelName) || modelDescription?.includes('OpenAI')) {
    return 'OpenAI';
  }

  // Anthropic models
  if (modelName.includes('claude') || modelId.includes('claude')) {
    return 'Anthropic';
  }

  // Google models
  if (modelName.includes('gemini') || modelName.includes('bard') || modelId.includes('gemini')) {
    return 'Google';
  }

  // Meta models
  if (modelName.includes('llama') || modelId.includes('llama')) {
    return 'Meta';
  }

  // xAI models
  if (modelName.includes('grok') || modelId.includes('grok')) {
    return 'xAI';
  }

  // Flux/BFL models
  if (modelName.includes('flux') || modelId.includes('flux')) {
    return 'Black Forest Labs';
  }

  // Default to "Other" if no match found
  return 'Other';
};

// Layout of the model list: roomy cards in a 2-up grid, or compact single-column rows.
export type ModelViewMode = 'grid' | 'list';

// Cost and speed render as icon-only chips in a neutral frame, so the glyph says which
// dimension and its colour says the value. Reuses the existing tier/speed variants as the
// scale rather than a second set of thresholds.
const metricIconColor = (variant: ChipVariant): string =>
  variant === 'green' ? green[800] : variant === 'yellow' ? orange[450] : red[400];

// Same purple the New chip used before it became a corner badge. No theme token exists for
// it; getChipStyles hardcodes the identical value for its `purple` variant.
const NEW_BADGE_BG = '#A52ECD';

// Small label riding the card's top border. Positioning lives on the shared row in the card
// so multiple badges line up; this only draws the pill.
const CornerBadge = ({
  testId,
  label,
  tooltip,
  background,
}: {
  testId: string;
  label: string;
  tooltip: string;
  background: string;
}) => (
  <Tooltip title={tooltip} placement="top">
    <Box
      data-testid={testId}
      sx={{
        display: 'flex',
        alignItems: 'center',
        height: '20px',
        px: '6px',
        borderRadius: '4px',
        backgroundColor: background,
        color: '#FFFFFF',
        fontSize: '12px',
        fontWeight: 600,
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </Box>
  </Tooltip>
);

// Read-only indicator. The frame is what separates these from the star and settings icons
// sitting beside them - without it, informational glyphs read as pressable. Borrows the
// card's own border shorthand so the frames, the card and the row divider stay in step.
const MetricIcon = ({ label, tooltip, children }: { label: string; tooltip: string; children: React.ReactNode }) => (
  <Tooltip title={tooltip} placement="top">
    <Box
      role="img"
      aria-label={label}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '24px',
        height: '24px',
        flex: 'none',
        boxSizing: 'border-box',
        borderRadius: '50%',
        border: 'var(--joy-palette-aiSettings-modelCard-border)',
      }}
    >
      {children}
    </Box>
  </Tooltip>
);

const ModelOption = React.memo(
  ({
    model,
    isSelected,
    maxContextWindow,
    maxTokens,
    onSelect,
    onSettingsClick,
    isFavorite = false,
    onToggleFavorite,
    avgResponseTimeByModel,
    statsLoading,
    mode,
    viewMode = 'grid',
  }: {
    model: ModelInfo;
    isSelected: boolean;
    maxContextWindow: number;
    maxTokens: number;
    onSelect: (model: ModelInfo) => void;
    onSettingsClick?: (model: ModelInfo) => void;
    isFavorite?: boolean;
    onToggleFavorite?: (modelId: string) => void;
    avgResponseTimeByModel: Record<string, number>;
    statsLoading: boolean;
    mode: 'dark' | 'light';
    viewMode?: ModelViewMode;
  }) => {
    const priceTierInfo = getModelPriceTier(model);
    const modelSpeed = getModelSpeedFromStats(model.id, avgResponseTimeByModel);
    // A disabled model stays in the list so users can see it, but it can't be picked:
    // no click handler, a not-allowed cursor, dimmed, and no hover affordance.
    const isDisabled = !!model.disabled;
    const isList = viewMode === 'list';

    // Each tooltip is scoped to its own element rather than to the whole row: MUI listens on
    // `mouseover`, which bubbles, so a tooltip on the badge nested inside one on the row would
    // open both at once.
    const nameBlock = (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: isList ? 'none' : 1, minWidth: '50px' }}>
        <Tooltip
          title={model.description ?? ''}
          placement="top"
          variant="soft"
          sx={{ maxWidth: 320 }}
          disableHoverListener={!model.description}
        >
          <Typography
            level="body-md"
            sx={{
              textAlign: 'left',
              color: 'text.primary',
              fontWeight: '500',
            }}
          >
            {model.name}
          </Typography>
        </Tooltip>
        {/* Selected Checkmark - sits right of the model name */}
        {isSelected && (
          <CheckIcon
            sx={{
              fontSize: '16px',
              flex: 'none',
              color: green[800],
              '& path': {
                strokeWidth: '2px',
                stroke: green[800],
              },
            }}
          />
        )}
      </Box>
    );

    const favoriteLabel = isFavorite ? 'Remove from favorites' : 'Add to favorites';
    const favoriteToggle = onToggleFavorite && (
      <Tooltip title={favoriteLabel} placement="bottom">
        <IconButton
          data-testid={`favorite-toggle-${model.id}`}
          aria-label={favoriteLabel}
          variant="plain"
          size="sm"
          sx={{
            minWidth: '28px',
            minHeight: '28px',
            width: '28px',
            height: '28px',
            // Joy's SvgIcon resolves its colour from `--Icon-color`; the filled star opts out
            // by declaring its own.
            '--Icon-color': 'var(--joy-palette-text-tertiary)',
            '& .MuiSvgIcon-root': {
              transition: 'color 0.2s',
            },
            '&:hover': {
              backgroundColor: 'transparent',
              '--Icon-color': 'var(--joy-palette-text-primary)',
              // The filled star ignores --Icon-color, so give it the same solid-button hover
              // token the New Agent button uses to signal that clicking unfavorites.
              ...(isFavorite && { '& .MuiSvgIcon-root': { color: 'primary.solidHoverBg' } }),
            },
          }}
          onClick={e => {
            e.stopPropagation();
            onToggleFavorite(model.id);
          }}
        >
          {isFavorite ? (
            <StarRounded sx={{ fontSize: '20px', color: 'primary.solidBg' }} />
          ) : (
            <StarBorderRounded sx={{ fontSize: '20px' }} />
          )}
        </IconButton>
      </Tooltip>
    );

    // Selects the model and opens its detail & settings dialog (all viewports).
    const viewMoreButton = onSettingsClick && (
      <Tooltip title="View model details & settings" placement="bottom">
        <IconButton
          data-testid={`model-view-more-${model.id}`}
          aria-label="View model details and settings"
          variant="plain"
          size="sm"
          sx={{
            flex: 'none',
            minWidth: '28px',
            minHeight: '28px',
            width: '28px',
            height: '28px',
            '--Icon-color': 'var(--joy-palette-text-tertiary)',
            '& .MuiSvgIcon-root': {
              transition: 'color 0.2s',
            },
            '&:hover': {
              backgroundColor: 'transparent',
              '--Icon-color': 'var(--joy-palette-text-primary)',
            },
          }}
          onClick={e => {
            e.stopPropagation();
            onSettingsClick(model);
          }}
        >
          <SettingsOutlinedIcon sx={{ fontSize: '20px' }} />
        </IconButton>
      </Tooltip>
    );

    const metricIndicators = (
      <>
        <MetricIcon label={`${priceTierInfo.tier} cost`} tooltip={getPriceTierTooltip(priceTierInfo.tier)}>
          <AttachMoneyIcon
            sx={{
              fontSize: '16px',
              color: metricIconColor(priceTierInfo.variant),
              // The $ glyph is drawn 0.59 units left of centre inside its own 24-unit viewBox
              // (ink spans x 6.32..16.50), so centring the <svg> still leaves it visibly left
              // in a round frame. Divided by 24 in em so it tracks fontSize. Speed and the
              // capability glyphs measure centred and are deliberately left alone.
              transform: 'translateX(calc(0.59em / 24))',
            }}
          />
        </MetricIcon>

        {!statsLoading && modelSpeed && (
          <MetricIcon
            label={`${modelSpeed.charAt(0).toUpperCase() + modelSpeed.slice(1)} speed`}
            tooltip={getModelSpeedTooltip(modelSpeed)}
          >
            <SpeedIcon sx={{ fontSize: '16px', color: metricIconColor(getModelSpeedVariant(modelSpeed)) }} />
          </MetricIcon>
        )}
      </>
    );

    // Capabilities are present-or-absent, so they stay neutral: no colour to imply a scale
    // that doesn't exist. Absence of the icon is the "no" state.
    const capabilityIndicators = (
      <>
        {model.supportsVision && (
          <MetricIcon label="Vision" tooltip="Able to understand images">
            <VisibilityOutlinedIcon sx={{ fontSize: '16px', color: 'text.tertiary' }} />
          </MetricIcon>
        )}

        {model.can_think && (
          <MetricIcon label="Thinking" tooltip="Reasons step-by-step before responding">
            {/* 18px where the others are 16: this glyph carries far more detail than the
                MUI icons, so it needs the extra couple of px to stay legible. */}
            <SupportsToolsIcon width={18} height={18} fill="var(--joy-palette-text-tertiary)" />
          </MetricIcon>
        )}

        {model.supportsTools && (
          <MetricIcon label="Tools" tooltip="Able to use a growing list of tools">
            <ConstructionIcon sx={{ fontSize: '16px', color: 'text.tertiary' }} />
          </MetricIcon>
        )}
      </>
    );

    const metadataChips = (
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        flexWrap="wrap"
        alignItems="center"
        // Unavailable is the only framed chip left in this row; 32px gives it presence next to
        // the 24px indicators. Set here rather than in getChipStyles, which the model-details
        // dialog also uses.
        sx={{ '& .MuiChip-root': { height: '32px' } }}
      >
        {isDisabled ? (
          // A disabled model can't be picked, so cost and speed are noise: say why and stop.
          <MetadataChip
            label="Unavailable"
            mode={mode}
            variant="red"
            tooltip={model.disabledReason ?? 'This model is currently unavailable'}
          />
        ) : (
          // Cost and speed are the only two always present, so they anchor the group's fixed
          // edge and stay column-aligned down the list: leading in grid (left-aligned) and
          // trailing in list (right-aligned). The optional capabilities take the ragged side.
          <>
            {!isList && metricIndicators}
            {capabilityIndicators}
            {isList && metricIndicators}
          </>
        )}
      </Stack>
    );

    // Text models only: image and video entries carry placeholder context values (FLUX is
    // 10000/10000), so the number would be noise. max_tokens is deliberately not shown - the
    // catalog value is the model's ceiling, not the user's configured limit, so it can
    // disagree with what the model will actually emit. It lives in the settings dialog next
    // to the control that sets it.
    const contextSummary = model.type === 'text' && (
      <Tooltip title={`${formatNumber(model.contextWindow)} token context window`} placement="top">
        <Typography sx={{ fontSize: { xs: '12px' }, color: 'text.primary50', fontWeight: '500' }}>
          {formatContextWindow(model.contextWindow)}
        </Typography>
      </Tooltip>
    );

    // Tooltips are scoped to the name + description regions rather than the whole card, so
    // they don't stack on top of the per-chip tooltips in the metadata row.
    return (
      <Box
        data-testid={`model-card-${model.id}`}
        data-view-mode={viewMode}
        aria-disabled={isDisabled || undefined}
        data-disabled={isDisabled || undefined}
        onClick={isDisabled ? undefined : () => onSelect(model)}
        sx={{
          display: 'flex',
          width: '100%',
          maxWidth: '100%',
          minWidth: '100%',
          mx: 'auto',
          justifyContent: 'space-between',
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          opacity: isDisabled ? 0.55 : 1,
          transition: 'all 0.2s ease',
          backgroundColor: 'var(--joy-palette-aiSettings-modelCard-background)',
          // Selected tint rides on top as a background *image*, so the surface colour below it
          // (base or hover) still shows through instead of being replaced.
          ...(isSelected && {
            backgroundImage:
              'linear-gradient(var(--joy-palette-aiSettings-modelCard-activeBackground), var(--joy-palette-aiSettings-modelCard-activeBackground))',
          }),
          '&:hover': {
            backgroundColor: isDisabled ? undefined : 'var(--joy-palette-aiSettings-modelCard-hoverBackground)',
          },
          border: isSelected
            ? 'var(--joy-palette-aiSettings-modelCard-activeBorder)'
            : 'var(--joy-palette-aiSettings-modelCard-border)',
          position: 'relative',
          borderWidth: '1px',
          boxSizing: 'border-box',
          borderRadius: '8px',
          ...(isList
            ? {
                flexDirection: 'row',
                alignItems: 'center',
                gap: 2,
                padding: '16px',
                maxHeight: 'none',
              }
            : {
                flexDirection: 'column',
                alignItems: 'stretch',
                padding: '16px',
                maxHeight: { xs: 'none', sm: '180px' },
              }),
        }}
      >
        {/* Badges straddle the top border rather than the corner: the scroll container in
            AdvancedAIModal is overflowY:auto, which makes overflow-x compute to auto too, so
            anything reaching left of x=0 gets clipped - and in grid view that would clip the
            left column while sparing the right. Vertical overhang is unaffected. One shared
            row so New and Bedrock can never overlap each other. */}
        <Box sx={{ position: 'absolute', top: '-7px', left: '12px', zIndex: 1, display: 'flex', gap: '4px' }}>
          {!isDisabled && isNewModel(model) && (
            <CornerBadge
              testId={`model-new-badge-${model.id}`}
              label="New"
              tooltip="Released in the last 3 months"
              background={NEW_BADGE_BG}
            />
          )}
          {/* Kept on disabled models, unlike New: it identifies *which* of two
              identically-named models this is. */}
          {model.backend === ModelBackend.Bedrock && (
            <CornerBadge
              testId={`bedrock-badge-${model.id}`}
              label="AWS Bedrock"
              tooltip="Hosted on AWS Bedrock, not the provider's own API"
              background={BEDROCK_BADGE_BG}
            />
          )}
        </Box>

        {isList ? (
          <>
            {/* Title with the context window beneath it, indicators pushed right, then a rule
                separating what the row *says* from what you can *do* to it. minHeight holds the
                row steady when contextSummary is absent - image and video models drop that
                second line, and Favorites is the one section that mixes them with text models. */}
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                gap: '2px',
                minHeight: '44px',
                flex: 1,
                minWidth: 0,
                textAlign: 'left',
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>{nameBlock}</Box>
              {contextSummary}
            </Box>

            <Box sx={{ display: 'flex', alignItems: 'center', flex: 'none' }}>{metadataChips}</Box>

            <Box
              sx={{
                display: { xs: 'none', sm: 'block' },
                alignSelf: 'stretch',
                my: '4px',
                flex: 'none',
                // Reuses the card's own border shorthand so the two can't drift apart.
                borderLeft: 'var(--joy-palette-aiSettings-modelCard-border)',
              }}
            />

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
              {favoriteToggle}
              {viewMoreButton}
            </Box>
          </>
        ) : (
          <>
            {/* Model Name and Metadata Chips, Top Side */}
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                textAlign: 'left',
                mb: 1.5,
              }}
            >
              {nameBlock}
              {favoriteToggle}
              {viewMoreButton}
            </Box>

            {/* Model Description, Bottom Side — hovering reveals the full, untruncated text.
                placement="bottom" so the tooltip opens below the description text instead of
                upward over the favorite-star / View more row directly above it. */}
            {model.description && (
              <Tooltip title={model.description} placement="bottom" variant="soft" sx={{ maxWidth: 320 }}>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'flex-end',
                    gap: '8px',
                    flexDirection: 'row',
                    justifyContent: 'flex-start',
                  }}
                >
                  <Typography
                    level="body-xs"
                    sx={{
                      textAlign: 'left',
                      whiteSpace: 'normal',
                      color: 'text.primary50',
                      fontSize: { xs: '13px', sm: '14px' },
                      lineHeight: '1.4',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: '-webkit-box',
                      WebkitLineClamp: { xs: 3, sm: 2 },
                      WebkitBoxOrient: 'vertical',
                    }}
                  >
                    {model.description}
                  </Typography>
                </Box>
              </Tooltip>
            )}

            <Box
              sx={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                width: '100%',
                mt: 2.5,
                gap: '4px',
                flexWrap: 'wrap',
              }}
            >
              {metadataChips}
              <Stack sx={{ alignItems: 'flex-end', justifyContent: 'flex-end' }}>{contextSummary}</Stack>
            </Box>
          </>
        )}
      </Box>
    );
  }
);
ModelOption.displayName = 'ModelOption';

const ModelSelection: React.FC<ModelSelectionProps> = ({
  model,
  setModel,
  onSelectionComplete,
  imageModel,
  showAllModels,
  modelFilter = 'text',
  onModelFilterChange,
  onSettingsClick,
  isResearchModeFeatureEnabled = false,
  stickyHeader,
}) => {
  const { isLoading, error } = useModelInfo();
  const {
    accessibleModels,
    accessibleTextModels,
    accessibleImageModels,
    accessibleVideoModels,
    isLoading: isConfigsLoading,
  } = useAccessibleModels();
  const theme = useTheme();
  const mode = theme.palette.mode;
  const setLLM = useLLM(s => s.setLLM);
  const isAdmin = useUser(s => s.isAdmin);
  const setAdminTab = useAdminModal(s => s.setActiveTab);
  const navigate = useNavigate();
  const {
    value: searchQuery,
    debouncedValue: debouncedSearchQuery,
    setValue: setSearchQuery,
  } = useDebounceValue('', 500);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);
  const { isFavorite, toggleFavorite } = useFavoriteModels();
  const [viewMode, setViewMode] = useState<ModelViewMode>('list');
  // Below `sm` the grid is already one column, so the two layouts differ only by the
  // description and the row/column flow - not enough to justify a control. Grid wins there.
  // The user's own choice is left untouched in state so it returns when the viewport widens.
  const isMobile = useIsMobile();
  const effectiveViewMode: ModelViewMode = isMobile ? 'grid' : viewMode;

  // Lift model stats into parent - avoids N redundant query subscriptions and computations in ModelOption
  const { data: modelStats, isLoading: statsLoading } = useModelStats();
  const avgResponseTimeByModel = modelStats?.avgResponseTime ?? emptyRecord;

  // State for user-toggled accordion backends (manual expand/collapse)
  const [userToggledBackends, setUserToggledBackends] = useState<Set<string>>(
    new Set(['Favorites', 'OpenAI', 'Anthropic'])
  );

  // Memoize backend logos to prevent unnecessary re-renders and network requests
  const backendLogos = useMemo(() => {
    const logos: Record<string, string | null> = {};
    if (accessibleModels) {
      const uniqueBackends = new Set(accessibleModels.map(m => getModelBackend(m)));
      uniqueBackends.forEach(backend => {
        const originalSrc = getBackendLogo(backend);
        if (originalSrc) {
          // Use cached data URL if available, otherwise use original src
          logos[backend] = imageCache.get(originalSrc) || originalSrc;
        }
      });
    }
    return logos;
  }, [accessibleModels]);

  // Derive the selected model's backend so it's always expanded
  const selectedModelBackend = useMemo(() => {
    if (accessibleModels && model) {
      const selectedModel = accessibleModels.find(m => m.id === model);
      if (selectedModel) {
        return getModelBackend(selectedModel);
      }
    }
    return null;
  }, [model, accessibleModels]);

  const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(event.target.value);
  };

  const clearSearch = () => {
    setSearchQuery('');
  };

  const { filteredModels, maxContextWindow, maxTokens, modelsByBackend, modelsByBackendAndType } = useMemo(() => {
    // Start with accessible models instead of all models
    let availableModels: ModelInfo[] = [];

    if (showAllModels) {
      availableModels = accessibleModels;
    } else if (modelFilter === 'video') {
      availableModels = accessibleVideoModels;
    } else {
      availableModels = imageModel ? accessibleImageModels : accessibleTextModels;
    }

    // Filter out excluded models
    const withoutExcluded = availableModels.filter(m => !EXCLUDED_MODEL_IDS.includes(m.id));

    // Filter out deprecated models (e.g., models with deprecationDate in the past)
    const withoutDeprecated = withoutExcluded.filter(m => !isModelDeprecated(m));

    // Filter by search query if present
    const searchFiltered = debouncedSearchQuery
      ? withoutDeprecated.filter(m => {
          const searchLower = debouncedSearchQuery.toLowerCase();
          const nameMatch = m.name.toLowerCase().includes(searchLower);
          const descMatch = m.description && m.description.toLowerCase().includes(searchLower);
          return nameMatch || descMatch;
        })
      : withoutDeprecated;

    // Group models by backend for accordion view
    const grouped = searchFiltered.reduce(
      (acc, model) => {
        const backend = getModelBackend(model);
        if (!acc[backend]) {
          acc[backend] = [];
        }
        acc[backend].push(model);
        return acc;
      },
      {} as Record<string, ModelInfo[]>
    );

    // Sort within each backend: newly released first, then curated rank, then recency
    Object.keys(grouped).forEach(backend => {
      grouped[backend] = sortModelsForPicker(grouped[backend]);
    });

    // Group models by backend and then by type for "All Models" view
    const groupedByBackendAndType = searchFiltered.reduce(
      (acc, model) => {
        const backend = getModelBackend(model);
        // Ensure consistent type categorization
        const type = model.type === 'image' ? 'image' : model.type === 'video' ? 'video' : 'text';

        if (!acc[backend]) {
          acc[backend] = { text: [], image: [], video: [] };
        }

        // Only add the model to the appropriate type section
        acc[backend][type].push(model);
        return acc;
      },
      {} as Record<string, { text: ModelInfo[]; image: ModelInfo[]; video: ModelInfo[] }>
    );

    // Sort models within each backend and type by capability
    Object.keys(groupedByBackendAndType).forEach(backend => {
      groupedByBackendAndType[backend].text = sortModelsForPicker(groupedByBackendAndType[backend].text);
      groupedByBackendAndType[backend].image = sortModelsForPicker(groupedByBackendAndType[backend].image);
      groupedByBackendAndType[backend].video = sortModelsForPicker(groupedByBackendAndType[backend].video);
    });

    // Sort backends by priority (OpenAI, Anthropic, Google, Meta, etc.)
    const backendPriority = [
      SELF_HOSTED_BACKEND,
      'OpenAI',
      'Anthropic',
      'Google',
      'Meta',
      'xAI',
      'Mistral',
      'Black Forest Labs',
      'Cohere',
    ];
    const sortedBackends = Object.keys(grouped).sort((a, b) => {
      const aIndex = backendPriority.indexOf(a);
      const bIndex = backendPriority.indexOf(b);

      // If both backends are in priority list, sort by priority
      if (aIndex !== -1 && bIndex !== -1) {
        return aIndex - bIndex;
      }

      // If only one is in priority list, prioritize it
      if (aIndex !== -1) return -1;
      if (bIndex !== -1) return 1;

      // If neither is in priority list, sort alphabetically
      return a.localeCompare(b);
    });

    // Flatten the sorted models
    const sorted = sortedBackends.flatMap(backend => grouped[backend]);

    // Find maximum values
    let maxCtx = 0;
    let maxTok = 0;

    searchFiltered.forEach(m => {
      if (m.contextWindow > maxCtx) maxCtx = m.contextWindow;
      if (m.max_tokens > maxTok) maxTok = m.max_tokens;
    });

    return {
      filteredModels: sorted,
      maxContextWindow: maxCtx,
      maxTokens: maxTok,
      modelsByBackend: grouped,
      modelsByBackendAndType: groupedByBackendAndType,
    };
  }, [
    imageModel,
    accessibleModels,
    accessibleTextModels,
    accessibleImageModels,
    accessibleVideoModels,
    modelFilter,
    debouncedSearchQuery,
    showAllModels,
  ]);

  // Auto-expand the selected model's backend when it changes
  useEffect(() => {
    if (selectedModelBackend) {
      setUserToggledBackends(prev => {
        if (prev.has(selectedModelBackend)) return prev;
        const next = new Set(prev);
        next.add(selectedModelBackend);
        return next;
      });
    }
  }, [selectedModelBackend]);

  // Compute favorite models from the already-filtered list (respects search, filter, access control)
  const favoriteModels = useMemo(() => filteredModels.filter(m => isFavorite(m.id)), [filteredModels, isFavorite]);

  // Derive effective expanded backends from user toggles and search state
  const expandedBackends = useMemo(() => {
    if (debouncedSearchQuery) {
      // Expand all backends (including Favorites) when searching
      const all = new Set(Object.keys(modelsByBackend));
      all.add('Favorites');
      return all;
    }
    return userToggledBackends;
  }, [debouncedSearchQuery, modelsByBackend, userToggledBackends]);

  const selectModel = useCallback(
    (selectedModel: ModelInfo) => {
      setModel(selectedModel.id);

      // Remember the selected model for future use when switching model types
      if (isImageModel(selectedModel.id)) {
        setLLM({ lastUsedImageModel: selectedModel.id });
      } else {
        setLLM({ lastUsedTextModel: selectedModel.id });
      }
    },
    [setModel, setLLM]
  );

  const handleModelSelect = useCallback(
    (selectedModel: ModelInfo) => {
      selectModel(selectedModel);
      onSelectionComplete?.();
    },
    [onSelectionComplete, selectModel]
  );

  const handleSettingsClick = useCallback(
    (selectedModel: ModelInfo) => {
      selectModel(selectedModel);
      onSettingsClick?.(selectedModel);
    },
    [onSettingsClick, selectModel]
  );

  // The admin page owns its active tab in a store rather than a route param, so the
  // tab is set before navigating. The picker lives in a modal that would otherwise
  // stay mounted over the admin page, hence the close callback.
  const handleManageModels = useCallback(() => {
    setAdminTab(AdminTab.LLMDashboard);
    onSelectionComplete?.();
    navigate({ to: '/admin' });
  }, [navigate, onSelectionComplete, setAdminTab]);

  // Scroll the currently-selected model card into view on first paint so the
  // user doesn't have to hunt for the green checkmark across providers.
  // Re-runs when expandedBackends changes so lazy-mounted cards (backends that
  // needed auto-expansion) are found after their accordion renders.
  useEffect(() => {
    if (hasScrolledRef.current) return;
    if (isLoading || isConfigsLoading) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const timer = window.setTimeout(() => {
      const card = container.querySelector<HTMLElement>(`[data-testid="model-card-${model}"]`);
      if (!card) return;
      // scrollIntoView resolves the real scrolling ancestor; this component's root box is not
      // one, so scrollBy-ing it would silently no-op.
      card.scrollIntoView({ block: 'center', behavior: 'auto' });
      hasScrolledRef.current = true;
    }, 50);

    return () => window.clearTimeout(timer);
    // expandedBackends: re-run after lazy-mounted backends become visible so the
    // card is in the DOM before we query for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, isConfigsLoading, expandedBackends]);

  const toggleBackend = useCallback((backend: string) => {
    setUserToggledBackends(prev => {
      const next = new Set(prev);
      if (next.has(backend)) {
        next.delete(backend);
      } else {
        next.add(backend);
      }
      return next;
    });
  }, []);

  if (isLoading || isConfigsLoading)
    return (
      <Box data-testid="model-selection-loading" sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress size="md" />
      </Box>
    );
  if (error) return <div>Error loading models: {error.message}</div>;

  // Group models by backend for display
  const backendPriority = [
    SELF_HOSTED_BACKEND,
    'OpenAI',
    'Anthropic',
    'Google',
    'Meta',
    'xAI',
    'Mistral',
    'Black Forest Labs',
    'Cohere',
  ];
  const sortedBackends = Object.keys(modelsByBackend).sort((a, b) => {
    const aIndex = backendPriority.indexOf(a);
    const bIndex = backendPriority.indexOf(b);

    if (aIndex !== -1 && bIndex !== -1) {
      return aIndex - bIndex;
    }

    if (aIndex !== -1) return -1;
    if (bIndex !== -1) return 1;

    return a.localeCompare(b);
  });

  return (
    <Box
      ref={scrollContainerRef}
      sx={{
        width: '100%',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        // Must not be a scrollport: with no bounded height, `overflow: auto` here captures the
        // sticky row below and pins it to a box that never scrolls. The consumer scrolls.
        overflow: 'visible',
        px: 0,
        pr: { xs: 0, sm: '16px' },
      }}
    >
      {/* Search Input and Filter Dropdown */}
      <Box
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          // Opaque, matching the enclosing Sheet: cards scroll under this header.
          backgroundColor: 'background.surface',
          // Covers the container gap below without taking layout space, so cards don't
          // show in the space between the pinned header and the first card.
          boxShadow: `0 16px 0 var(--joy-palette-background-surface)`,
        }}
      >
        {stickyHeader}

        <Stack
          direction="row"
          sx={{
            alignItems: 'center',
            width: '100%',
            px: 0,
            gap: '8px',
            backgroundColor: 'background.surface',
          }}
        >
          {/* Search Input */}
          <Input
            ref={searchRef}
            data-testid="model-search-input"
            startDecorator={<SearchIcon sx={{ color: 'text.primary50', width: '16px', height: '16px' }} />}
            placeholder="Search models"
            value={searchQuery}
            onChange={handleSearchChange}
            endDecorator={
              searchQuery && <ClearIcon sx={{ cursor: 'pointer', color: 'neutral.500' }} onClick={clearSearch} />
            }
            sx={{
              flex: 1,
              height: '32px !important',
              minHeight: '32px !important',
              maxHeight: '32px !important',
              backgroundColor: 'var(--joy-palette-background-body)',
              border: '1px solid var(--joy-palette-divider)',
              borderRadius: '8px',
              boxShadow: 'none',
              '& input': {
                fontSize: '14px',
                '&::placeholder': {
                  color: 'text.primary',
                  fontSize: '14px',
                  fontWeight: '400',
                },
              },
              '&:focus-within': {
                borderColor: 'var(--joy-palette-primary-500)',
              },
            }}
          />

          {/* Model Filter Dropdown */}
          {onModelFilterChange && (
            <Select
              data-testid="model-filter-select"
              value={modelFilter}
              onChange={(_, newValue) => newValue && onModelFilterChange(newValue)}
              startDecorator={
                <FilterAltIcon
                  sx={{
                    color: 'text.primary',
                    width: '16px',
                    height: '16px',
                  }}
                />
              }
              endDecorator={
                <KeyboardArrowDownIcon
                  sx={{
                    color: 'var(--joy-palette-text-primary)',
                    width: '16px',
                    height: '16px',
                    strokeWidth: '3px',
                    display: { xs: 'none', sm: 'block' },
                  }}
                />
              }
              sx={theme => ({
                minWidth: { xs: '32px', sm: '140px' },
                width: { xs: '32px', sm: 'auto' },
                height: '32px !important',
                minHeight: '32px !important',
                maxHeight: '32px !important',
                backgroundColor: 'var(--joy-palette-background-body)',
                border: '1px solid var(--joy-palette-divider)',
                borderRadius: '8px',
                justifyContent: 'center',
                boxShadow: 'none',
                py: 0,
                transition: 'background 0.2s',
                // Matches the sidenav list items. Goes through Joy's own variant var because
                // its `:hover` rule outranks a plain `&:hover` here; this root is `outlined`.
                '--variant-outlinedHoverBg': theme.palette.notebooklist.hoverBg,
                // Zero on mobile: the button is 32px square and the 16px icon does not fit
                // inside 8px side padding, which knocked it off centre.
                paddingInline: { xs: 0, sm: '8px' },
                '& .MuiSelect-button': {
                  display: { xs: 'flex', sm: 'flex' },
                  position: { xs: 'absolute', sm: 'relative' },
                  top: { xs: 0, sm: 'auto' },
                  left: { xs: 0, sm: 'auto' },
                  zIndex: { xs: 100, sm: 'auto' },
                  width: '100%',
                  height: '100%',
                  alignItems: 'center',
                  justifyContent: { xs: 'center', sm: 'flex-start' },
                  gap: 1,
                  textAlign: 'left',
                  fontSize: { xs: '0px', sm: '14px' },
                  lineHeight: { xs: 0, sm: 'normal' },
                  color: { xs: 'transparent', sm: 'text.primary' },
                },
                // Desktop shows the label alone. Mobile hides the label and chevron, so the
                // icon is the only affordance there and must stay - centred by overlaying the
                // whole square rather than relying on the root's flex/padding.
                '& .MuiSelect-startDecorator': {
                  display: { xs: 'flex', sm: 'none' },
                  // Joy's start decorator pulls its icon left by --Select-paddingInline / -4
                  // (-3px at sizeMd) and adds --Select-gap on the end; both knock the icon off
                  // centre in the 32px mobile square.
                  '--Icon-margin': '0',
                  margin: 0,
                  position: 'absolute',
                  inset: 0,
                  alignItems: 'center',
                  justifyContent: 'center',
                  pointerEvents: 'none',
                },
                '& .MuiSelect-endDecorator': {
                  display: { xs: 'none', sm: 'inline-flex' },
                },
                '& .MuiSelect-indicator': {
                  display: 'none',
                },
                '&:focus-within': {
                  borderColor: 'var(--joy-palette-primary-500)',
                },
              })}
              slotProps={{
                listbox: {
                  sx: {
                    border: 'none !important',
                    py: '4px !important',
                    backgroundColor: 'var(--joy-palette-background-body)',
                    '& .MuiOption-root': {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1,
                      justifyContent: 'flex-start',
                      color: 'text.primary',
                      fontSize: '14px',
                      fontWeight: '400',
                      backgroundColor: 'var(--joy-palette-background-body)',
                    },
                  },
                  placement: 'bottom-end',
                  modifiers: [
                    { name: 'offset', options: { offset: [-0, 4] } },
                    { name: 'preventOverflow', options: { padding: 8 } },
                  ],
                },
              }}
            >
              <Option value="all" data-testid="model-filter-option-all">
                <Radio checked={modelFilter === 'all'} onChange={() => {}} size="sm" sx={checkBoxStyle} />
                All models
              </Option>
              <Option value="text" data-testid="model-filter-option-text">
                <Radio checked={modelFilter === 'text'} onChange={() => {}} size="sm" sx={checkBoxStyle} />
                Text models
              </Option>
              <Option value="image" data-testid="model-filter-option-image">
                <Radio checked={modelFilter === 'image'} onChange={() => {}} size="sm" sx={checkBoxStyle} />
                Image models
              </Option>
              <Option value="video" data-testid="model-filter-option-video">
                <Radio checked={modelFilter === 'video'} onChange={() => {}} size="sm" sx={checkBoxStyle} />
                Video models
              </Option>
            </Select>
          )}

          {/* Shows the layout it switches TO, so the icon reads as the action. Hidden below
              `sm`, where the layout is pinned to grid and the control would be a no-op. */}
          <Tooltip title={viewMode === 'list' ? 'Switch to grid view' : 'Switch to list view'}>
            <IconButton
              data-testid="model-view-mode-toggle"
              aria-label={viewMode === 'list' ? 'Switch to grid view' : 'Switch to list view'}
              onClick={() => setViewMode(current => (current === 'list' ? 'grid' : 'list'))}
              sx={theme => ({
                display: { xs: 'none', sm: 'inline-flex' },
                flexShrink: 0,
                '--IconButton-size': '32px',
                backgroundColor: 'var(--joy-palette-background-body)',
                border: '1px solid var(--joy-palette-divider)',
                borderRadius: '8px',
                transition: 'background 0.2s',
                '--variant-plainHoverBg': theme.palette.notebooklist.hoverBg,
                '--variant-plainActiveBg': theme.palette.notebooklist.hoverBg,
                '--variant-plainHoverColor': 'inherit',
              })}
            >
              {viewMode === 'list' ? (
                <GridViewOutlinedIcon sx={{ color: 'text.primary', width: '16px', height: '16px' }} />
              ) : (
                <ViewListOutlinedIcon sx={{ color: 'text.primary', width: '16px', height: '16px' }} />
              )}
            </IconButton>
          </Tooltip>

          {isAdmin && (
            <Tooltip title="Manage models in the LLM Dashboard">
              <IconButton
                data-testid="model-selection-manage-models-btn"
                onClick={handleManageModels}
                aria-label="Manage models"
                sx={theme => ({
                  flexShrink: 0,
                  // Drives min-width/min-height together; a plain `width` loses to Joy's
                  // size-variant min-width (36px at sizeMd).
                  '--IconButton-size': '32px',
                  backgroundColor: 'var(--joy-palette-background-body)',
                  border: '1px solid var(--joy-palette-divider)',
                  borderRadius: '8px',
                  transition: 'background 0.2s',
                  // Matches the sidenav list items; this root is `plain`, unlike the Select above.
                  '--variant-plainHoverBg': theme.palette.notebooklist.hoverBg,
                  '--variant-plainActiveBg': theme.palette.notebooklist.hoverBg,
                  '--variant-plainHoverColor': 'inherit',
                })}
              >
                <AdminPanelSettingsOutlinedIcon sx={{ color: 'text.primary', width: '16px', height: '16px' }} />
              </IconButton>
            </Tooltip>
          )}
        </Stack>
      </Box>

      {/* Models Grid */}
      {/* No access to any models */}
      {filteredModels.length === 0 && !debouncedSearchQuery && (
        <Box sx={{ padding: '32px', textAlign: 'center' }}>
          <Typography level="body-md" sx={{ color: 'text.primary', fontWeight: 500, mb: 1 }}>
            You don&apos;t have access to any AI models.
          </Typography>
          <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
            Please contact your administrator to request the appropriate permissions.
          </Typography>
        </Box>
      )}

      {/* No models found for search query */}
      {filteredModels.length === 0 && debouncedSearchQuery && (
        <Box sx={{ padding: '32px', textAlign: 'center' }}>
          <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
            No models found for &quot;{searchQuery}&quot;
          </Typography>
        </Box>
      )}

      {/* Display models */}
      {filteredModels.length > 0 && (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            height: {
              xs: isResearchModeFeatureEnabled ? 'calc(100dvh - 180px)' : 'calc(100dvh - 110px)',
              sm: 'auto',
            },
            width: '100%',
          }}
        >
          {/* Favorites Section */}
          {favoriteModels.length > 0 && (
            <Accordion
              data-testid="favorites-section"
              expanded={expandedBackends.has('Favorites')}
              onChange={() => toggleBackend('Favorites')}
              sx={theme => ({
                backgroundColor: 'background.surface',
                '& .MuiAccordionSummary-root': {
                  height: '48px !important',
                  minHeight: '48px !important',
                  maxHeight: '48px !important',
                  // Frame sits flush with the list; the 12px inset lives on the button so the
                  // hover fill covers it.
                  paddingInline: 0,
                },
                // Favorites only: breathing room above the cards once open. Lives on the root,
                // not the button - the root's height is pinned, so a margin there would shrink
                // the button instead of spacing the section.
                '& .MuiAccordionSummary-root.Mui-expanded': {
                  marginBottom: '8px',
                },
                '& .MuiAccordionSummary-button': {
                  paddingInline: '8px',
                  borderRadius: '6px',
                  transition: 'background 0.2s',
                  // Matches the sidenav list items. Must go through Joy's own variant vars:
                  // its `:not(...):hover` rule ties on specificity and lands later in the
                  // stylesheet, so a plain `&:hover` here loses.
                  '--variant-plainHoverBg': theme.palette.notebooklist.hoverBg,
                  '--variant-plainActiveBg': theme.palette.notebooklist.hoverBg,
                  // Sidenav rows keep their text colour on hover; Joy's plain variant darkens it.
                  '--variant-plainHoverColor': 'inherit',
                  // Joy's SvgIcon override reads `--Icon-color` rather than the inherited
                  // `color`, so the chevron only responds through the variable. The section
                  // logo/star set their own colour and are unaffected.
                  '--Icon-color': 'var(--joy-palette-text-tertiary)',
                  '& .MuiSvgIcon-root': {
                    transition: 'color 0.2s',
                  },
                  '&:hover': {
                    '--Icon-color': 'var(--joy-palette-text-primary)',
                  },
                },
                '&.Mui-expanded': {
                  pb: '16px',
                },
                '& .MuiAccordionSummary-indicator': {
                  display: 'none',
                },
                // Gives the first card's corner badge room to overhang. Joy clips this slot with
                // overflow: hidden, and its expanded top padding is calc(var(--ListItem-paddingY)
                // / 2) - a var no Accordion component defines, so the declaration is invalid and
                // computes to 0. Must stay scoped to .Mui-expanded: Joy zeroes paddingBlock while
                // collapsed so the section can animate to zero height.
                '& .MuiAccordionDetails-content.Mui-expanded': {
                  paddingBlockStart: '8px',
                },
              })}
            >
              <AccordionSummary sx={{ alignItems: 'center', justifyContent: 'space-between', minHeight: '48px' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                  <StarRounded sx={{ fontSize: '18px', color: 'primary.solidBg' }} />
                  <Typography
                    level="h4"
                    sx={{
                      color: 'text.primary',
                      fontSize: '16px',
                      fontWeight: 500,
                    }}
                  >
                    Favorites
                  </Typography>
                </Box>
                <ExpandMoreIcon
                  style={{
                    transform: expandedBackends.has('Favorites') ? 'rotate(180deg)' : 'none',
                  }}
                />
              </AccordionSummary>
              <AccordionDetails>
                {expandedBackends.has('Favorites') && (
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: effectiveViewMode === 'list' ? '1fr' : { xs: '1fr', lg: 'repeat(2, 1fr)' },
                      gap: 2,
                    }}
                  >
                    {favoriteModels.map(modelInfo => (
                      <ModelOption
                        key={modelInfo.id}
                        model={modelInfo}
                        isSelected={modelInfo.id === model}
                        maxContextWindow={maxContextWindow}
                        maxTokens={maxTokens}
                        onSelect={handleModelSelect}
                        onSettingsClick={onSettingsClick ? handleSettingsClick : undefined}
                        isFavorite={true}
                        onToggleFavorite={toggleFavorite}
                        avgResponseTimeByModel={avgResponseTimeByModel}
                        statsLoading={statsLoading}
                        mode={mode}
                        viewMode={effectiveViewMode}
                      />
                    ))}
                  </Box>
                )}
              </AccordionDetails>
            </Accordion>
          )}

          {sortedBackends.map(backend => (
            <Accordion
              key={backend}
              expanded={expandedBackends.has(backend)}
              onChange={() => toggleBackend(backend)}
              sx={theme => ({
                backgroundColor: 'background.surface',
                '& .MuiAccordionSummary-root': {
                  height: '48px !important',
                  minHeight: '48px !important',
                  maxHeight: '48px !important',
                  // Frame sits flush with the list; the 12px inset lives on the button so the
                  // hover fill covers it.
                  paddingInline: 0,
                },
                '& .MuiAccordionSummary-button': {
                  paddingInline: '8px',
                  borderRadius: '6px',
                  transition: 'background 0.2s',
                  // Matches the sidenav list items. Must go through Joy's own variant vars:
                  // its `:not(...):hover` rule ties on specificity and lands later in the
                  // stylesheet, so a plain `&:hover` here loses.
                  '--variant-plainHoverBg': theme.palette.notebooklist.hoverBg,
                  '--variant-plainActiveBg': theme.palette.notebooklist.hoverBg,
                  // Sidenav rows keep their text colour on hover; Joy's plain variant darkens it.
                  '--variant-plainHoverColor': 'inherit',
                  // Joy's SvgIcon override reads `--Icon-color` rather than the inherited
                  // `color`, so the chevron only responds through the variable. The section
                  // logo/star set their own colour and are unaffected.
                  '--Icon-color': 'var(--joy-palette-text-tertiary)',
                  '& .MuiSvgIcon-root': {
                    transition: 'color 0.2s',
                  },
                  '&:hover': {
                    '--Icon-color': 'var(--joy-palette-text-primary)',
                  },
                },
                '&.Mui-expanded': {
                  pb: '16px',
                },
                '& .MuiAccordionSummary-indicator': {
                  display: 'none',
                },
                // Gives the first card's corner badge room to overhang. Joy clips this slot with
                // overflow: hidden, and its expanded top padding is calc(var(--ListItem-paddingY)
                // / 2) - a var no Accordion component defines, so the declaration is invalid and
                // computes to 0. Must stay scoped to .Mui-expanded: Joy zeroes paddingBlock while
                // collapsed so the section can animate to zero height.
                '& .MuiAccordionDetails-content.Mui-expanded': {
                  paddingBlockStart: '8px',
                },
              })}
            >
              <AccordionSummary sx={{ alignItems: 'center', justifyContent: 'space-between', minHeight: '48px' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                  {backendLogos[backend] && (
                    <img
                      src={backendLogos[backend]!}
                      alt={`${backend} logo`}
                      style={{
                        width: '16px',
                        height: '16px',
                        flex: 'none',
                        objectFit: 'contain',
                        filter: mode === 'dark' ? 'brightness(0) invert(1)' : 'none',
                      }}
                    />
                  )}
                  <Typography
                    level="h4"
                    sx={{
                      color: 'text.primary',
                      fontSize: '16px',
                      fontWeight: 500,
                    }}
                  >
                    {backend}
                  </Typography>
                </Box>
                <ExpandMoreIcon
                  style={{
                    transform: expandedBackends.has(backend) ? 'rotate(180deg)' : 'none',
                  }}
                />
              </AccordionSummary>
              <AccordionDetails>
                {expandedBackends.has(backend) &&
                  (modelsByBackendAndType[backend] ? (
                    // Always show text/image sections within each backend
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {/* Text Models Section */}
                      {modelsByBackendAndType[backend].text && modelsByBackendAndType[backend].text.length > 0 && (
                        <Box>
                          <Typography
                            level="h4"
                            sx={{
                              color: 'text.primary50',
                              fontSize: '14px',
                              fontWeight: '400',
                              mt: '8px',
                              ml: '8px',
                              mb: 2,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 1,
                            }}
                          >
                            <ChatIcon sx={{ fontSize: '14px', color: 'text.primary50' }} />
                            Text Models
                          </Typography>
                          <Box
                            sx={{
                              display: 'grid',
                              gridTemplateColumns:
                                effectiveViewMode === 'list' ? '1fr' : { xs: '1fr', lg: 'repeat(2, 1fr)' },
                              gap: 2,
                            }}
                          >
                            {modelsByBackendAndType[backend].text.map(modelInfo => (
                              <ModelOption
                                key={modelInfo.id}
                                model={modelInfo}
                                isSelected={modelInfo.id === model}
                                maxContextWindow={maxContextWindow}
                                maxTokens={maxTokens}
                                onSelect={handleModelSelect}
                                onSettingsClick={onSettingsClick ? handleSettingsClick : undefined}
                                isFavorite={isFavorite(modelInfo.id)}
                                onToggleFavorite={toggleFavorite}
                                avgResponseTimeByModel={avgResponseTimeByModel}
                                statsLoading={statsLoading}
                                mode={mode}
                                viewMode={effectiveViewMode}
                              />
                            ))}
                          </Box>
                        </Box>
                      )}

                      {/* Image Generation Models Section */}
                      {modelsByBackendAndType[backend].image && modelsByBackendAndType[backend].image.length > 0 && (
                        <Box>
                          <Typography
                            level="h4"
                            sx={{
                              color: 'text.primary50',
                              fontSize: '14px',
                              fontWeight: '400',
                              mt: '8px',
                              ml: '8px',
                              mb: 2,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 1,
                            }}
                          >
                            <ImageIcon sx={{ fontSize: '14px', color: 'text.primary50' }} />
                            Image Generation Models
                          </Typography>
                          <Box
                            sx={{
                              display: 'grid',
                              gridTemplateColumns:
                                effectiveViewMode === 'list' ? '1fr' : { xs: '1fr', lg: 'repeat(2, 1fr)' },
                              gap: 2,
                            }}
                          >
                            {modelsByBackendAndType[backend].image.map(modelInfo => (
                              <ModelOption
                                key={modelInfo.id}
                                model={modelInfo}
                                isSelected={modelInfo.id === model}
                                maxContextWindow={maxContextWindow}
                                maxTokens={maxTokens}
                                onSelect={handleModelSelect}
                                onSettingsClick={onSettingsClick ? handleSettingsClick : undefined}
                                isFavorite={isFavorite(modelInfo.id)}
                                onToggleFavorite={toggleFavorite}
                                avgResponseTimeByModel={avgResponseTimeByModel}
                                statsLoading={statsLoading}
                                mode={mode}
                                viewMode={effectiveViewMode}
                              />
                            ))}
                          </Box>
                        </Box>
                      )}

                      {/* Video Generation Models Section */}
                      {modelsByBackendAndType[backend].video && modelsByBackendAndType[backend].video.length > 0 && (
                        <Box>
                          <Typography
                            level="h4"
                            sx={{
                              color: 'text.primary50',
                              fontSize: '14px',
                              fontWeight: '400',
                              mt: '8px',
                              ml: '8px',
                              mb: 2,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 1,
                            }}
                          >
                            <VideoIcon sx={{ fontSize: '14px', color: 'text.primary50' }} />
                            Video Generation Models
                          </Typography>
                          <Box
                            sx={{
                              display: 'grid',
                              gridTemplateColumns:
                                effectiveViewMode === 'list' ? '1fr' : { xs: '1fr', lg: 'repeat(2, 1fr)' },
                              gap: 2,
                            }}
                          >
                            {modelsByBackendAndType[backend].video.map(modelInfo => (
                              <ModelOption
                                key={modelInfo.id}
                                model={modelInfo}
                                isSelected={modelInfo.id === model}
                                maxContextWindow={maxContextWindow}
                                maxTokens={maxTokens}
                                onSelect={handleModelSelect}
                                onSettingsClick={onSettingsClick ? handleSettingsClick : undefined}
                                isFavorite={isFavorite(modelInfo.id)}
                                onToggleFavorite={toggleFavorite}
                                avgResponseTimeByModel={avgResponseTimeByModel}
                                statsLoading={statsLoading}
                                mode={mode}
                                viewMode={effectiveViewMode}
                              />
                            ))}
                          </Box>
                        </Box>
                      )}
                    </Box>
                  ) : (
                    // Fallback to normal single-type view if grouping data is not available
                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: effectiveViewMode === 'list' ? '1fr' : { xs: '1fr', lg: 'repeat(2, 1fr)' },
                        gap: 2,
                      }}
                    >
                      {modelsByBackend[backend].map(modelInfo => (
                        <ModelOption
                          key={modelInfo.id}
                          model={modelInfo}
                          isSelected={modelInfo.id === model}
                          maxContextWindow={maxContextWindow}
                          maxTokens={maxTokens}
                          onSelect={handleModelSelect}
                          onSettingsClick={onSettingsClick ? handleSettingsClick : undefined}
                          isFavorite={isFavorite(modelInfo.id)}
                          onToggleFavorite={toggleFavorite}
                          avgResponseTimeByModel={avgResponseTimeByModel}
                          statsLoading={statsLoading}
                          mode={mode}
                          viewMode={effectiveViewMode}
                        />
                      ))}
                    </Box>
                  ))}
              </AccordionDetails>
            </Accordion>
          ))}
        </Box>
      )}
    </Box>
  );
};

export default ModelSelection;
