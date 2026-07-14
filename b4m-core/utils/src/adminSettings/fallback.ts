import { ModelInfo } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { isAxiosError } from 'axios';
import { ApiKeyTable, getLlmByModel, ICompletionBackend } from '../llm';

/**
 * Fallback attempt result
 */
export interface FallbackAttempt {
  model: ModelInfo;
  backend: ICompletionBackend;
  attempt: number;
}

/**
 * AWS SDK v3 service exceptions (Bedrock, etc.) are plain Error subclasses, not Axios errors:
 * their HTTP status lives on `$metadata.httpStatusCode`, not `response.status`. Read both
 * shapes so a Bedrock 503 ServiceUnavailableException (whose message matches no substring
 * trigger) still falls back instead of hard-failing.
 */
function getHttpStatus(error: Error): number | undefined {
  if (isAxiosError(error)) {
    return error.response?.status;
  }
  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return metadata?.httpStatusCode;
}

/**
 * Transient AWS SDK v3 exception names worth retrying/falling back on. These carry the
 * failure type in `.name` even when `$metadata` is absent, so we match on it as a backstop
 * to the HTTP status check.
 */
const TRANSIENT_AWS_SDK_ERROR_NAMES = new Set([
  'ServiceUnavailableException', // 503 — Bedrock capacity/availability
  'ThrottlingException', // 429 — account/model throttling
  'TooManyRequestsException', // 429
  'InternalServerException', // 500 — transient server-side error
  'ModelNotReadyException', // model still scaling up
  'ModelTimeoutException', // upstream model timeout
]);

function isTransientAwsSdkError(error: Error): boolean {
  return TRANSIENT_AWS_SDK_ERROR_NAMES.has(error.name);
}

/**
 * Error types that should trigger fallback attempts
 */
export function shouldTriggerFallback(error: Error): boolean {
  const message = error.message.toLowerCase();

  // Rate limiting, server errors, timeouts. Status sourced from both Axios and AWS SDK
  // (e.g. Bedrock's 503 ServiceUnavailableException) error shapes.
  const status = getHttpStatus(error);
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  // Transient AWS SDK v3 service exceptions (recognized by name when no usable status).
  if (isTransientAwsSdkError(error)) {
    return true;
  }

  // Network connection errors (Axios)
  if (isAxiosError(error)) {
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') {
      return true;
    }
  }

  // Check for ECONNRESET in error code property (non-Axios errors)
  // Ignore aborted errors as they are expected when the request is cancelled
  if ('code' in error && error.code === 'ECONNRESET' && !message.includes('aborted')) {
    return true;
  }

  // Check for TypeError: terminated (from undici/fetch)
  if (error.name === 'TypeError' && message.includes('terminated')) {
    return true;
  }

  // Model-specific errors
  const fallbackTriggers = [
    'model not available',
    'overloaded',
    'capacity',
    'rate limit',
    'service unavailable',
    'internal server error',
    'timeout',
    'connection refused',
    'connection error',
    'connection reset',
    'econnreset',
    'terminated',
    'token limit exceeded',
    'authentication failed',
    'api key',
    'quota exceeded',
    'model not found',
    'does not exist',
    // Gated-model availability 404 (e.g. Anthropic's "Claude Fable 5 is not available. Please
    // use Opus 4.8"). Degrade to the fallback chain instead of hard-failing. The 'model not
    // available' trigger requires the literal word "model"; this provider message says
    // "<name> is not available", so it needs its own substring.
    'is not available',
    // Claude Fable 5 GA safety-classifier refusal: the Anthropic backend surfaces a
    // stop_reason: 'refusal' as a thrown error for REFUSAL_FALLBACK_MODELS so blocked
    // requests continue on Opus 4.8 via the claude-fable-5 fallback chain below.
    'safety classifier refusal',
  ];

  return fallbackTriggers.some(trigger => message.includes(trigger));
}

/**
 * Detect overloaded/rate-limit errors that are likely transient and worth retrying
 * with the same model before falling back to a different one.
 */
export function isOverloadedError(error: Error): boolean {
  const message = error.message.toLowerCase();

  // Check HTTP status codes from both Axios and AWS SDK (e.g. Bedrock 503) error shapes.
  const status = getHttpStatus(error);
  if (status === 429 || status === 529 || status === 503) {
    return true;
  }

  // Bedrock/AWS SDK transient capacity exceptions (ServiceUnavailable, Throttling, etc.).
  if (isTransientAwsSdkError(error)) {
    return true;
  }

  const overloadedTriggers = ['overloaded', 'rate limit', 'capacity', 'too many requests', '529'];

  return overloadedTriggers.some(trigger => message.includes(trigger));
}

/**
 * Validate fallback model passed from frontend
 */
