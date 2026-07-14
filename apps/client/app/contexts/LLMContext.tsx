import {
  OpenAIImageQuality,
  OpenAIImageSize,
  OpenAIImageStyle,
  ModelInfo,
  B4MLLMTools,
  IMAGE_MODELS,
  ImageModels,
  ChatModels,
  LLMModelConfig,
  B4MLLMToolsList,
  LEGACY_IMAGE_MODEL_MAP,
  isImageModel,
} from '@bike4mind/common';
import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import { useUserSettings } from '@/app/contexts/UserSettingsContext';
import { useFeatureEnabled } from '@/app/hooks/useFeatureEnabled';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useAccessibleModels } from '../hooks/useAccessibleModels';
import { useModelInfo } from '../hooks/data/useModelInfo';
import { ResearchModeState, ResearchModeConfiguration } from '../types/ResearchMode';
import { computeDefaultMaxTokens } from '../utils/aiSettingsUtils';
import { useAdminSettings } from './AdminSettingsContext';

export interface LLMContextProps {
  model: string;
  imageModel: string;
  imageEditModel: string; // Model used for image editing operations
  defaultTextModel: string;
  setLLM: (params: Partial<LLMContextProps>) => void;
  temperature: number | undefined;
  top_p: number | undefined;
  n: number | undefined;
  max_tokens: number;
  // Helper to get models the user can access
  getAccessibleModels: () => LLMModelConfig[];
  // Helper to check if a specific model is accessible
  isModelAccessible: (modelId: string) => boolean;
  presence_penalty: number | undefined;
  frequency_penalty: number | undefined;
  stop: string | string[] | null | undefined;
  logit_bias: { [key: string]: number } | undefined | null;
  size: OpenAIImageSize;
  quality: OpenAIImageQuality;
  style: OpenAIImageStyle;
  safety_tolerance: number | undefined;
  prompt_upsampling: boolean | undefined;
  seed: number | null | undefined;
  output_format: 'jpeg' | 'png' | null | undefined;
  width: number | undefined;
  height: number | undefined;
  aspect_ratio: string | undefined;
  thinking?: {
    enabled: boolean;
    budget_tokens: number;
  };
  deepResearchConfig?: {
    duration: number; // in minutes
    maxDepth: number; // number of iterations
  };
  organizationId: string | null;
  resetSettings: () => void;
  updateLLMParams: () => void;
  isQuestMasterEnabled: boolean;
  isMementosEnabled: boolean;
  isArtifactsEnabled: boolean;
  isAgentsEnabled: boolean;
  isLatticeEnabled: boolean;
  toolMode: 'fast' | 'smart';
  tools: Array<B4MLLMTools>;
  researchMode: ResearchModeState;
  setResearchMode: (mode: Partial<ResearchModeState>) => void;
  addResearchConfiguration: (config: ResearchModeConfiguration) => void;
  removeResearchConfiguration: (id: string) => void;
  updateResearchConfiguration: (id: string, updates: Partial<ResearchModeConfiguration>) => void;
  lastUsedTextModel: string | null;
  lastUsedImageModel: string | null;
  lastUsedImageEditModel: string | null; // Tracks last used image edit model
  enabledMcpServers: string[] | null;
  /**
   * Agent-mode composer toggle state.
   *
   * `enabled`: when true, `routeQuery()` is forced to `agent_executor` via
   * `userOverride='force_agent'`. The toggle is rendered only when the
   * Layer-1 gate resolves true via `useFeatureEnabled('agentMode')` (admin
   * `EnableAgentMode` plus per-user pref / admin default); for everyone else
   * the state stays at its `{ enabled: false, source: 'toggle' }` default and
   * has zero behavioral impact.
   *
   * `source`: provenance of the current `enabled` value, threaded through
   * to telemetry / `/api/ai/llm` so future per-decision routing logs can
   * distinguish manual toggles from classifier- or complexity-driven
   * auto-routing. Kept in sync with the `agentMode.source` zod enum in
   * `@bike4mind/common` (llm.ts).
   */
  agentMode: {
    enabled: boolean;
    source: 'toggle' | 'classifier' | 'mention' | 'user-default' | 'agent_literal' | 'complexity';
  };
  /**
   * Session-scoped opt-out for auto-routing.
   *
   * Flipped by the `AutoRouteBadge` "Dismiss" action so a user who feels an
   * auto-route mis-routed their last query can suppress it for the session
   * without disabling Agent mode globally. Suppresses both auto-route paths:
   * the classifier (via `evaluateShortCircuits`) and the rule-based complexity
   * reroute (gates `autoRouteEnabled` in `useSendMessage`). Lives in memory
   * only, never persisted, so a refresh restores the user's `agentModeDefault`
   * preference cleanly. Has zero behavioral effect for non-Layer-1 users.
   */
  disableAutoRouteForThisSession: boolean;
}

