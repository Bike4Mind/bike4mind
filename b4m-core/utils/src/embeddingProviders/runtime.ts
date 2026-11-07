import {
  BedrockEmbeddingModel,
  defaultEmbeddingModelForEnv,
  EMBEDDING_MODEL_CATALOG,
  hasKeylessCloudEmbedder,
  isPlaceholderApiKey,
  ModelBackend,
  OllamaEmbeddingModel,
  OpenAIEmbeddingModel,
  VoyageAIEmbeddingModel,
  type EmbeddingModelId,
  type SupportedEmbeddingModel,
} from '@bike4mind/common';
import { OPENAI_KEY_MISSING_MESSAGE, VOYAGE_KEY_MISSING_MESSAGE } from '@bike4mind/fab-pipeline';
import { GeminiEmbeddingProvider } from './gemini/GeminiEmbeddingProvider';
import { BedrockEmbeddingProvider } from './bedrock/BedrockEmbeddingProvider';
import { OpenAIEmbeddingProvider } from './openai/OpenAIEmbeddingProvider';
import { VoyageEmbeddingProvider } from './voyage/VoyageEmbeddingProvider';
import { OllamaEmbeddingProvider } from './ollama/OllamaEmbeddingProvider';
import { createEmbeddingProviderRegistry, type EmbeddingProviderRegistry } from './registry';
import type { EmbeddingProvider, EmbeddingResult } from './types';

export type EmbeddingConfig = {
  openaiApiKey?: string | null;
  voyageApiKey?: string | null;
  ollamaBaseUrl?: string | null;
  geminiApiKey?: string | null;
  cohereModelId?: string;
};
export type EmbeddingKeyTable = {
  openai?: string | null;
  voyageai?: string | null;
  ollama?: string | null;
  gemini?: string | null;
};
export type EmbeddingCredential = 'openai' | 'voyageai' | 'ollama' | 'gemini';
export type ResolvedEmbeddingConfig = { config: EmbeddingConfig; missing: EmbeddingCredential | null };
export type EmbeddingRuntime = EmbeddingProviderRegistry & { defaultModel: SupportedEmbeddingModel };
export type BoundEmbeddingModel = {
  model: EmbeddingModelId;
  maxInputTokens: number;
  embed(inputs: readonly string[], dimensions?: number): Promise<EmbeddingResult>;
};

export const usableEmbeddingApiKey = (raw: string | null | undefined): string | null => {
  const value = raw?.trim();
  return !value || value === 'expired' || isPlaceholderApiKey(value) ? null : value;
};

export const embeddingBackendForModel = (
  model: string
): ModelBackend.OpenAI | ModelBackend.VoyageAI | ModelBackend.Bedrock | ModelBackend.Ollama | ModelBackend.Gemini => {
  if (!Object.hasOwn(EMBEDDING_MODEL_CATALOG, model)) throw new Error(`Unknown embedding model: ${model}`);
  const provider = EMBEDDING_MODEL_CATALOG[model as EmbeddingModelId].provider;
  const backends = {
    openai: ModelBackend.OpenAI,
    voyage: ModelBackend.VoyageAI,
    bedrock: ModelBackend.Bedrock,
    ollama: ModelBackend.Ollama,
    gemini: ModelBackend.Gemini,
  } as const;
  return backends[provider];
};

export const resolveEmbeddingCredentials = (
  provider: ReturnType<typeof embeddingBackendForModel>,
  keys: EmbeddingKeyTable | null | undefined
): ResolvedEmbeddingConfig => {
  if (provider === ModelBackend.Bedrock) return { config: {}, missing: null };
  const mapping = {
    [ModelBackend.OpenAI]: ['openai', 'openaiApiKey'],
    [ModelBackend.VoyageAI]: ['voyageai', 'voyageApiKey'],
    [ModelBackend.Ollama]: ['ollama', 'ollamaBaseUrl'],
    [ModelBackend.Gemini]: ['gemini', 'geminiApiKey'],
  } as const;
  const [credential, field] = mapping[provider];
  const value = credential === 'ollama' ? keys?.ollama?.trim() : usableEmbeddingApiKey(keys?.[credential]);
  return value ? { config: { [field]: value }, missing: null } : { config: {}, missing: credential };
};

/**
 * Only for callers free to choose the model (the admin default). Memento and alternateModelAnn paths are pinned to one
 * vector space and must fail instead. An expired caller key is not "keyless": substituting Titan would query a space
 * the corpus was never written in, so the requested model is kept and the expired-key error stands.
 */
export const resolveEmbeddingWithKeylessFallback = (
  model: SupportedEmbeddingModel,
  keys: EmbeddingKeyTable | null | undefined
): ResolvedEmbeddingConfig & { model: SupportedEmbeddingModel } => {
  const resolution = resolveEmbeddingCredentials(embeddingBackendForModel(model), keys);
  const expiredCallerKey = resolution.missing !== null && keys?.[resolution.missing] === 'expired';
  if (!resolution.missing || resolution.missing === 'ollama' || expiredCallerKey || !hasKeylessCloudEmbedder())
    return { ...resolution, model };
  return { config: {}, missing: null, model: BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2 };
};

