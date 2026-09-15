import { ChatModels } from '@bike4mind/common';

/** System fallback values when no channel/agent/org config is set */
export const SYSTEM_MODEL_DEFAULTS = {
  modelId: ChatModels.CLAUDE_5_SONNET_BEDROCK,
  modelDisplayName: 'Claude Sonnet 5',
  // Sonnet 5 is a NO_TEMPERATURE model - the adapter strips temperature for it, so this
  // value is ignored while the default model is Sonnet 5. It still applies as the fallback
  // temperature for any channel that overrides to a temperature-capable model without setting one.
  temperature: 0.9,
  maxTokens: 4000,
} as const;
