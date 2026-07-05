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
  Button,
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
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { useAccessibleModels } from '@client/app/hooks/useAccessibleModels';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import { ModelName, ModelInfo, ModelBackend, SpeechToTextModels, isModelDeprecated } from '@bike4mind/common';
import SearchIcon from '@mui/icons-material/Search';
import { sortModelsByCapability } from '@client/app/utils/modelRanking';
import { useTheme } from '@mui/joy';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { useLLM } from '@client/app/contexts/LLMContext';
import {
  getModelPriceTier,
  isOpenAIModel,
  getModelSpeedVariant,
  getModelSpeedTooltip,
  getTopUsedModelsFromStats,
  getModelSpeedFromStats,
  getPriceTierTooltip,
  isNewModel,
} from '@client/app/utils/aiSettingsUtils';
import MetadataChip from './AISettings/MetaDataChips';
import { useModelStats } from '@client/app/hooks/data/useModelStats';
import { isImageModel } from '@client/app/utils/commands';
import { green, greenAlpha, orange } from '@client/app/utils/themes/colors';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import { useFavoriteModels } from '@client/app/hooks/useFavoriteModels';

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
    'OPEN AI': '/images/logos/llm/llm-logo-openai.png',
    Anthropic: '/images/logos/llm/llm-logo-anthropic.png',
    Meta: '/images/logos/llm/llm-logo-meta.png',
    'Black Forest Labs': '/images/logos/llm/llm-logo-bfl.png',
    xAI: '/images/logos/XAI_Logo.svg',
  };

  return logoMap[backend] || null;
};

// Badge shown on each model card hosted via AWS Bedrock. Deliberately kept separate
// from getBackendLogo() above: that map returns provider logos (OpenAI, Anthropic, ...)
// keyed by who authored the model, whereas this marks the hosting platform - any
// provider's model can be Bedrock-hosted, so it's a different axis, not another entry.
// Note: the asset bakes in a teal (#01A88D) background so it reads in both light and
// dark themes; a transparent/outlined variant would require re-cutting the SVG.
const BEDROCK_LOGO_SRC = '/images/logos/llm/llm-logo-bedrock.svg';

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
    'OPEN AI': '/images/logos/llm/llm-logo-openai.png',
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
  imageModel: boolean;
  showAllModels?: boolean;
  modelFilter?: 'all' | 'text' | 'image' | 'video';
  onModelFilterChange?: (filter: 'all' | 'text' | 'image' | 'video') => void;
  onSettingsClick?: (model: ModelInfo) => void;
  isResearchModeFeatureEnabled?: boolean;
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

