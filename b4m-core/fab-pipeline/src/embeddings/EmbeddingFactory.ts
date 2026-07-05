import {
  BedrockEmbeddingModel,
  OpenAIEmbeddingModel,
  SupportedEmbeddingModel,
  VoyageAIEmbeddingModel,
} from '@bike4mind/common';
import { EmbeddingModelProvider, EmbeddingService } from './EmbeddingService';
import { BEDROCK_EMBEDDING_MODEL_MAP, BedrockEmbeddingService } from './providers/BedrockEmbeddingService';
import { OPENAI_EMBEDDING_MODEL_MAP, OpenAIEmbeddingService } from './providers/OpenAIEmbeddingService';
import { VOYAGEAI_EMBEDDING_MODEL_MAP, VoyageAIEmbeddingProvider } from './providers/VoyageAIEmbeddingService';

/**
 * Configuration for embedding services
 */
export type EmbeddingConfig = {
  openaiApiKey?: string | null;
  voyageApiKey?: string | null; // Match database naming
};

/**
 * Factory class for creating and managing embedding services.
 * Supports multiple providers (OpenAI, VoyageAI, and Bedrock) and handles their configuration.
 *
 * @example
 * ```typescript
 * // Initialize factory with API keys
 * const factory = new EmbeddingFactory({
 *   openaiApiKey: process.env.OPENAI_API_KEY,
 *   voyageApiKey: process.env.VOYAGE_API_KEY
 * });
 *
 * // Create an OpenAI embedding service
 * const service = factory.createEmbeddingService(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
 *
 * // Generate embeddings
 * const embedding = await service.generateEmbedding('Hello, world!');
 * ```
 */
export class EmbeddingFactory {
  private providers: Map<EmbeddingModelProvider, EmbeddingService>;
  private config: EmbeddingConfig;

  /**
   * Creates a new EmbeddingFactory instance
   * @param config Configuration containing API keys for different providers
   */
  constructor(config: EmbeddingConfig) {
    this.config = config;
    this.providers = new Map();
    this.initializeProviders();
  }

  /**
   * Creates or updates an embedding service for the specified model.
   * @param modelName The model to use for embeddings (from OpenAI, VoyageAI, or Bedrock)
   * @returns An initialized EmbeddingService instance
   * @throws Error if the required API key is not configured or if provider initialization fails
   */
  public createEmbeddingService(modelName: SupportedEmbeddingModel): EmbeddingService {
    const provider = this.getProviderFromModel(modelName);

    // Initialize or update the provider with the specified model
    if (provider === EmbeddingModelProvider.OPENAI) {
      if (!this.config.openaiApiKey) {
        throw new Error('OpenAI API key is required but not provided!');
      }
      this.providers.set(
        provider,
        new OpenAIEmbeddingService(this.config.openaiApiKey!, modelName as OpenAIEmbeddingModel)
      );
    } else if (provider === EmbeddingModelProvider.BEDROCK) {
      this.providers.set(provider, new BedrockEmbeddingService(modelName as BedrockEmbeddingModel));
    } else {
      if (!this.config.voyageApiKey) {
        throw new Error('VoyageAI API key is required but not provided');
      }
      this.providers.set(
        provider,
        new VoyageAIEmbeddingProvider(this.config.voyageApiKey!, modelName as VoyageAIEmbeddingModel)
      );
    }

    const embeddingProvider = this.providers.get(provider);
    if (!embeddingProvider) {
      throw new Error(`Failed to initialize provider for model: ${modelName}`);
    }

    return embeddingProvider;
  }

  /**
   * Updates the API keys configuration and reinitializes providers
   * @param config Partial configuration to update
   */
  public configure(config: Partial<EmbeddingConfig>): void {
    this.config = { ...this.config, ...config };
    // Reinitialize providers with the updated configuration
    this.initializeProviders();
  }

  /**
   * Returns a list of all available embedding models from configured providers
   * Only includes models from providers that have API keys configured
   * @returns Array of model names as strings
   */
  public getAvailableModels(): string[] {
    const models: string[] = [];

    if (this.config.openaiApiKey) {
      models.push(...Object.keys(OPENAI_EMBEDDING_MODEL_MAP));
    }

    if (this.config.voyageApiKey) {
      models.push(...Object.keys(VOYAGEAI_EMBEDDING_MODEL_MAP));
    }

    models.push(...Object.keys(BEDROCK_EMBEDDING_MODEL_MAP));

    return models;
  }

  /**
   * Automatically selects the best available embedding model based on configured API keys
   * Priority: OpenAI > VoyageAI > Bedrock
   * @returns The recommended embedding model name
   */
  public getDefaultEmbeddingModel(): SupportedEmbeddingModel {
    // Priority 1: OpenAI (if API key available)
    if (this.config.openaiApiKey) {
      return OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002;
    }

    // Priority 2: VoyageAI (if API key available)
    if (this.config.voyageApiKey) {
      return VoyageAIEmbeddingModel.VOYAGE_3;
    }

    // Priority 3: Bedrock (always available - uses AWS credentials)
    return BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2;
  }

  /**
   * Gets the current configuration for debugging purposes
   * @returns The current embedding configuration
   */
  public getConfig(): EmbeddingConfig {
    return { ...this.config };
  }

  /**
   * Initializes embedding service providers based on available API keys
   * Creates default instances with recommended models for each configured provider
   * @private
   */
  private initializeProviders(): void {
    this.providers.clear();

    // Initialize OpenAI provider with default model if API key is available
    if (this.config.openaiApiKey) {
      this.providers.set(
        EmbeddingModelProvider.OPENAI,
        new OpenAIEmbeddingService(this.config.openaiApiKey, OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002)
      );
    }

    // Initialize VoyageAI provider with default model if API key is available
    if (this.config.voyageApiKey) {
      this.providers.set(
        EmbeddingModelProvider.VOYAGE_AI,
        new VoyageAIEmbeddingProvider(this.config.voyageApiKey, VoyageAIEmbeddingModel.VOYAGE_3)
      );
    }

    // Initialize Bedrock provider with default model if credentials are available
    this.providers.set(
      EmbeddingModelProvider.BEDROCK,
      new BedrockEmbeddingService(BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2)
    );
  }

  /**
   * Determines the appropriate provider for a given model name
   * @param modelName Name of the embedding model
   * @returns The corresponding provider enum value
   * @throws Error if the model is unknown or if the required API key is not configured
   * @private
   */
  private getProviderFromModel(modelName: string): EmbeddingModelProvider {
    if (Object.values(OpenAIEmbeddingModel).includes(modelName as OpenAIEmbeddingModel)) {
      return EmbeddingModelProvider.OPENAI;
    }

    if (Object.values(VoyageAIEmbeddingModel).includes(modelName as VoyageAIEmbeddingModel)) {
      return EmbeddingModelProvider.VOYAGE_AI;
    }

    if (Object.values(BedrockEmbeddingModel).includes(modelName as BedrockEmbeddingModel)) {
      return EmbeddingModelProvider.BEDROCK;
    }

    throw new Error(`Unknown model: ${modelName}`);
  }
}
