import { FIXED_TEMPERATURE_MODELS, ModelInfo } from '@bike4mind/common';
import dayjs from 'dayjs';

export const isOpenAIModel = (modelName: string): boolean => {
  const lowerName = modelName.toLowerCase();
  return ['gpt', 'o1', 'o3', 'o4'].some(pattern => lowerName.includes(pattern));
};

// Metadata Chip Types
export type ChipVariant = 'default' | 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'blue-filled';

// Memoized date calculation
const getThreeMonthsAgo = (() => {
  let cachedDate: dayjs.Dayjs | null = null;
  let cacheTime = 0;
  const CACHE_DURATION = 1000 * 60 * 60; // 1 hour cache

  return () => {
    const now = Date.now();
    if (!cachedDate || now - cacheTime > CACHE_DURATION) {
      cachedDate = dayjs().subtract(3, 'months');
      cacheTime = now;
    }
    return cachedDate;
  };
})();

// Check if a single model is newly released (within last 3 months)
export const isNewModel = (model: ModelInfo): boolean => {
  return Boolean(model.releaseDate && dayjs(model.releaseDate).isAfter(getThreeMonthsAgo()));
};

// Determine pricing tier for a model
export const getModelPriceTier = (model: ModelInfo): { tier: string; variant: ChipVariant } => {
  if (!model.pricing || Object.keys(model.pricing).length === 0) {
    return { tier: 'Low', variant: 'green' }; // Default to lowest tier if no pricing info
  }

  // Get the first pricing tier
  const firstKey = Number(Object.keys(model.pricing)[0]);
  if (isNaN(firstKey) || !model.pricing[firstKey]) {
    return { tier: 'Low', variant: 'green' };
  }

  // Calculate average cost (input + output)
  const avgCost = (model.pricing[firstKey].input + model.pricing[firstKey].output) / 2;

  // For text models, use different thresholds than image models
  if (model.type === 'text') {
    if (avgCost >= 5 / 1000000) {
      // Models like GPT-4, Claude 3 Opus, etc.
      return { tier: 'High', variant: 'red' };
    } else if (avgCost >= 0.5 / 1000000) {
      // Models like GPT-4o, Claude 3 Sonnet, etc.
      return { tier: 'Medium', variant: 'yellow' };
    }
    return { tier: 'Low', variant: 'green' }; // Models like GPT-3.5, Claude Instant, etc.
  } else {
    // Image models
    if (avgCost >= 0.05) {
      // Very expensive image models
      return { tier: 'High', variant: 'red' };
    } else if (avgCost >= 0.02) {
      // Medium priced image models
      return { tier: 'Medium', variant: 'yellow' };
    }
    return { tier: 'Low', variant: 'green' }; // Lower priced image models
  }
};

export const getChipStyles = (variant: ChipVariant, isMaximum: boolean, mode: string | undefined, label: string) => {
  const baseStyles = {
    fontSize: '13px',
    fontWeight: isMaximum ? 'bold' : '400',
    padding: '0px 12px',
    height: '1.5rem',
    backgroundColor: mode === 'dark' ? 'rgba(19, 24, 28, 1)' : '#FFFFFF',
  };

  const variantStyles = {
    default: {
      border: mode === 'dark' ? '1px solid rgba(209, 228, 244, 0.2)' : '1px solid #D1E4F4',
    },
    blue: {
      border: '1px solid #0B6BCB',
      background:
        mode === 'dark'
          ? 'linear-gradient(rgba(11, 106, 203, 0.02), rgba(11, 107, 203, 0.04)), rgba(19, 24, 28, 1)'
          : 'linear-gradient(rgba(11, 106, 203, 0.02), rgba(11, 107, 203, 0.04)), #FFFFFF',
    },
    green: {
      border: label === 'Low' || label === 'Fast' ? '1px solid rgba(209, 228, 244, 0.2)' : '1px solid #1FB84B',
      color: label === 'Low' || label === 'Fast' ? 'text.primary' : undefined,
      background:
        mode === 'dark'
          ? 'linear-gradient(rgba(31, 184, 75, 0.05), rgba(31, 184, 75, 0.2)), rgba(19, 24, 28, 1)'
          : 'linear-gradient(rgba(31, 184, 75, 0.05), rgba(31, 184, 75, 0.1)), #FFFFFF',
      animation: isMaximum ? 'pulse 2s infinite' : 'none',
      '@keyframes pulse': {
        '0%': { boxShadow: '0 0 0 0 rgba(76, 175, 80, 0.4)' },
        '70%': { boxShadow: '0 0 0 5px rgba(76, 175, 80, 0)' },
        '100%': { boxShadow: '0 0 0 0 rgba(76, 175, 80, 0)' },
      },
    },
    yellow: {
      color: '#F59E0B',
      border: mode === 'dark' ? '1px solid rgba(209, 228, 244, 0.2)' : '1px solid #D1E4F4',
      backgroundColor: 'transparent',
    },
    red: {
      color: '#EF4444',
      border: mode === 'dark' ? '1px solid rgba(209, 228, 244, 0.2)' : '1px solid #D1E4F4',
      backgroundColor: 'transparent',
    },
    purple: {
      color: '#FFFFFF',
      backgroundColor: '#A52ECD',
    },
    'blue-filled': {
      color: '#FFFFFF',
      backgroundColor: '#0B6BCB',
    },
  };

  return { ...baseStyles, ...variantStyles[variant] };
};