// Function to determine backend from model name/ID
const getModelBackend = (model: ModelInfo): string => {
  const modelName = model.name.toLowerCase();
  const modelId = model.id.toLowerCase();
  const modelDescription = model.description?.toLowerCase();

  // OpenAI models
  if (isOpenAIModel(modelName) || modelDescription?.includes('OpenAI')) {
    return 'OPEN AI';
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

// Updated ModelOption component for grid layout
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
    topUsedModelIds,
    avgResponseTimeByModel,
    statsLoading,
    mode,
  }: {
    model: ModelInfo;
    isSelected: boolean;
    maxContextWindow: number;
    maxTokens: number;
    onSelect: (model: ModelInfo) => void;
    onSettingsClick?: (model: ModelInfo) => void;
    isFavorite?: boolean;
    onToggleFavorite?: (modelId: string) => void;
    topUsedModelIds: string[];
    avgResponseTimeByModel: Record<string, number>;
    statsLoading: boolean;
    mode: 'dark' | 'light';
  }) => {
    const priceTierInfo = getModelPriceTier(model);
    const modelSpeed = getModelSpeedFromStats(model.id, avgResponseTimeByModel);
    const isPopular = topUsedModelIds.includes(model.id);
    // A disabled model stays in the list so users can see it, but it can't be picked:
    // no click handler, a not-allowed cursor, dimmed, and no hover affordance.
    const isDisabled = !!model.disabled;

    const card = (
      <Box
        data-testid={`model-card-${model.id}`}
        aria-disabled={isDisabled || undefined}
        data-disabled={isDisabled || undefined}
        onClick={isDisabled ? undefined : () => onSelect(model)}
        sx={{
          display: 'flex',
          width: '100%',
          maxWidth: '100%',
          minWidth: '100%',
          mx: 'auto',
          alignItems: 'stretch',
          justifyContent: 'space-between',
          padding: '16px',
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          opacity: isDisabled ? 0.55 : 1,
          transition: 'all 0.2s ease',
          backgroundColor: isSelected
            ? {
                xs: 'var(--joy-palette-background-panel)',
                sm: 'var(--joy-palette-background-panel)',
              }
            : { xs: 'var(--joy-palette-background-panel)' },
          '&:hover': {
            backgroundColor: isDisabled ? undefined : 'var(--joy-palette-aiSettings-modelCard-hoverBackground)',
          },
          border: isSelected
            ? 'var(--joy-palette-aiSettings-modelCard-activeBorder)'
            : 'var(--joy-palette-aiSettings-modelCard-border)',
          position: 'relative',
          borderWidth: '1px',
          maxHeight: { xs: 'none', sm: '180px' },
          boxSizing: 'border-box',
          borderRadius: '8px',
          flexDirection: 'column',
        }}
      >
        {/* Model Name and Metadata Chips, Top Side */}

        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            textAlign: 'left',
            mb: 1,
          }}
        >
          {/* Model Name — hovering the name region reveals the full description */}
          <Tooltip
            title={model.description ?? ''}
            placement="top"
            variant="soft"
            sx={{ maxWidth: 320 }}
            disableHoverListener={!model.description}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: '50px' }}>
              <Typography
                level="body-md"
                sx={{
                  textAlign: 'left',
                  color: 'text.primary',
                  fontWeight: '500',
                  minWidth: '70px',
                }}
              >
                {model.name}
              </Typography>
              {/* Bedrock-hosted indicator */}
              {model.backend === ModelBackend.Bedrock && (
                <img
                  data-testid={`bedrock-badge-${model.id}`}
                  src={BEDROCK_LOGO_SRC}
                  alt="Hosted on AWS Bedrock"
                  width={18}
                  height={18}
                  style={{ flex: 'none', objectFit: 'contain', display: 'block', borderRadius: 4 }}
                />
              )}
              {/* Selected Checkmark - sits right of the model name / Bedrock icon */}
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
          </Tooltip>

          {/* Favorite Toggle */}
          {onToggleFavorite && (
            <IconButton
              data-testid={`favorite-toggle-${model.id}`}
              variant="plain"
              size="sm"
              sx={{
                minWidth: '28px',
                minHeight: '28px',
                width: '28px',
                height: '28px',
                '&:hover': {
                  backgroundColor: 'transparent',
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
                <StarBorderRounded sx={{ fontSize: '20px', color: 'neutral.400' }} />
              )}
            </IconButton>
          )}

          {/* View More — selects the model and opens its detail & settings dialog (all viewports) */}
          {onSettingsClick && (
            <Tooltip title="View model details & settings" placement="bottom">
              <Button
                data-testid={`model-view-more-${model.id}`}
                variant="outlined"
                color="neutral"
                size="sm"
                sx={{
                  flex: 'none',
                  fontSize: '12px',
                  fontWeight: 500,
                  px: 1.5,
                  py: 0.25,
                  minHeight: '28px',
                  borderRadius: '6px',
                  color: 'text.primary',
                  whiteSpace: 'nowrap',
                  '&:hover': {
                    backgroundColor: 'primary.softHoverBg',
                    borderColor: 'primary.main',
                  },
                }}
                onClick={e => {
                  e.stopPropagation();
                  onSelect(model);
                  onSettingsClick(model);
                }}
              >
                View more
              </Button>
            </Tooltip>
          )}
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
              {/* Tokens Right Side */}
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
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
            {/* Unavailable Chip — model is disabled for this deployment (e.g. gated upstream) */}
            {isDisabled && (
              <MetadataChip
                label="Unavailable"
                mode={mode}
                variant="red"
                tooltip={model.disabledReason ?? 'This model is currently unavailable'}
              />
            )}
            {/* Latest Model Chip */}
            {isNewModel(model) && (
              <MetadataChip
                label="New"
                mode={mode}
                variant="purple"
                tooltip="This model is released in the last 3 months"
              />
            )}

            {/* Popular Model Chip - based on usage data */}
            {!statsLoading && isPopular && (
              <MetadataChip
                label="Popular"
                mode={mode}
                variant="blue-filled"
                tooltip="This is one of the most used models"
              />
            )}

            {/* Price Tier */}
            <MetadataChip
              label={priceTierInfo.tier}
              startDecorator={
                <Box
                  sx={{
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    backgroundColor:
                      priceTierInfo.variant === 'green'
                        ? green[800]
                        : priceTierInfo.variant === 'yellow'
                          ? orange[450]
                          : 'red',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '10px',
                    fontWeight: 'bold',
                    color: 'common.white',
                    mr: '4px',
                    p: 0.5,
                  }}
                >
                  $
                </Box>
              }
              tooltip={getPriceTierTooltip(priceTierInfo.tier)}
              variant={priceTierInfo.variant}
              isMaximum={false}
              mode={mode}
            />

            {/* Speed Chip - based on performance data */}
            {!statsLoading && modelSpeed && (
              <MetadataChip
                label={modelSpeed.charAt(0).toUpperCase() + modelSpeed.slice(1)}
                mode={mode}
                variant={getModelSpeedVariant(modelSpeed)}
                tooltip={getModelSpeedTooltip(modelSpeed)}
              />
            )}
          </Stack>

          <Stack sx={{ alignItems: 'flex-end', justifyContent: 'flex-end' }}>
            <Typography sx={{ fontSize: { xs: '12px' }, color: 'text.primary50', fontWeight: '500' }}>
              {formatContextWindow(model.contextWindow)} · {formatContextWindow(model.max_tokens)}
            </Typography>
          </Stack>
        </Box>
      </Box>
    );

    // Tooltips are scoped to the name + description regions (above) rather than the
    // whole card, so they don't stack on top of the per-chip tooltips in the metadata row.
    return card;
  }
);
ModelOption.displayName = 'ModelOption';

