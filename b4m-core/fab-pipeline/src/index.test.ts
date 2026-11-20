import { describe, it, expect } from 'vitest';
import * as fp from './index';

describe('@bike4mind/fab-pipeline public exports', () => {
  it.each([
    'SmartChunker',
    'ChunkSchema',
    'URL_REGEX',
    'detectURLs',
    'hasURLs',
    'urlExists',
    'fetchAndParseURL',
    'validateUrlForFetch',
    'isPrivateIP',
    'isPrivateOrInternalHostname',
    // The connect-time pin. Pinned by name because the Developer Notes advertise `ssrfSafeLookup` as a
    // reusable primitive for other http/https callers, so it is public surface, not an internal detail.
    'ssrfSafeLookup',
    'ssrfSafeHttpAgent',
    'ssrfSafeHttpsAgent',
    'SSRF_BLOCKED_CODE',
    'ssrfSafeDownload',
    'EmbeddingModelProvider',
    'EmbeddingAuthError',
    'isEmbeddingAuthError',
    'OPENAI_MAX_INPUTS_PER_REQUEST',
    'OPENAI_MAX_TOKENS_PER_INPUT',
    'OPENAI_EFFECTIVE_TOKEN_LIMIT',
    'recordEmbeddingRateLimitHeaders',
    'BEDROCK_EMBEDDING_MODEL_MAP',
    'OPENAI_EMBEDDING_MODEL_MAP',
    'VOYAGEAI_EMBEDDING_MODEL_MAP',
    'BaseStorage',
    'S3Storage',
    'BaseSearchIndex',
    'OpenSearchClient',
    'buildSearchIndexSettings',
    'buildSearchIndexSettingsForModel',
    'FabFileChunkSearchIndex',
    'selfHostVectorIndexName',
  ])('exports %s', sym => {
    expect((fp as Record<string, unknown>)[sym]).toBeDefined();
  });
});
