import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
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
import ChatIcon from '@mui/icons-material/Chat';
import ImageIcon from '@mui/icons-material/Image';
import VideoIcon from '@mui/icons-material/Videocam';
import StarRounded from '@mui/icons-material/StarRounded';
import StarBorderRounded from '@mui/icons-material/StarBorderRounded';
import ClearIcon from '@mui/icons-material/Clear';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AdminPanelSettingsOutlinedIcon from '@mui/icons-material/AdminPanelSettingsOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import ViewListOutlinedIcon from '@mui/icons-material/ViewListOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import { useNavigate } from '@tanstack/react-router';
import { useUser } from '@client/app/contexts/UserContext';
import { useAdminSettings } from '@client/app/contexts/AdminSettingsContext';
import { resolveRecommendedModelIds } from '@client/app/utils/recommendedModels';
import { dedupeModelsForPicker, splitModelsByRoute } from '@client/app/utils/pickerModelDedupe';
import { useAdminModal } from '@client/app/components/admin/useAdminModal';
import { AdminTab } from '@client/app/components/admin/adminSidebarConfig';
import { adminTabToSlug } from '@client/app/components/admin/adminTabSlugs';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useBillingView } from '@client/app/components/subscription/BillingDeepLinkModals';
import LockedModelsSection from './LockedModelsSection';
import { useAccessibleModels } from '@client/app/hooks/useAccessibleModels';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import { ModelName, ModelInfo, ModelBackend, SpeechToTextModels, isModelDeprecated } from '@bike4mind/common';
import SearchIcon from '@mui/icons-material/Search';
import { sortModelsForPicker } from '@client/app/utils/modelRanking';
import { useTheme } from '@mui/joy';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import {
  getModelPriceTier,
  isOpenAIModel,
  getModelSpeedFromStats,
  isNewModel,
} from '@client/app/utils/aiSettingsUtils';
import MetadataChip from './AISettings/MetaDataChips';
import {
  BEDROCK_BADGE_BG,
  CapabilityIndicators,
  CornerBadge,
  MetricIndicators,
  NEW_BADGE_BG,
  SelectedCheckIcon,
  formatContextWindow,
  formatNumber,
} from './AISettings/modelIndicators';
import { useModelStats } from '@client/app/hooks/data/useModelStats';
import { useFavoriteModels } from '@client/app/hooks/useFavoriteModels';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { menuSurfaceSx, selectListboxSx } from '@client/app/components/layouts/Notebook/Sidenav/menuSurfaceSx';

// List of model IDs to exclude from the dropdown
// Add any model IDs you want to hide here
const emptyRecord: Record<string, number> = {};
const emptyIds: string[] = [];

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

/**
 * Matches the sidenav Filters panel's radios (`Sidenav/FiltersPanel.tsx`) so the two filter menus
 * read as the same control. No `mr` here - the row's own gap owns the spacing, as it does there.
 */
const filterRadioSx = {
  '--Radio-size': '20px',
  // Inner checked dot pinned to 12x12; Joy's default scales it off --Radio-size.
  '& .MuiRadio-icon': { width: '12px', height: '12px', borderRadius: '50%' },
} as const;

// Backend section logos. Providers absent here (Google, Moonshot, DeepSeek, ...)
// render as text-only headers - shared by getBackendLogo and preloadBackendLogos.
const BACKEND_LOGOS: Record<string, string> = {
  OpenAI: '/images/logos/llm/llm-logo-openai.png',
  Anthropic: '/images/logos/llm/llm-logo-anthropic.png',
  Meta: '/images/logos/llm/llm-logo-meta.png',
  'Black Forest Labs': '/images/logos/llm/llm-logo-bfl.png',
  xAI: '/images/logos/XAI_Logo.svg',
};

// Function to get backend logo path
const getBackendLogo = (backend: string): string | null => BACKEND_LOGOS[backend] || null;

