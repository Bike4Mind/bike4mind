// conformance.ts is deliberately not exported: it imports vitest and must stay out of the published bundle.
// Provider tests import it by relative path.
export * from './types';
export * from './registry';
export { OpenAIEmbeddingProvider } from './openai/OpenAIEmbeddingProvider';
export { VoyageEmbeddingProvider } from './voyage/VoyageEmbeddingProvider';
export { BedrockEmbeddingProvider } from './bedrock/BedrockEmbeddingProvider';
export { OllamaEmbeddingProvider } from './ollama/OllamaEmbeddingProvider';