const DEFAULTS = {
  model: '',
  imageModel: ImageModels.FLUX_PRO_ULTRA as string,
  imageEditModel: ImageModels.GPT_IMAGE_1_5 as string, // Default to GPT-Image-1.5 for editing (no mask required)
  defaultTextModel: '',
  temperature: 0.9,
  top_p: 1,
  n: 1,
  max_tokens: 8192,
  presence_penalty: 0,
  frequency_penalty: 0,
  stop: null,
  logit_bias: null,
  size: '1024x1024' as OpenAIImageSize,
  quality: 'standard' as OpenAIImageQuality,
  style: 'natural' as OpenAIImageStyle,
  safety_tolerance: undefined,
  prompt_upsampling: false,
  seed: null,
  output_format: 'jpeg' as 'jpeg' | 'png',
  width: 1024,
  height: 768,
  aspect_ratio: '16:9',
  thinking: {
    enabled: false,
    budget_tokens: 16000,
  },
  deepResearchConfig: {
    duration: 4.5, // minutes
    maxDepth: 7, // iterations
  },
  organizationId: null,
  isQuestMasterEnabled: false,
  isMementosEnabled: false,
  isArtifactsEnabled: false,
  isAgentsEnabled: false, // Default controlled by user settings
  isLatticeEnabled: false, // Default controlled by user settings
  toolMode: 'smart' as const,
  tools: [],
  researchMode: {
    enabled: false,
    configurations: [],
    syncScrolling: true,
    comparisonView: 'grid' as const,
  },
  lastUsedTextModel: null,
  lastUsedImageModel: null,
  lastUsedImageEditModel: null,
  enabledMcpServers: null,
  agentMode: { enabled: false, source: 'toggle' as const },
  disableAutoRouteForThisSession: false,
};