// Shared by the accessible and locked sections so one query filters both the same way.
const modelMatchesSearch = (candidate: ModelInfo, searchLower: string) =>
  !searchLower ||
  candidate.name.toLowerCase().includes(searchLower) ||
  !!candidate.description?.toLowerCase().includes(searchLower);

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
  const preloadPromises = Object.values(BACKEND_LOGOS).map(src => preloadAndCacheImage(src));
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
  /** Rendered inside the sticky header, above the search/filter row, so it pins with it. */
  stickyHeader?: React.ReactNode;
}

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

  // OpenAI models
  if (isOpenAIModel(modelName)) {
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

  // Moonshot models. Matches the Bedrock-served ids (moonshot./moonshotai.) too,
  // so the direct and Bedrock copies group together under one maker.
  if (modelName.includes('kimi') || modelId.includes('kimi') || modelId.startsWith('moonshot')) {
    return 'Moonshot';
  }

  // DeepSeek models: first-party (deepseek-flash, deepseek-v4-pro) and the
  // Bedrock-served rows (us.deepseek.r1-v1:0, deepseek.v3-v1:0) all contain
  // "deepseek" in id/name. The Ollama-hosted deepseek-r1:latest also does, so it
  // is excluded by backend here rather than by string, and is caught by the
  // self-host branch above (or has no vendor grouping to speak of if a hosted
  // deployment ever surfaced a remote Ollama model).
  if (model.backend !== ModelBackend.Ollama && (modelName.includes('deepseek') || modelId.includes('deepseek'))) {
    return 'DeepSeek';
  }

  // Default to "Other" if no match found
  return 'Other';
};

// Display order of the provider sections. Anything absent sorts alphabetically after these.
// Exported for the ordering test - the next provider added here gets a signal if it's forgotten.
export const BACKEND_PRIORITY = [
  SELF_HOSTED_BACKEND,
  'OpenAI',
  'Anthropic',
  'Google',
  'Meta',
  'xAI',
  'DeepSeek',
  'Moonshot',
  'Mistral',
  'Black Forest Labs',
  'Cohere',
];

// Non-mutating: callers pass a fresh Object.keys() array, but the copy keeps that a contract
// of this function rather than of each call site.
export const sortBackendsByPriority = (backends: string[]): string[] =>
  [...backends].sort((a, b) => {
    const aIndex = BACKEND_PRIORITY.indexOf(a);
    const bIndex = BACKEND_PRIORITY.indexOf(b);

    if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
    if (aIndex !== -1) return -1;
    if (bIndex !== -1) return 1;

    return a.localeCompare(b);
  });