export const getDefaultEmbeddingModel = (config: EmbeddingConfig): SupportedEmbeddingModel => {
  // Stays ada-002: attached-file cosine selection keys the query vector by one model and looks it up by each file's
  // label, and unlabeled files resolve to ada-002. Moving this drops their similarity selection until that lookup
  // embeds one query per distinct file label.
  if (usableEmbeddingApiKey(config.openaiApiKey)) return OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002;
  if (usableEmbeddingApiKey(config.voyageApiKey)) return VoyageAIEmbeddingModel.VOYAGE_3;
  if (config.ollamaBaseUrl) {
    const selected = defaultEmbeddingModelForEnv();
    return Object.values(OllamaEmbeddingModel).includes(selected as OllamaEmbeddingModel)
      ? selected
      : OllamaEmbeddingModel.QWEN3_EMBEDDING_0_6B;
  }
  return BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2;
};

export const buildEmbeddingRegistry = (
  config: EmbeddingConfig,
  { includeBedrock = true }: { includeBedrock?: boolean } = {}
): EmbeddingRuntime => {
  const providers: EmbeddingProvider[] = includeBedrock
    ? [
        new BedrockEmbeddingProvider({
          cohereModelId: config.cohereModelId ?? process.env.BEDROCK_COHERE_EMBED_MODEL_ID,
        }),
      ]
    : [];
  const openai = usableEmbeddingApiKey(config.openaiApiKey);
  const voyage = usableEmbeddingApiKey(config.voyageApiKey);
  const gemini = usableEmbeddingApiKey(config.geminiApiKey);
  if (gemini) providers.push(new GeminiEmbeddingProvider({ apiKey: gemini }));
  if (openai) providers.push(new OpenAIEmbeddingProvider({ apiKey: openai }));
  if (voyage) providers.push(new VoyageEmbeddingProvider({ apiKey: voyage }));
  if (config.ollamaBaseUrl) providers.push(new OllamaEmbeddingProvider({ baseUrl: config.ollamaBaseUrl }));
  return { ...createEmbeddingProviderRegistry(providers), defaultModel: getDefaultEmbeddingModel(config) };
};

export const bindEmbeddingModel = (
  registry: EmbeddingProviderRegistry,
  model: EmbeddingModelId
): BoundEmbeddingModel => {
  if (!Object.hasOwn(EMBEDDING_MODEL_CATALOG, model)) throw new Error(`Unknown embedding model: ${model}`);
  const capabilities = EMBEDDING_MODEL_CATALOG[model];
  const provider = registry.get(capabilities.provider);
  if (!provider) {
    if (capabilities.provider === 'openai') throw new Error(OPENAI_KEY_MISSING_MESSAGE);
    if (capabilities.provider === 'voyage') throw new Error(VOYAGE_KEY_MISSING_MESSAGE);
    throw new Error(`Embedding provider ${capabilities.provider} is not configured for ${model}`);
  }
  return {
    model,
    maxInputTokens: capabilities.maxInputTokens,
    embed: (inputs, dimensions) => provider.embed({ model, inputs, dimensions }),
  };
};

export const embedOne = async (bound: BoundEmbeddingModel, text: string, dimensions?: number): Promise<number[]> => {
  const result = await bound.embed([text], dimensions);
  const vector = result.vectors[0];
  if (!vector) throw new Error(`Embedding provider returned no vector for ${bound.model}`);
  return vector;
};

/**
 * The registry the public embedding routes list and call. Bedrock is offered only where a keyless cloud embedder
 * exists (never on self-host), so discovery does not list a model whose call would fail upstream.
 */
export const getEmbeddingProviderRegistry = (keys: EmbeddingKeyTable): EmbeddingRuntime =>
  buildEmbeddingRegistry(
    {
      openaiApiKey: usableEmbeddingApiKey(keys.openai),
      voyageApiKey: usableEmbeddingApiKey(keys.voyageai),
      ollamaBaseUrl: keys.ollama?.trim(),
      geminiApiKey: usableEmbeddingApiKey(keys.gemini),
    },
    { includeBedrock: hasKeylessCloudEmbedder() }
  );

export const resolveEmbeddingProvider = (
  model: EmbeddingModelId,
  keys: EmbeddingKeyTable
): { provider: EmbeddingProvider | undefined; missing: EmbeddingCredential | null } => {
  const resolution = resolveEmbeddingCredentials(embeddingBackendForModel(model), keys);
  const provider = resolution.missing
    ? undefined
    : getEmbeddingProviderRegistry(keys).get(EMBEDDING_MODEL_CATALOG[model].provider);
  return {
    provider: provider?.models.includes(model) ? provider : undefined,
    missing: resolution.missing,
  };
};