// Stats-based helpers (used by non-admin components with pre-aggregated data from /api/models/stats)
export const getModelSpeedFromStats = (
  modelId: string,
  avgResponseTime: Record<string, number>
): 'fast' | 'medium' | 'slow' | null => {
  if (!avgResponseTime || Object.keys(avgResponseTime).length === 0) {
    const staticModelSpeeds: Record<string, 'fast' | 'medium' | 'slow'> = {
      'GPT-4': 'medium',
      'Claude 3.5 Sonnet': 'fast',
      'GPT-4 Turbo': 'fast',
      'GPT-3.5 Turbo': 'fast',
      'Claude 3 Haiku': 'fast',
      'Claude 3 Opus': 'slow',
      'Gemini Pro': 'medium',
      'Llama 3': 'medium',
    };
    return staticModelSpeeds[modelId] || null;
  }

  const avg = avgResponseTime[modelId];
  if (avg == null) return null;

  if (avg < 7000) return 'fast';
  if (avg < 15000) return 'medium';
  return 'slow';
};

export const getModelSpeedVariant = (speed: 'fast' | 'medium' | 'slow'): ChipVariant => {
  switch (speed) {
    case 'fast':
      return 'green';
    case 'medium':
      return 'yellow';
    case 'slow':
      return 'red';
    default:
      return 'default';
  }
};

export const getModelSpeedTooltip = (speed: 'fast' | 'medium' | 'slow'): string => {
  switch (speed) {
    case 'fast':
      return 'Fast response time (< 7s average)';
    case 'medium':
      return 'Medium response time (7-15s average)';
    case 'slow':
      return 'Slower response time (> 15s average)';
    default:
      return 'Response time unknown';
  }
};

// Model price tier tooltip text
export const getPriceTierTooltip = (priceTier: string): string => {
  switch (priceTier) {
    case 'Low':
      return 'Lower cost model';
    case 'Medium':
      return 'Medium cost model';
    case 'High':
      return 'Premium cost model';
    default:
      return 'Cost information unavailable';
  }
};

// Smallest default we ever hand a large-context model, so the headroom share below can only
// raise the old flat cap, never lower it.
const LARGE_CONTEXT_FLOOR = 16384;
// Above this window size, headroom is a share of the context rather than a flat cap.
const SMALL_CONTEXT_WINDOW = 32768;

// Default for max_tokens. The server reserves this whole value out of the context window when
// it computes maxSafeInputTokens (ChatCompletionProcess), so the default has to leave room for
// input - but as a *share* of the window, not a flat number. A flat 16384 cap meant a 1M-token
// model with a 128000-token ceiling could only emit 12.8% of what it advertises, which is what
// truncated large artifacts. Small windows halve; large ones take a quarter of the window
// (never below LARGE_CONTEXT_FLOOR), always bounded by the model's own advertised ceiling.
export const computeDefaultMaxTokens = (modelInfo: Pick<ModelInfo, 'contextWindow' | 'max_tokens'>): number => {
  const contextWindow = modelInfo.contextWindow ?? 0;
  const modelMaxTokens = modelInfo.max_tokens ?? 0;
  if (contextWindow <= 0 || modelMaxTokens <= 0) return Math.floor(modelMaxTokens);
  if (contextWindow <= SMALL_CONTEXT_WINDOW) return Math.floor(Math.min(modelMaxTokens, contextWindow / 2));
  return Math.floor(Math.min(modelMaxTokens, Math.max(LARGE_CONTEXT_FLOOR, contextWindow / 4)));
};

// Re-fit a persisted max_tokens onto a model. An unset value, or one carried over from a bigger
// model, is always replaced with this model's default - the former has no meaning and the latter
// would starve the new model's input budget.
//
// Raising a below-default value is opt-in via `allowRaise`, because the two cases differ: on an
// actual model SWITCH a low carry-over is stale (it would cap a frontier model far below what it
// can emit - the client value is the binding ceiling, the server only clamps down), but for the
// model the user is already on it is their own deliberate setting, and raising it there would
// discard that choice on every page reload and catalog refetch.
// Keep in sync with the model-change effect in contexts/LLMContext.tsx.
export const refitMaxTokensForModel = (
  currentMaxTokens: number,
  modelInfo: Pick<ModelInfo, 'contextWindow' | 'max_tokens'>,
  { allowRaise = true }: { allowRaise?: boolean } = {}
): number => {
  const ceiling = modelInfo.max_tokens ?? 0;
  if (ceiling <= 0) return currentMaxTokens;
  const target = computeDefaultMaxTokens(modelInfo);
  if (currentMaxTokens <= 0 || currentMaxTokens > ceiling) return target;
  if (allowRaise && currentMaxTokens < target) return target;
  return currentMaxTokens;
};

/**
 * The LLM-store patch that must accompany every model change. Kept here rather than
 * inlined at each switch site (the picker in AdvancedAIModal, the stale-pin prompt in
 * StaleModelPrompt) so the two cannot drift on what "changing model" entails.
 *
 * Callers persist the pin separately via updateSessionToServer, since only they know
 * the session and whether the write should be wrapped in a transition.
 */
export const buildModelSelectionPatch = (modelInfo: ModelInfo) => ({
  model: modelInfo.id,
  max_tokens: computeDefaultMaxTokens(modelInfo),
  ...(FIXED_TEMPERATURE_MODELS.has(modelInfo.id) && { temperature: 1.0 }),
});