export const useLLM = create(
  persist<LLMContextProps>(
    (set, get) => ({
      ...DEFAULTS,
      getAccessibleModels: () => [],
      isModelAccessible: () => false,
      resetSettings: () => set(DEFAULTS),
      updateLLMParams: () => {
        set({
          ...DEFAULTS,
        });
      },
      setLLM: (params: Partial<LLMContextProps>) => {
        set(prev => {
          const newState = {
            ...prev,
            ...params,
          };

          // Track model changes for remembering
          if (params.model && params.model !== prev.model) {
            if (params.model && isImageModel(params.model)) {
              newState.lastUsedImageModel = params.model;
              // Sync imageModel when user selects an image model as primary
              newState.imageModel = params.model;
            } else if (params.model) {
              newState.lastUsedTextModel = params.model;
            }
          }

          // Track imageModel changes as last used image model
          if (params.imageModel && params.imageModel !== prev.imageModel) {
            newState.lastUsedImageModel = params.imageModel;
          }

          return newState;
        });
      },
      setResearchMode: (mode: Partial<ResearchModeState>) => {
        set(state => ({
          researchMode: { ...state.researchMode, ...mode },
        }));
      },
      addResearchConfiguration: (config: ResearchModeConfiguration) => {
        set(state => ({
          researchMode: {
            ...state.researchMode,
            configurations: [...state.researchMode.configurations, config].slice(0, 4), // Max 4 configs
          },
        }));
      },
      removeResearchConfiguration: (id: string) => {
        set(state => ({
          researchMode: {
            ...state.researchMode,
            configurations: state.researchMode.configurations.filter(c => c.id !== id),
          },
        }));
      },
      updateResearchConfiguration: (id: string, updates: Partial<ResearchModeConfiguration>) => {
        set(state => ({
          researchMode: {
            ...state.researchMode,
            configurations: state.researchMode.configurations.map(c => (c.id === id ? { ...c, ...updates } : c)),
          },
        }));
      },
    }),
    {
      name: 'llm-settings',
      version: 4,
      migrate: (persistedState: any, version: number) => {
        // Remap any persisted image-model ids that are now legacy/removed (e.g. dall-e-3, flux-dev).
        const remapLegacyImageModels = (state: Record<string, unknown>) => {
          for (const key of ['imageModel', 'lastUsedImageModel'] as const) {
            const value = state[key];
            if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_IMAGE_MODEL_MAP, value)) {
              state[key] = LEGACY_IMAGE_MODEL_MAP[value];
            }
          }
        };
        // Migration v0->v1: clean up invalid tools like 'confluence_search'
        if (version < 1) {
          if (persistedState?.tools && Array.isArray(persistedState.tools)) {
            persistedState.tools = persistedState.tools.filter((tool: string) =>
              B4MLLMToolsList.includes(tool as B4MLLMTools)
            );
          }
        }
        // Migration v1->v2: map legacy image models (e.g. dall-e-3 -> gpt-image-1)
        if (version < 2) {
          remapLegacyImageModels(persistedState);
          // Migration to add toolMode for existing users
          persistedState.toolMode = 'smart';
        }
        // Migration v2->v3: re-run the remap to catch aliases added after v2 shipped (e.g. flux-dev -> flux-pro-1.1)
        if (version < 3) {
          remapLegacyImageModels(persistedState);
        }
        // Migration v3->v4: re-run the remap to catch the xAI aliases added after v3 shipped (grok-2-image-1212 / grok-2-image / grok-2-image-gen -> grok-imagine-image-quality)
        if (version < 4) {
          remapLegacyImageModels(persistedState);
        }
        return persistedState;
      },
      partialize: state => {
        // Drop function fields (not serializable; re-injected on mount) and
        // force-reset the two session-scoped flags so a reload always starts
        // clean: `disableAutoRouteForThisSession` (dismiss is a per-tab
        // remediation, not a durable user preference) and `agentMode.source`
        // (provenance from the previous run is meaningless to a fresh send;
        // the next dispatch will write its own source).
        const {
          getAccessibleModels,
          isModelAccessible,
          setLLM,
          resetSettings,
          updateLLMParams,
          setResearchMode,
          addResearchConfiguration,
          removeResearchConfiguration,
          updateResearchConfiguration,
          disableAutoRouteForThisSession,
          ...rest
        } = state;
        return {
          ...rest,
          isQuestMasterEnabled: false,
          disableAutoRouteForThisSession: false,
          agentMode: { enabled: rest.agentMode?.enabled ?? false, source: 'toggle' as const },
        } as LLMContextProps;
      },
    }
  )
);

// Delegates to the shared tiered formula so all model-switch paths converge on the same default.
export function getDefaultMaxTokens(modelInfo: ModelInfo): number {
  return computeDefaultMaxTokens(modelInfo);
}