export function validateFallbackModel(
  fallbackModelId: string,
  availableModels: ModelInfo[],
  apiKeyTable: ApiKeyTable,
  logger: Logger
): ModelInfo | null {
  logger.info(`🔄 Validating fallback model ${fallbackModelId} from frontend`);

  // Find the model in available models
  const model = availableModels.find(m => m.id === fallbackModelId);

  if (!model) {
    logger.warn(`⚠️ Fallback model ${fallbackModelId} not found in available models`);
    return null;
  }

  // Check if we have API key for this model's backend
  const hasApiKey = apiKeyTable[model.backend] && apiKeyTable[model.backend] !== 'expired';
  if (!hasApiKey) {
    logger.warn(`⚠️ No valid API key for fallback model ${fallbackModelId} (backend: ${model.backend})`);
    return null;
  }

  logger.info(`✅ Validated fallback model:`, {
    id: model.id,
    backend: model.backend,
    contextWindow: model.contextWindow,
  });

  return model;
}

/**
 * Find a suitable automatic fallback model based on the original model
 */
function findAutomaticFallback(
  originalModel: ModelInfo,
  availableModels: ModelInfo[],
  apiKeyTable: ApiKeyTable,
  logger: Logger
): ModelInfo | null {
  logger.info(`🔍 Finding automatic fallback for ${originalModel.id}`);

  // Define fallback preferences for different model types
  const fallbackPreferences: Record<string, string[]> = {
    // Gemini models fallback to Claude or GPT
    'gemini-2.5-pro-preview-05-06': ['claude-sonnet-4-6', 'gpt-4o', 'claude-opus-4-6'],
    'gemini-2.5-flash-preview-05-20': ['claude-haiku-4-5-20251001', 'gpt-4o-mini'],
    'gemini-1.5-pro': ['claude-sonnet-4-6', 'gpt-4o', 'claude-opus-4-6'],
    'gemini-1.5-flash': ['claude-haiku-4-5-20251001', 'gpt-4o-mini'],

    // Top tier (Fable 5 / Opus 4.7-4.8) degrades within the Opus tier before dropping to Sonnet
    'claude-fable-5': [
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'gpt-5',
    ],
    'claude-opus-4-8': ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5', 'claude-sonnet-4-6', 'gpt-5'],
    'claude-opus-4-7': ['claude-opus-4-6', 'claude-sonnet-5', 'claude-sonnet-4-6', 'gpt-5'],

    // Bedrock-hosted Claude leads its chain with the Anthropic-direct twin (same model,
    // other provider path) so a sustained Bedrock outage (503/500/529) degrades to the
    // direct API before dropping tier or crossing providers. Bedrock<->direct twin IDs
    // per models.ts. Targets are direct-Anthropic / OpenAI, never Bedrock: Bedrock has no
    // entry in the apiKeyTable (IAM-auth, not a key), so findAutomaticFallback's key gate
    // always skips a Bedrock target - a Bedrock model is reachable as the primary, not as
    // an automatic fallback destination.
    'global.anthropic.claude-opus-4-8': [
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-5',
      'gpt-5',
    ],
    'global.anthropic.claude-opus-4-7': ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5', 'gpt-5'],
    'global.anthropic.claude-opus-4-6-v1': ['claude-opus-4-6', 'claude-sonnet-5', 'claude-sonnet-4-6', 'gpt-5'],
    'global.anthropic.claude-sonnet-4-6': ['claude-sonnet-4-6', 'claude-sonnet-5', 'gpt-5'],

    // Claude 4.5/4.6 models fallback hierarchy
    'claude-opus-4-5-20251101': [
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'gpt-5',
      'claude-haiku-4-5-20251001',
    ],
    'claude-opus-4-6': [
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'gpt-5',
      'claude-haiku-4-5-20251001',
    ],
    'claude-sonnet-5': ['claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5'],
    'global.anthropic.claude-sonnet-5': ['claude-sonnet-5', 'claude-sonnet-4-6', 'gpt-5'],
    'claude-sonnet-4-6': ['claude-sonnet-5', 'claude-sonnet-4-5-20250929', 'claude-opus-4-5-20251101', 'gpt-5'],
    'claude-sonnet-4-5-20250929': ['claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'gpt-5'],

    // Deprecated Claude models fallback to modern versions
    'claude-3-5-haiku-20241022': ['claude-haiku-4-5-20251001', 'gpt-4o-mini'],
    'us.anthropic.claude-3-5-haiku-20241022-v1:0': ['us.anthropic.claude-haiku-4-5-20251001-v1:0', 'gpt-4o-mini'],
    'claude-3-5-sonnet-20241022': ['claude-sonnet-4-6', 'gpt-4o', 'claude-haiku-4-5-20251001'],
    'claude-3-7-sonnet-20250219': ['claude-sonnet-4-6', 'gpt-4o', 'claude-haiku-4-5-20251001'],
    'claude-3-opus-20240229': ['claude-opus-4-6', 'claude-sonnet-4-6', 'gpt-4o'],
    'claude-3-haiku-20240307': ['claude-haiku-4-5-20251001', 'gpt-4o-mini'],
    'us.anthropic.claude-3-5-sonnet-20241022-v2:0': ['global.anthropic.claude-sonnet-4-6', 'gpt-4o'],
    'us.anthropic.claude-3-7-sonnet-20250219-v1:0': ['global.anthropic.claude-sonnet-4-6', 'gpt-4o'],

    // GPT models fallback to Claude
    'gpt-4o': ['claude-sonnet-4-6', 'claude-opus-4-6', 'gpt-4-turbo'],
    'gpt-4o-mini': ['claude-haiku-4-5-20251001', 'gpt-3.5-turbo'],
  };

  // Get preference list for this model
  const preferences = fallbackPreferences[originalModel.id] || [];

  // Add generic fallbacks if no specific preferences
  if (preferences.length === 0) {
    // Default to modern, reliable models
    preferences.push(
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'gpt-5',
      'claude-haiku-4-5-20251001'
    );
  }

  // Find first available fallback
  for (const modelId of preferences) {
    const fallbackModel = availableModels.find(m => m.id === modelId);

    if (fallbackModel) {
      // Check if we have API key for this model
      const hasApiKey = apiKeyTable[fallbackModel.backend] && apiKeyTable[fallbackModel.backend] !== 'expired';

      if (hasApiKey) {
        logger.info(`✅ Found automatic fallback: ${fallbackModel.id}`);
        return fallbackModel;
      }
    }
  }

  // Last resort: find ANY model with valid API key
  for (const model of availableModels) {
    if (model.id === originalModel.id) continue; // Skip the original model

    const hasApiKey = apiKeyTable[model.backend] && apiKeyTable[model.backend] !== 'expired';
    if (hasApiKey) {
      logger.info(`✅ Found last-resort fallback: ${model.id}`);
      return model;
    }
  }

  logger.error('❌ No suitable automatic fallback model found');
  return null;
}

export type LlmWithFallbackOptions = {
  /**
   * When true, skip the original model check and force a switch to a fallback model.
   * Use this when the original model is temporarily unavailable (e.g. overloaded)
   * but its backend configuration is still valid.
   */
  forceSwitch?: boolean;
};

/**
 * Attempt to get a working LLM backend with fallback support using frontend-provided model
 */
export async function getLlmWithFallback(
  originalModel: ModelInfo,
  fallbackModelId: string | undefined,
  availableModels: ModelInfo[],
  apiKeyTable: ApiKeyTable,
  logger: Logger,
  options: LlmWithFallbackOptions = {}
): Promise<FallbackAttempt | null> {
  // Try original model first (unless forceSwitch is requested, e.g. after overload retries exhausted)
  if (!options.forceSwitch) {
    const originalBackend = getLlmByModel(apiKeyTable, { modelInfo: originalModel, logger });
    if (originalBackend) {
      return { model: originalModel, backend: originalBackend, attempt: 0 };
    }
  }

  // If no fallback model provided, try to find one automatically
  if (!fallbackModelId) {
    logger.warn('⚠️ No fallback model provided, attempting automatic fallback selection');
    const automaticFallback = findAutomaticFallback(originalModel, availableModels, apiKeyTable, logger);

    if (!automaticFallback) {
      logger.error('❌ No fallback model available (neither provided nor automatic)');
      return null;
    }

    // Use the automatic fallback
    const backend = getLlmByModel(apiKeyTable, { modelInfo: automaticFallback, logger });
    if (backend) {
      logger.info(`✅ Using automatic fallback: ${automaticFallback.id}`);
      return { model: automaticFallback, backend, attempt: 1 };
    }

    logger.error('❌ Automatic fallback model failed to initialize');
    return null;
  }

  // Validate fallback model provided by frontend
  const fallbackModel = validateFallbackModel(fallbackModelId, availableModels, apiKeyTable, logger);

  if (!fallbackModel) {
    logger.error('❌ No valid fallback model available after validation');
    return null;
  }

  // Try the fallback model
  const backend = getLlmByModel(apiKeyTable, { modelInfo: fallbackModel, logger });

  if (backend) {
    logger.info(`✅ Fallback successful: Using ${fallbackModel.id}`, {
      originalModel: originalModel.id,
      fallbackModel: fallbackModel.id,
      attempt: 1,
    });

    return { model: fallbackModel, backend, attempt: 1 };
  }

  logger.error('❌ Fallback attempt failed', {
    originalModel: originalModel.id,
    attemptedFallback: fallbackModel.id,
  });

  return null;
}