const ModelSelection: React.FC<ModelSelectionProps> = ({
  model,
  setModel,
  imageModel,
  showAllModels,
  modelFilter = 'text',
  onModelFilterChange,
  onSettingsClick,
  isResearchModeFeatureEnabled = false,
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
  const {
    value: searchQuery,
    debouncedValue: debouncedSearchQuery,
    setValue: setSearchQuery,
  } = useDebounceValue('', 500);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);
  const { isFavorite, toggleFavorite } = useFavoriteModels();

  // Lift model stats into parent - avoids N redundant query subscriptions and computations in ModelOption
  const { data: modelStats, isLoading: statsLoading } = useModelStats();
  const topUsedModelIds = useMemo(
    () => getTopUsedModelsFromStats(modelStats?.popularity ?? {}, 3),
    [modelStats?.popularity]
  );
  const avgResponseTimeByModel = modelStats?.avgResponseTime ?? emptyRecord;

  // State for user-toggled accordion backends (manual expand/collapse)
  const [userToggledBackends, setUserToggledBackends] = useState<Set<string>>(
    new Set(['Favorites', 'OPEN AI', 'Anthropic'])
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

    // Sort models within each backend by capability
    Object.keys(grouped).forEach(backend => {
      grouped[backend] = sortModelsByCapability(grouped[backend]);
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
      groupedByBackendAndType[backend].text = sortModelsByCapability(groupedByBackendAndType[backend].text);
      groupedByBackendAndType[backend].image = sortModelsByCapability(groupedByBackendAndType[backend].image);
      groupedByBackendAndType[backend].video = sortModelsByCapability(groupedByBackendAndType[backend].video);
    });

    // Sort backends by priority (OpenAI, Anthropic, Google, Meta, etc.)
    const backendPriority = ['OPEN AI', 'Anthropic', 'Google', 'Meta', 'xAI', 'Mistral', 'Black Forest Labs', 'Cohere'];
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

  const handleModelSelect = useCallback(
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
      const containerRect = container.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const offset = cardRect.top - containerRect.top - container.clientHeight / 2 + card.clientHeight / 2;
      container.scrollBy({ top: offset, behavior: 'auto' });
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
  const backendPriority = ['OPEN AI', 'Anthropic', 'Google', 'Meta', 'xAI', 'Mistral', 'Black Forest Labs', 'Cohere'];
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
        maxHeight: { xs: 'auto' },
        overflow: 'auto',
        px: 0,
        pr: { xs: 0, sm: 1 },
        ...scrollbarStyles,
      }}
    >
      {/* Search Input and Filter Dropdown */}
      <Box
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          backgroundColor: 'var(--joy-palette-background-var(--joy-palette-background-body)',
        }}
      >
        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: 'center',
            width: '100%',
            px: 0,
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
                    ml: { xs: 0, sm: '2px' },
                    mr: { xs: 0, sm: '-2px' },
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
              sx={{
                minWidth: { xs: '32px', sm: '140px' },
                width: { xs: '32px', sm: 'auto' },
                height: '32px !important',
                minHeight: '32px !important',
                maxHeight: '32px !important',
                backgroundColor: 'var(--joy-palette-background-body)',
                border: '1px solid var(--joy-palette-divider)',
                borderRadius: '8px',
                justifyContent: 'center',
                ml: '16px !important',
                py: 0,
                px: 1,
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
                '& .MuiSelect-startDecorator': {
                  mr: { xs: 0, sm: 1 },
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
              }}
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
              sx={{
                backgroundColor: 'background.surface',
                '& .MuiAccordionSummary-root': {
                  height: '56px !important',
                  minHeight: '56px !important',
                  maxHeight: '56px !important',
                },
                '&:not(.Mui-expanded):hover': {},
                '&.Mui-expanded': {
                  pb: '16px',
                },
                '& .MuiAccordionSummary-indicator': {
                  display: 'none',
                },
              }}
            >
              <AccordionSummary sx={{ alignItems: 'center', justifyContent: 'space-between', minHeight: '56px' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                  <StarRounded sx={{ fontSize: '18px', color: 'warning.400' }} />
                  <Typography
                    level="h4"
                    sx={{
                      color: 'text.primary',
                      fontSize: '18px',
                      fontWeight: 'bold',
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
                      gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, 1fr)' },
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
                        onSettingsClick={onSettingsClick}
                        isFavorite={true}
                        onToggleFavorite={toggleFavorite}
                        topUsedModelIds={topUsedModelIds}
                        avgResponseTimeByModel={avgResponseTimeByModel}
                        statsLoading={statsLoading}
                        mode={mode}
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
              sx={{
                backgroundColor: 'background.surface',
                '& .MuiAccordionSummary-root': {
                  height: '56px !important',
                  minHeight: '56px !important',
                  maxHeight: '56px !important',
                },
                '&:not(.Mui-expanded):hover': {},
                '&.Mui-expanded': {
                  pb: '16px',
                },
                '& .MuiAccordionSummary-indicator': {
                  display: 'none',
                },
              }}
            >
              <AccordionSummary sx={{ alignItems: 'center', justifyContent: 'space-between', minHeight: '56px' }}>
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
                      fontSize: '18px',
                      fontWeight: 'bold',
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
                              gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, 1fr)' },
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
                                onSettingsClick={onSettingsClick}
                                isFavorite={isFavorite(modelInfo.id)}
                                onToggleFavorite={toggleFavorite}
                                topUsedModelIds={topUsedModelIds}
                                avgResponseTimeByModel={avgResponseTimeByModel}
                                statsLoading={statsLoading}
                                mode={mode}
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
                              gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, 1fr)' },
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
                                onSettingsClick={onSettingsClick}
                                isFavorite={isFavorite(modelInfo.id)}
                                onToggleFavorite={toggleFavorite}
                                topUsedModelIds={topUsedModelIds}
                                avgResponseTimeByModel={avgResponseTimeByModel}
                                statsLoading={statsLoading}
                                mode={mode}
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
                              gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, 1fr)' },
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
                                onSettingsClick={onSettingsClick}
                                isFavorite={isFavorite(modelInfo.id)}
                                onToggleFavorite={toggleFavorite}
                                topUsedModelIds={topUsedModelIds}
                                avgResponseTimeByModel={avgResponseTimeByModel}
                                statsLoading={statsLoading}
                                mode={mode}
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
                        gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, 1fr)' },
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
                          onSettingsClick={onSettingsClick}
                          isFavorite={isFavorite(modelInfo.id)}
                          onToggleFavorite={toggleFavorite}
                          topUsedModelIds={topUsedModelIds}
                          avgResponseTimeByModel={avgResponseTimeByModel}
                          statsLoading={statsLoading}
                          mode={mode}
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
