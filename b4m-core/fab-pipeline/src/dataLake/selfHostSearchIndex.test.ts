import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IFabFileChunkDocument } from '@bike4mind/common';

const mockOsClient = {
  indexExists: vi.fn(),
  createIndex: vi.fn(),
  indexDocument: vi.fn(),
  deleteDocumentByQuery: vi.fn(),
};

vi.mock('./opensearchClient', () => ({
  OpenSearchClient: vi.fn(function MockOpenSearchClient() {
    return mockOsClient;
  }),
}));

import { FabFileChunkSearchIndex, selfHostVectorIndexName } from './selfHostSearchIndex';
import { atlasVectorIndexName, getEmbeddingDimensions } from './atlasSearchIndex';

const MODEL = 'text-embedding-3-small';

function chunk(overrides: Partial<IFabFileChunkDocument> = {}): IFabFileChunkDocument {
  return {
    id: 'chunk-1',
    fabFileId: 'file-1',
    text: 'hello world',
    tokenCount: 2,
    vector: [0.1, 0.2, 0.3],
    embeddingModel: MODEL,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('selfHostVectorIndexName', () => {
  it('matches the Atlas index name, lowercased', () => {
    const dimension = getEmbeddingDimensions(MODEL)!;
    expect(selfHostVectorIndexName(MODEL)).toBe(atlasVectorIndexName(MODEL, dimension).toLowerCase());
  });

  it('returns null for an unregistered model', () => {
    expect(selfHostVectorIndexName('not-a-real-model')).toBeNull();
  });
});

// Must run before any other describe block: `loadSearchIndexClient` memoizes its client in a
// module-level singleton with no test-facing reset, so the "throws when unset" case only holds
// if nothing earlier in the file has already cached one.
describe('FabFileChunkSearchIndex.loadSearchIndexClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FabFileChunkSearchIndex['ensuredModels'].clear();
    delete process.env.OPENSEARCH_ENDPOINT;
  });

  it('throws when OPENSEARCH_ENDPOINT is not set', async () => {
    await expect(FabFileChunkSearchIndex.loadSearchIndexClient()).rejects.toThrow('OPENSEARCH_ENDPOINT');
  });

  it('memoizes the client across calls', async () => {
    process.env.OPENSEARCH_ENDPOINT = 'localhost:9200';
    const { OpenSearchClient } = await import('./opensearchClient');
    await FabFileChunkSearchIndex.loadSearchIndexClient();
    await FabFileChunkSearchIndex.loadSearchIndexClient();
    expect(OpenSearchClient).toHaveBeenCalledTimes(1);
  });
});

describe('FabFileChunkSearchIndex.mapDocument (via addDocument)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENSEARCH_ENDPOINT = 'localhost:9200';
    FabFileChunkSearchIndex['ensuredModels'].clear();
  });

  it('maps a valid chunk to a flat SearchDocument and indexes it', async () => {
    mockOsClient.indexDocument.mockResolvedValueOnce(undefined);
    const index = new FabFileChunkSearchIndex(chunk());

    const doc = await index.addDocument();

    expect(doc).toEqual({
      id: 'chunk-1',
      text: 'hello world',
      vector: [0.1, 0.2, 0.3],
      metadata: { fabFileId: 'file-1', embeddingModel: MODEL, sourceType: 'fabFileChunk' },
    });
    expect(mockOsClient.indexDocument).toHaveBeenCalledWith(selfHostVectorIndexName(MODEL), doc);
  });

  it('returns null and never indexes when the chunk has no vector yet', async () => {
    const index = new FabFileChunkSearchIndex(chunk({ vector: [] }));
    expect(await index.addDocument()).toBeNull();
    expect(mockOsClient.indexDocument).not.toHaveBeenCalled();
  });

  it('returns null and never indexes when the chunk has no embeddingModel', async () => {
    const index = new FabFileChunkSearchIndex(chunk({ embeddingModel: undefined }));
    expect(await index.addDocument()).toBeNull();
    expect(mockOsClient.indexDocument).not.toHaveBeenCalled();
  });

  it('returns null for an unregistered embeddingModel rather than indexing under a bad name', async () => {
    const index = new FabFileChunkSearchIndex(chunk({ embeddingModel: 'not-a-real-model' }));
    expect(await index.addDocument()).toBeNull();
    expect(mockOsClient.indexDocument).not.toHaveBeenCalled();
  });
});

describe('FabFileChunkSearchIndex.ensureIndexForModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENSEARCH_ENDPOINT = 'localhost:9200';
    FabFileChunkSearchIndex['ensuredModels'].clear();
  });

  it('creates the index once per model, memoized across calls', async () => {
    mockOsClient.indexExists.mockResolvedValue(false);
    mockOsClient.createIndex.mockResolvedValue(undefined);

    await FabFileChunkSearchIndex.ensureIndexForModel(MODEL);
    await FabFileChunkSearchIndex.ensureIndexForModel(MODEL);

    expect(mockOsClient.indexExists).toHaveBeenCalledTimes(1);
    expect(mockOsClient.createIndex).toHaveBeenCalledTimes(1);
  });

  it('skips createIndex when the index already exists', async () => {
    mockOsClient.indexExists.mockResolvedValue(true);

    await FabFileChunkSearchIndex.ensureIndexForModel(MODEL);

    expect(mockOsClient.createIndex).not.toHaveBeenCalled();
  });

  it('no-ops for an unregistered model', async () => {
    await FabFileChunkSearchIndex.ensureIndexForModel('not-a-real-model');
    expect(mockOsClient.indexExists).not.toHaveBeenCalled();
  });
});

describe('FabFileChunkSearchIndex.deleteByFabFileId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENSEARCH_ENDPOINT = 'localhost:9200';
    FabFileChunkSearchIndex['ensuredModels'].clear();
  });

  it('deletes by fabFileId term query on the model-specific index', async () => {
    mockOsClient.deleteDocumentByQuery.mockResolvedValueOnce(undefined);

    await FabFileChunkSearchIndex.deleteByFabFileId('file-1', MODEL);

    expect(mockOsClient.deleteDocumentByQuery).toHaveBeenCalledWith(selfHostVectorIndexName(MODEL), {
      query: { term: { 'metadata.fabFileId': 'file-1' } },
    });
  });

  it('swallows a delete failure rather than throwing (fail-open)', async () => {
    mockOsClient.deleteDocumentByQuery.mockRejectedValueOnce(new Error('cluster unreachable'));
    await expect(FabFileChunkSearchIndex.deleteByFabFileId('file-1', MODEL)).resolves.toBeUndefined();
  });

  it('no-ops for an unregistered model', async () => {
    await FabFileChunkSearchIndex.deleteByFabFileId('file-1', 'not-a-real-model');
    expect(mockOsClient.deleteDocumentByQuery).not.toHaveBeenCalled();
  });
});