// Layout of the model list: roomy cards in a 2-up grid, or compact single-column rows.
export type ModelViewMode = 'grid' | 'list';

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
    // Only reached for the active model (dedupeModelsForPicker hides the rest), so it stays visible
    // but can't be re-picked: no click handler, a not-allowed cursor, dimmed, no hover affordance.
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
          // Otherwise the tooltip's title becomes the button's accessible name, hiding the model name.
          describeChild
        >
          {/* The card's keyboard entry point: a native button whose click bubbles to the card's
              onClick, so Enter and Space select exactly as a pointer click does. */}
          <Box
            component="button"
            type="button"
            data-testid={`model-select-btn-${model.id}`}
            disabled={isDisabled}
            aria-pressed={isSelected}
            sx={{
              all: 'unset',
              cursor: 'inherit',
              borderRadius: '4px',
              '&:focus-visible': { outline: '2px solid var(--joy-palette-focusVisible)', outlineOffset: '2px' },
            }}
          >
            <Typography
              component="span"
              level="body-md"
              sx={{
                textAlign: 'left',
                color: 'text.primary',
                fontWeight: '500',
              }}
            >
              {model.name}
            </Typography>
          </Box>
        </Tooltip>
        {/* Selected Checkmark - sits right of the model name */}
        {isSelected && <SelectedCheckIcon />}
      </Box>
    );

    const favoriteLabel = isFavorite ? 'Remove from favorites' : 'Add to favorites';
    // Every row has a star and a gear, so the accessible names carry the model to tell them apart.
    const favoriteAriaLabel = isFavorite ? `Remove ${model.name} from favorites` : `Add ${model.name} to favorites`;
    const favoriteToggle = onToggleFavorite && (
      <Tooltip title={favoriteLabel} placement="bottom">
        <IconButton
          data-testid={`favorite-toggle-${model.id}`}
          aria-label={favoriteAriaLabel}
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
          aria-label={`View ${model.name} details and settings`}
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
      <MetricIndicators priceTier={priceTierInfo} modelSpeed={modelSpeed} statsLoading={statsLoading} model={model} />
    );

    const capabilityIndicators = <CapabilityIndicators model={model} />;

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
        {/* fit-content keeps the tooltip anchored to the number. Typography renders a block <p>,
            which as a flex item in the list row's stretch column spanned the full card width, so
            the tooltip centred itself over the middle of the row instead of over the text. */}
        <Typography sx={{ fontSize: { xs: '12px' }, color: 'text.primary50', fontWeight: '500', width: 'fit-content' }}>
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
  stickyHeader,
}) => {
  const { isLoading, error } = useModelInfo();
  const {
    accessibleModels,
    accessibleTextModels,
    accessibleImageModels,
    accessibleVideoModels,
    lockedModels,
    isLoading: isConfigsLoading,
  } = useAccessibleModels();
  const { openView: openBillingView } = useBillingView();
  // The billing modal only mounts with credits enforced (BillingDeepLinkModals), so the CTA would open nothing otherwise.
  const isBillingEnabled = !!useGetSettingsValue('enforceCredits');
  const theme = useTheme();
  const mode = theme.palette.mode;
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
  const { favoriteModelIds, isFavorite, toggleFavorite } = useFavoriteModels();
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
    new Set(['Recommended', 'Favorites', 'OpenAI', 'Anthropic'])
  );

  const [expandedOlderBackends, setExpandedOlderBackends] = useState<Set<string>>(new Set());

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

  const { getSetting, getSettingObject } = useAdminSettings();
  const storedRecommendedIds = getSettingObject<string[]>('recommendedModelIds', emptyIds);
  const defaultModelId = getSetting('DefaultAPIModel');

  // Favor pinned ids in provider groups unless the active model is an enabled twin.
  const preferredModelIds = useMemo(
    () => new Set([...favoriteModelIds, ...resolveRecommendedModelIds(storedRecommendedIds, defaultModelId)]),
    [favoriteModelIds, storedRecommendedIds, defaultModelId]
  );

  const { filteredModels, hiddenPinnedModels, maxContextWindow, maxTokens, modelsByBackend } = useMemo(() => {
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

    // Bedrock profiles, dated snapshots and unavailable rows collapse to one usable row per model.
    const deduped = dedupeModelsForPicker(withoutDeprecated, preferredModelIds, model);

    const searchLower = debouncedSearchQuery.toLowerCase();
    const matchesSearch = (candidate: ModelInfo) => modelMatchesSearch(candidate, searchLower);
    const searchFiltered = deduped.filter(matchesSearch);

    // Pinned sections can still show their exact ids when an enabled active twin wins the
    // provider row. Keep their own access, availability and search filters in step.
    const hiddenPinnedModels = withoutDeprecated.filter(
      candidate =>
        preferredModelIds.has(String(candidate.id)) &&
        !deduped.includes(candidate) &&
        (!candidate.disabled || candidate.id === model) &&
        matchesSearch(candidate)
    );

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

    // Sort within each backend by curated rank, then recency (see modelRanking.ts)
    Object.keys(grouped).forEach(backend => {
      grouped[backend] = sortModelsForPicker(grouped[backend]);
    });

    // Flatten the sorted models
    const sorted = sortBackendsByPriority(Object.keys(grouped)).flatMap(backend => grouped[backend]);

    // Find maximum values
    let maxCtx = 0;
    let maxTok = 0;

    searchFiltered.forEach(m => {
      if (m.contextWindow > maxCtx) maxCtx = m.contextWindow;
      if (m.max_tokens > maxTok) maxTok = m.max_tokens;
    });

    return {
      filteredModels: sorted,
      hiddenPinnedModels,
      maxContextWindow: maxCtx,
      maxTokens: maxTok,
      modelsByBackend: grouped,
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
    preferredModelIds,
    model,
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
  const favoriteModels = useMemo(
    () => [...filteredModels, ...hiddenPinnedModels].filter(m => isFavorite(m.id)),
    [filteredModels, hiddenPinnedModels, isFavorite]
  );

  // Admin-ordered ids -> models. Reads from filteredModels so search, type filter and access
  // control apply, and an id that is unknown or inaccessible is dropped rather than shown dead.
  const recommendedModels = useMemo(() => {
    const byId = new Map<string, ModelInfo>([...filteredModels, ...hiddenPinnedModels].map(m => [m.id, m]));
    return resolveRecommendedModelIds(storedRecommendedIds, defaultModelId).flatMap(id => {
      const found = byId.get(id);
      return found ? [found] : [];
    });
  }, [filteredModels, hiddenPinnedModels, storedRecommendedIds, defaultModelId]);

  // Provider section order for display. Same ordering the memo above applies when flattening
  // filteredModels, so the accordions and the flat list agree.
  const sortedBackends = useMemo(() => sortBackendsByPriority(Object.keys(modelsByBackend)), [modelsByBackend]);

  // A pinned twin can match a search while the provider row's winner does not, so the empty
  // state has to consider the pinned sections too.
  const hasVisibleModels = filteredModels.length > 0 || hiddenPinnedModels.length > 0;

  // Derive effective expanded backends from user toggles and search state
  const expandedBackends = useMemo(() => {
    if (debouncedSearchQuery) {
      // Expand all backends (including Favorites) when searching
      const all = new Set(Object.keys(modelsByBackend));
      all.add('Recommended');
      all.add('Favorites');
      return all;
    }
    return userToggledBackends;
  }, [debouncedSearchQuery, modelsByBackend, userToggledBackends]);

  // lastUsedTextModel / lastUsedImageModel now ride along in buildModelSelectionPatch, which
  // setModel applies - see aiSettingsUtils.
  const handleUpgrade = useCallback(() => {
    onSelectionComplete?.();
    openBillingView('plans');
  }, [onSelectionComplete, openBillingView]);

  // The free-tier gate locks every modality, so the locked group follows the type the list shows
  // (same choice as `availableModels` above).
  const shownLockedType: ModelInfo['type'] | null = showAllModels
    ? null
    : modelFilter === 'video'
      ? 'video'
      : imageModel
        ? 'image'
        : 'text';
  const lockedPickerModels = useMemo(() => {
    if (!lockedModels) return [];
    const searchLower = debouncedSearchQuery.toLowerCase();
    const shown = lockedModels.filter(
      candidate =>
        (shownLockedType === null || candidate.type === shownLockedType) &&
        !isModelDeprecated(candidate) &&
        !EXCLUDED_MODEL_IDS.includes(candidate.id) &&
        modelMatchesSearch(candidate, searchLower)
    );
    // Same dedupe as the main list: drops disabled models (no plan unlocks them) and collapses twins.
    return sortModelsForPicker(dedupeModelsForPicker(shown, new Set(), model));
  }, [shownLockedType, lockedModels, debouncedSearchQuery, model]);

  const handleModelSelect = useCallback(
    (selectedModel: ModelInfo) => {
      setModel(selectedModel.id);
      onSelectionComplete?.();
    },
    [onSelectionComplete, setModel]
  );

  // The tab is set in the store and named in the URL: the admin page mirrors one into the
  // other, and a bare /admin would strip ?tab= if the page is already mounted. The picker
  // lives in a modal that would otherwise stay mounted over the admin page, hence the close callback.
  const handleManageModels = useCallback(() => {
    setAdminTab(AdminTab.LLMDashboard);
    onSelectionComplete?.();
    navigate({ to: '/admin', search: { tab: adminTabToSlug(AdminTab.LLMDashboard) } });
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

  const renderModelCards = (cards: ModelInfo[]) => (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: effectiveViewMode === 'list' ? '1fr' : { xs: '1fr', lg: 'repeat(2, 1fr)' },
        gap: 2,
      }}
    >
      {cards.map(modelInfo => (
        <ModelOption
          key={modelInfo.id}
          model={modelInfo}
          isSelected={modelInfo.id === model}
          maxContextWindow={maxContextWindow}
          maxTokens={maxTokens}
          onSelect={handleModelSelect}
          onSettingsClick={onSettingsClick}
          isFavorite={isFavorite(modelInfo.id)}
          onToggleFavorite={toggleFavorite}
          avgResponseTimeByModel={avgResponseTimeByModel}
          statsLoading={statsLoading}
          mode={mode}
          viewMode={effectiveViewMode}
        />
      ))}
    </Box>
  );

  // Pinned sections (Recommended, Favorites) sit above the provider accordions and share one
  // layout; only the key, label, icon and model list differ.
  const renderPinnedSection = ({
    sectionKey,
    testId,
    label,
    icon,
    sectionModels,
  }: {
    sectionKey: string;
    testId: string;
    label: string;
    icon: React.ReactNode;
    sectionModels: ModelInfo[];
  }) => (
    <Accordion
      data-testid={testId}
      expanded={expandedBackends.has(sectionKey)}
      onChange={() => toggleBackend(sectionKey)}
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
          {icon}
          <Typography
            level="h4"
            sx={{
              color: 'text.primary',
              fontSize: '16px',
              fontWeight: 500,
            }}
          >
            {label}
          </Typography>
        </Box>
        <ExpandMoreIcon
          style={{
            transform: expandedBackends.has(sectionKey) ? 'rotate(180deg)' : 'none',
          }}
        />
      </AccordionSummary>
      <AccordionDetails>{expandedBackends.has(sectionKey) && renderModelCards(sectionModels)}</AccordionDetails>
    </Accordion>
  );

  // Direct-API rows first, then the maker's Bedrock routes under their own heading, so two cards
  // with the same name are never neighbours told apart only by a corner badge.
  const renderProviderModels = (backend: string, cards: ModelInfo[], section: string) => {
    const { direct, bedrock } = splitModelsByRoute(cards);
    if (direct.length === 0 || bedrock.length === 0) return renderModelCards(cards);
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {renderModelCards(direct)}
        <Box
          data-testid={`bedrock-route-section-${backend}-${section}`}
          sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}
        >
          <Box sx={{ ml: '8px' }}>
            <Typography level="title-sm" sx={{ color: 'text.primary' }}>
              Via AWS Bedrock
            </Typography>
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
              Served through AWS Bedrock instead of the provider&apos;s own API.
            </Typography>
          </Box>
          {renderModelCards(bedrock)}
        </Box>
      </Box>
    );
  };

  const renderProviderTypes = (backend: string, cards: ModelInfo[], section: string) => (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {(
        [
          ['text', 'Text Models', ChatIcon],
          ['image', 'Image Generation Models', ImageIcon],
          ['video', 'Video Generation Models', VideoIcon],
        ] as const
      ).map(([type, label, Icon]) => {
        const typeModels = cards.filter(candidate =>
          type === 'text' ? candidate.type !== 'image' && candidate.type !== 'video' : candidate.type === type
        );
        if (typeModels.length === 0) return null;
        return (
          <Box key={type}>
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
              <Icon sx={{ fontSize: '14px', color: 'text.primary50' }} />
              {label}
            </Typography>
            {renderProviderModels(backend, typeModels, section === 'current' ? type : `${section}-${type}`)}
          </Box>
        );
      })}
    </Box>
  );

  const renderProviderContent = (backend: string) => {
    const cards = modelsByBackend[backend];
    const currentModels = cards.filter(candidate => !candidate.isSuperseded);
    const olderModels = cards.filter(candidate => candidate.isSuperseded);
    const olderExpanded = !!debouncedSearchQuery || expandedOlderBackends.has(backend);
    const selectedOlderModels = olderModels.filter(candidate => candidate.id === model);
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {currentModels.length > 0 && renderProviderTypes(backend, currentModels, 'current')}
        {olderModels.length > 0 && (
          <Box data-testid={`older-models-section-${backend}`}>
            <Button
              variant="plain"
              color="neutral"
              data-testid={`older-models-toggle-${backend}`}
              disabled={!!debouncedSearchQuery}
              aria-expanded={olderExpanded}
              aria-controls={`older-models-content-${backend}`}
              endDecorator={<ExpandMoreIcon sx={{ transform: olderExpanded ? 'rotate(180deg)' : 'none' }} />}
              onClick={() =>
                setExpandedOlderBackends(previous => {
                  const next = new Set(previous);
                  if (next.has(backend)) next.delete(backend);
                  else next.add(backend);
                  return next;
                })
              }
            >
              Older models ({olderModels.length})
            </Button>
            <Box id={`older-models-content-${backend}`} hidden={!olderExpanded}>
              {olderExpanded && renderProviderTypes(backend, olderModels, 'older')}
            </Box>
            {!olderExpanded && selectedOlderModels.length > 0 && (
              <Box sx={{ mt: 2 }}>{renderModelCards(selectedOlderModels)}</Box>
            )}
          </Box>
        )}
      </Box>
    );
  };

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
                  sx: theme => ({ ...menuSurfaceSx(theme), ...selectListboxSx(theme) }),
                  placement: 'bottom-end',
                  modifiers: [
                    { name: 'offset', options: { offset: [-0, 4] } },
                    { name: 'preventOverflow', options: { padding: 8 } },
                  ],
                },
              }}
            >
              <Option value="all" data-testid="model-filter-option-all">
                <Radio
                  checked={modelFilter === 'all'}
                  onChange={() => {}}
                  size="sm"
                  color="success"
                  sx={filterRadioSx}
                />
                All models
              </Option>
              <Option value="text" data-testid="model-filter-option-text">
                <Radio
                  checked={modelFilter === 'text'}
                  onChange={() => {}}
                  size="sm"
                  color="success"
                  sx={filterRadioSx}
                />
                Text models
              </Option>
              <Option value="image" data-testid="model-filter-option-image">
                <Radio
                  checked={modelFilter === 'image'}
                  onChange={() => {}}
                  size="sm"
                  color="success"
                  sx={filterRadioSx}
                />
                Image models
              </Option>
              <Option value="video" data-testid="model-filter-option-video">
                <Radio
                  checked={modelFilter === 'video'}
                  onChange={() => {}}
                  size="sm"
                  color="success"
                  sx={filterRadioSx}
                />
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
      {!hasVisibleModels && lockedPickerModels.length === 0 && !debouncedSearchQuery && (
        <Box data-testid="model-selection-no-access" sx={{ padding: '32px', textAlign: 'center' }}>
          <Typography level="body-md" sx={{ color: 'text.primary', fontWeight: 500, mb: 1 }}>
            You don&apos;t have access to any AI models.
          </Typography>
          <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
            Please contact your administrator to request the appropriate permissions.
          </Typography>
        </Box>
      )}

      {/* No models found for search query */}
      {!hasVisibleModels && lockedPickerModels.length === 0 && debouncedSearchQuery && (
        <Box data-testid="model-selection-no-results" sx={{ padding: '32px', textAlign: 'center' }}>
          <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
            No models found for &quot;{searchQuery}&quot;
          </Typography>
        </Box>
      )}

      {/* Display models */}
      {hasVisibleModels && (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            height: {
              xs: 'calc(100dvh - 180px)',
              sm: 'auto',
            },
            width: '100%',
          }}
        >
          {recommendedModels.length > 0 &&
            renderPinnedSection({
              sectionKey: 'Recommended',
              testId: 'recommended-section',
              label: 'Recommended',
              icon: <AutoAwesomeRoundedIcon sx={{ fontSize: '18px', color: 'primary.solidBg' }} />,
              sectionModels: recommendedModels,
            })}

          {favoriteModels.length > 0 &&
            renderPinnedSection({
              sectionKey: 'Favorites',
              testId: 'favorites-section',
              label: 'Favorites',
              icon: <StarRounded sx={{ fontSize: '18px', color: 'primary.solidBg' }} />,
              sectionModels: favoriteModels,
            })}

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
              <AccordionDetails>{expandedBackends.has(backend) && renderProviderContent(backend)}</AccordionDetails>
            </Accordion>
          ))}
        </Box>
      )}

      <LockedModelsSection models={lockedPickerModels} onUpgrade={isBillingEnabled ? handleUpgrade : undefined} />
    </Box>
  );
};

export default ModelSelection;
