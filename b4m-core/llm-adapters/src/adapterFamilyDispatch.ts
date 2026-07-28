import type { AdapterFamily } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { AnthropicBackend } from './anthropicBackend';
import { AWSBackend } from './awsBackend';
import type { ICompletionBackend } from './backend';
import type { ApiKeyTable } from './backendGate';
import AnthropicBedrockBackend from './bedrockBackend/anthropic';
import DeepSeekBedrockBackend from './bedrockBackend/deepseek';
import JurassicTwoBedrockBackend from './bedrockBackend/jurassicTwo';
import LlamaBedrockBackend from './bedrockBackend/llama';
import TitanBedrockBackend from './bedrockBackend/titan';
import { BFLBackend } from './bflBackend';
import { GeminiBackend } from './geminiBackend';
import { LocalImageBackend } from './localImageBackend';
import { OllamaBackend } from './ollamaBackend';
import { OpenAIBackend } from './openaiBackend';
import { XAIBackend } from './xaiBackend';

/**
 * A record named an adapter family this build has no constructor for. Thrown
 * rather than returned as null on purpose (sec 9 item 3): a null is
 * indistinguishable from "this caller has no key", so the family that nobody
 * wired would look like a credential problem forever.
 */
export class UnsupportedAdapterFamilyError extends Error {
  constructor(
    readonly family: string,
    readonly modelId: string
  ) {
    super(
      `No backend constructor for adapterFamily "${family}" (model "${modelId}"). ` +
        'A catalog row may not be promoted to an invocable status for a family this build cannot dispatch.'
    );
    this.name = 'UnsupportedAdapterFamilyError';
  }
}

export interface AdapterFamilyDispatchContext {
  apiKeyTable: ApiKeyTable;
  modelId: string;
  logger: Logger;
  /** Opaque, non-PII end-user id forwarded to the direct-provider backends. */
  providerEndUserId?: string;
}

/** An expired key is a configuration error, not an absent credential. */
function keyOrThrow(value: string | null | undefined, providerLabel: string): string | null {
  if (value === 'expired') throw new Error(`${providerLabel} API key is expired`);
  return value ?? null;
}

/**
 * Construct the backend for a resolved `adapterFamily`. Null means "this caller
 * has no credential for it", exactly as the legacy id switch reports it; an
 * unknown family throws.
 *
 * MUST STAY IN SYNC WITH the legacy `modelInfo.backend` switch in ./index.ts and
 * with DISPATCHABLE_ADAPTER_FAMILIES in ./mergeCatalog.ts: the merge promises a
 * catalog-only record in a dispatchable family reaches a real backend, and this
 * is the function that has to keep that promise.
 */
export function backendForAdapterFamily(
  family: AdapterFamily,
  ctx: AdapterFamilyDispatchContext
): ICompletionBackend | null {
  const { apiKeyTable, logger, providerEndUserId } = ctx;

  switch (family) {
    case 'openai-chat':
    case 'openai-responses': {
      // One constructor, two transports: which endpoint a turn uses is the
      // dispatch profile's toolTransport, not a separate backend.
      const key = keyOrThrow(apiKeyTable.openai, 'OpenAI');
      return key ? new OpenAIBackend(key, logger, providerEndUserId) : null;
    }
    case 'anthropic-messages': {
      const key = keyOrThrow(apiKeyTable.anthropic, 'Anthropic');
      return key ? new AnthropicBackend(key, logger, providerEndUserId) : null;
    }
    case 'gemini': {
      const key = keyOrThrow(apiKeyTable.gemini, 'Gemini');
      return key ? new GeminiBackend(key) : null;
    }
    case 'ollama': {
      const key = keyOrThrow(apiKeyTable.ollama, 'Ollama');
      return key ? new OllamaBackend(key) : null;
    }
    case 'xai': {
      const key = keyOrThrow(apiKeyTable.xai, 'xAI');
      return key ? new XAIBackend(key) : null;
    }
    case 'bfl': {
      // Matches the legacy switch and resolveListingKey: no key falls back to
      // the demo key rather than to null.
      const key = keyOrThrow(apiKeyTable.bfl, 'BFL');
      return new BFLBackend(key ?? 'demo-key');
    }
    case 'local-image': {
      const baseUrl = keyOrThrow(apiKeyTable['local-image'], 'Local image');
      return baseUrl ? new LocalImageBackend(baseUrl, logger) : null;
    }
    case 'bedrock-anthropic':
      return new AnthropicBedrockBackend();
    case 'bedrock-llama':
      return new LlamaBedrockBackend();
    case 'bedrock-deepseek':
      return new DeepSeekBedrockBackend();
    case 'bedrock-jurassic':
      return new JurassicTwoBedrockBackend();
    case 'bedrock-titan':
      return new TitanBedrockBackend();
    case 'aws':
      return new AWSBackend();
    // VoyageAI has no completion backend at all: embeddings go through their own
    // path, so a record routed here is a catalog defect and says so.
    default:
      throw new UnsupportedAdapterFamilyError(family, ctx.modelId);
  }
}