export const LLMProvider: React.FC = () => {
  const { setState } = useLLM;
  const { settings } = useUserSettings();
  const { isFeatureEnabled } = useFeatureEnabled();
  const { accessibleModels, isModelAccessible, getFallbackModel } = useAccessibleModels();
  const { data: modelInfoRepo } = useModelInfo();
  const activeModel = useLLM(s => s.model);
  const { getSetting, isLoading: isAdminSettingsLoading } = useAdminSettings();
  // Default users to the highest Sonnet (workhorse tier) via BEDROCK - keyless (AWS IAM only),
  // so the fallback works even where no Anthropic API key is configured. Mirrors the server-side
  // `DefaultAPIModel` default. Opus/Fable are an explicit opt-in via the model picker.
  // An admin-configured 'DefaultAPIModel' setting still overrides this in-code fallback.
  const adminDefaultTextModel = getSetting('DefaultAPIModel', ChatModels.CLAUDE_5_SONNET_BEDROCK);

  // Extract primitive booleans so the effect dep array contains stable values
  // rather than the experimentalFeatures object reference (recreated on every settings update)
  const enableMementos = settings.experimentalFeatures?.enableMementos ?? false;
  const enableArtifacts = isFeatureEnabled('enableArtifacts');
  const enableAgents = isFeatureEnabled('enableAgents');
  const enableLattice = settings.experimentalFeatures?.enableLattice ?? false;

  // Refs hold the latest values so stable closures always read current data
  // without needing to be in effect dep arrays (which would re-trigger on every login)
  const accessibleModelsRef = useRef(accessibleModels);
  const isModelAccessibleRef = useRef(isModelAccessible);
  const getFallbackModelRef = useRef(getFallbackModel);

  // Keep refs current after every render so stable closures always read the latest values.
  // useLayoutEffect (synchronous, before paint) ensures refs are updated before any
  // useEffect or user interaction can invoke the stable functions.
  useLayoutEffect(() => {
    accessibleModelsRef.current = accessibleModels;
    isModelAccessibleRef.current = isModelAccessible;
    getFallbackModelRef.current = getFallbackModel;
  });

  // Stable functions - identity never changes, reads from refs at call time
  const stableGetAccessibleModels = useCallback(() => accessibleModelsRef.current, []);
  const stableIsModelAccessible = useCallback((modelId: string) => isModelAccessibleRef.current(modelId), []);
  const stableGetFallbackModel = useCallback((modelId: string) => getFallbackModelRef.current(modelId), []);

  useEffect(() => {
    setState(prev => {
      // Return the SAME reference when nothing changed - zustand v5 uses Object.is at the
      // top level, so spreading unconditionally creates a new object and triggers all
      // subscribers to re-render even when the values are identical.
      if (
        prev.isMementosEnabled === enableMementos &&
        prev.isArtifactsEnabled === enableArtifacts &&
        prev.isAgentsEnabled === enableAgents &&
        prev.isLatticeEnabled === enableLattice &&
        prev.getAccessibleModels === stableGetAccessibleModels &&
        prev.isModelAccessible === stableIsModelAccessible
      )
        return prev;
      return {
        ...prev,
        isMementosEnabled: enableMementos,
        isArtifactsEnabled: enableArtifacts,
        isAgentsEnabled: enableAgents,
        isLatticeEnabled: enableLattice,
        getAccessibleModels: stableGetAccessibleModels,
        isModelAccessible: stableIsModelAccessible,
      };
    });
  }, [
    enableMementos,
    enableArtifacts,
    enableAgents,
    enableLattice,
    setState,
    stableGetAccessibleModels,
    stableIsModelAccessible,
  ]);

  // Set the default model and max tokens, respecting access control
  // Fallback chain: admin default -> user's last used model -> first accessible model
  //
  // `accessibleModels` is in the dep array (not just the ref) because models and
  // admin settings load asynchronously and independently. If settings finish first
  // and models arrive later, an effect keyed only on `isAdminSettingsLoading` won't
  // re-fire when the ref updates, leaving the user with no selected model and a
  // misleading "Input exceeds maximum allowed (0 tokens)" error on first send.
  // The setState callback is idempotent: it returns `state` unchanged unless the
  // current model is missing or inaccessible, so re-runs after the user picks a
  // valid model are no-ops and cannot clobber the selection.
  useEffect(() => {
    setState(state => {
      const models = accessibleModelsRef.current;
      // Make sure admin settings are fetched before setting the default model
      if (models && models.length > 0 && !isAdminSettingsLoading) {
        // Check if current model needs to be changed
        const hasNoModel = !state.model;
        const needsModelSwitch = state.model && !stableIsModelAccessible(state.model);

        if (hasNoModel || needsModelSwitch) {
          // If the current model is deprecated/inaccessible, try its fallback model first
          if (needsModelSwitch && state.model) {
            const fallback = stableGetFallbackModel(state.model);
            if (fallback) {
              return {
                ...state,
                model: fallback.id,
                defaultTextModel: fallback.id,
                max_tokens: getDefaultMaxTokens(fallback),
                isQuestMasterEnabled: false,
                isAgentsEnabled: false,
              };
            }
          }

          // Fallback chain: admin default -> last used text model -> first accessible
          const adminDefault = models.find(model => model.id === adminDefaultTextModel);
          const lastUsed = state.lastUsedTextModel ? models.find(model => model.id === state.lastUsedTextModel) : null;
          const modelToUse = adminDefault || lastUsed || models[0];

          return {
            ...state,
            model: modelToUse.id,
            defaultTextModel: modelToUse.id,
            max_tokens: getDefaultMaxTokens(modelToUse),
            isQuestMasterEnabled: false,
            isAgentsEnabled: false,
          };
        }
      }
      return state;
    });
    // stableGetFallbackModel / stableIsModelAccessible read from refs at call time,
    // their identity is stable and they don't need to be in deps. accessibleModels
    // IS in deps so we re-run when models arrive after isAdminSettingsLoading has
    // already flipped false (see comment above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setState, adminDefaultTextModel, isAdminSettingsLoading, accessibleModels]);

  // Re-clamp max_tokens whenever the active text/chat model changes. Without this, a value
  // persisted from a previously-selected larger-context model can leak into a smaller-context
  // model and zero out the input budget. Skip image models: their
  // catalog max_tokens is unrelated to text-output budgets and would silently lower it.
  useEffect(() => {
    if (!activeModel || !modelInfoRepo) return;
    if (isImageModel(activeModel)) return;
    const info = modelInfoRepo.find(m => m.id === activeModel);
    if (!info) return;
    const ceiling = info.max_tokens ?? 0;
    if (ceiling <= 0) return;
    setState(state => {
      if (state.max_tokens > 0 && state.max_tokens <= ceiling) return state;
      return { ...state, max_tokens: computeDefaultMaxTokens(info) };
    });
    // setState from Zustand is stable by reference - matches the convention used by the
    // other effects in this file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModel, modelInfoRepo]);

  // Set a default available image model if not set or inaccessible
  useEffect(() => {
    setState(state => {
      const models = accessibleModelsRef.current;
      if (models && models.length > 0 && !isAdminSettingsLoading) {
        const currentImageModel = state.imageModel;
        const isCurrentAccessible = currentImageModel && stableIsModelAccessible(currentImageModel);

        if (!currentImageModel || !isCurrentAccessible) {
          // Prefer a known default if accessible, otherwise first accessible IMAGE_MODELS entry
          const preferred = ImageModels.FLUX_PRO_ULTRA as string;
          const preferredAccessible = preferred && stableIsModelAccessible(preferred);

          let imageModelToUse: string | null = preferredAccessible ? preferred : null;
          if (!imageModelToUse) {
            // Find the first IMAGE_MODELS item that is accessible
            for (const imgId of IMAGE_MODELS as unknown as string[]) {
              if (stableIsModelAccessible(imgId)) {
                imageModelToUse = imgId;
                break;
              }
            }
          }

          if (imageModelToUse) {
            return {
              ...state,
              imageModel: imageModelToUse,
              lastUsedImageModel: imageModelToUse,
            };
          }
        }
      }
      return state;
    });
    // Same rationale as the text-model effect above: include accessibleModels so
    // late-arriving models still trigger default selection. stableIsModelAccessible
    // reads from a ref and stays stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdminSettingsLoading, setState, accessibleModels]);

  return null;
};
