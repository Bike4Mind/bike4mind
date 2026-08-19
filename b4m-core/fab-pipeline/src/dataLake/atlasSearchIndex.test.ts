import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIEmbeddingModel, VoyageAIEmbeddingModel } from '@bike4mind/common';

const { supportsAtlasVectorSearchMock } = vi.hoisted(() => ({
  supportsAtlasVectorSearchMock: vi.fn(() => true),
}));
vi.mock('@bike4mind/db-core', () => ({
  supportsAtlasVectorSearch: supportsAtlasVectorSearchMock,
}));

import {
  getEmbeddingDimensions,
  atlasVectorIndexName,
  getAtlasIndexForModel,
  buildAtlasVectorIndexDefinition,
  allAtlasVectorIndexDefinitions,
  ensureAtlasVectorSearchIndexes,
  getAtlasIndexStatus,
  resetAtlasIndexStatusCache,
  modelsWithDimensions,
} from './atlasSearchIndex';

describe('atlasSearchIndex', () => {
  beforeEach(() => {
    resetAtlasIndexStatusCache();
    supportsAtlasVectorSearchMock.mockReturnValue(true);
  });

  describe('getEmbeddingDimensions', () => {
    it('resolves known models across providers', () => {
      expect(getEmbeddingDimensions(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL)).toBe(1536);
      expect(getEmbeddingDimensions(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE)).toBe(3072);
      expect(getEmbeddingDimensions(VoyageAIEmbeddingModel.VOYAGE_3_LARGE)).toBe(1024);
    });

    it('returns null for an unknown model', () => {
      expect(getEmbeddingDimensions('not-a-real-model')).toBeNull();
    });
  });

  describe('atlasVectorIndexName', () => {
    it('sanitizes non-identifier characters and stays under the 63-char Atlas limit', () => {
      for (const model of Object.values(OpenAIEmbeddingModel).concat(Object.values(VoyageAIEmbeddingModel))) {
        const dims = getEmbeddingDimensions(model);
        if (dims === null) continue;
        const name = atlasVectorIndexName(model, dims);
        expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
        expect(name.length).toBeLessThanOrEqual(63);
      }
    });

    it('keys by model AND width so a same-width different-model pair does not collide', () => {
      // ada-002 and 3-small are both 1536-dim but distinct models.
      const adaName = atlasVectorIndexName(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002, 1536);
      const smallName = atlasVectorIndexName(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL, 1536);
      expect(adaName).not.toBe(smallName);
    });
  });

  describe('modelsWithDimensions', () => {
    it('finds every model sharing a width, including cross-model collisions', () => {
      const models = modelsWithDimensions(1536);
      expect(models).toEqual(
        expect.arrayContaining([
          OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002,
          OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL,
        ])
      );
    });

    it('returns an empty array for an unregistered width', () => {
      expect(modelsWithDimensions(999_999)).toEqual([]);
    });
  });

  describe('getAtlasIndexForModel', () => {
    it('returns null for an unsupported model', () => {
      expect(getAtlasIndexForModel('not-a-real-model')).toBeNull();
    });
  });

  describe('buildAtlasVectorIndexDefinition', () => {
    it('declares fabFileId and embeddingModel as filter fields (Atlas throws on an undeclared filter path)', () => {
      const def = buildAtlasVectorIndexDefinition(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL);
      expect(def).not.toBeNull();
      const filterFields = def!.definition.fields.filter(f => f.type === 'filter').map(f => f.path);
      expect(filterFields).toEqual(expect.arrayContaining(['fabFileId', 'embeddingModel']));
    });

    it('declares exactly one vector field at the model width', () => {
      const def = buildAtlasVectorIndexDefinition(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE);
      const vectorFields = def!.definition.fields.filter(f => f.type === 'vector');
      expect(vectorFields).toEqual([{ type: 'vector', path: 'vector', numDimensions: 3072, similarity: 'cosine' }]);
    });

    it('returns null for an unsupported model', () => {
      expect(buildAtlasVectorIndexDefinition('not-a-real-model')).toBeNull();
    });
  });

  describe('allAtlasVectorIndexDefinitions', () => {
    it('produces one definition per registered model, all filter-complete', () => {
      const defs = allAtlasVectorIndexDefinitions();
      expect(defs.length).toBeGreaterThan(0);
      for (const def of defs) {
        const filterFields = def.definition.fields.filter(f => f.type === 'filter').map(f => f.path);
        expect(filterFields).toEqual(expect.arrayContaining(['fabFileId', 'embeddingModel']));
      }
      const names = defs.map(d => d.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });

  const makeMockCollection = (existingNames: string[] = []) => {
    const createSearchIndex = vi.fn().mockResolvedValue('created');
    const listSearchIndexes = vi.fn((name?: string) => {
      const docs = existingNames
        .filter(n => !name || n === name)
        .map(n => ({ name: n, queryable: true, status: 'READY' }));
      return {
        [Symbol.asyncIterator]: async function* () {
          for (const doc of docs) yield doc;
        },
        toArray: async () => docs,
      };
    });
    return { createSearchIndex, listSearchIndexes };
  };

  describe('ensureAtlasVectorSearchIndexes', () => {
    it('no-ops on a non-Atlas backend without touching the collection', async () => {
      supportsAtlasVectorSearchMock.mockReturnValue(false);
      const collection = makeMockCollection();
      const conn = { collection: vi.fn(() => collection) } as any;
      await ensureAtlasVectorSearchIndexes(conn, { log: vi.fn(), warn: vi.fn() } as any);
      expect(collection.createSearchIndex).not.toHaveBeenCalled();
    });

    it('creates only the indexes that do not already exist', async () => {
      const allNames = allAtlasVectorIndexDefinitions().map(d => d.name);
      const collection = makeMockCollection([allNames[0]]);
      const conn = { collection: vi.fn(() => collection) } as any;
      await ensureAtlasVectorSearchIndexes(conn, { log: vi.fn(), warn: vi.fn() } as any);
      const createdNames = collection.createSearchIndex.mock.calls.map((c: any) => c[0].name);
      expect(createdNames).not.toContain(allNames[0]);
      expect(createdNames.length).toBe(allNames.length - 1);
    });

    it('swallows a per-index create failure and continues with the rest', async () => {
      const collection = makeMockCollection();
      collection.createSearchIndex.mockRejectedValueOnce(new Error('quota exceeded')).mockResolvedValue('created');
      const conn = { collection: vi.fn(() => collection) } as any;
      const warn = vi.fn();
      await expect(ensureAtlasVectorSearchIndexes(conn, { log: vi.fn(), warn } as any)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
      expect(collection.createSearchIndex.mock.calls.length).toBe(allAtlasVectorIndexDefinitions().length);
    });

    it('logs a created/already-existed/failed summary so a swallowed quota failure is visible without grepping', async () => {
      const allNames = allAtlasVectorIndexDefinitions().map(d => d.name);
      const collection = makeMockCollection([allNames[0]]);
      collection.createSearchIndex.mockRejectedValueOnce(new Error('quota exceeded')).mockResolvedValue('created');
      const conn = { collection: vi.fn(() => collection) } as any;
      const log = vi.fn();
      await ensureAtlasVectorSearchIndexes(conn, { log, warn: vi.fn() } as any);

      const remaining = allNames.length - 1; // one already existed
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`created=${remaining - 1} already-existed=1 failed=1`));
    });
  });

  describe('getAtlasIndexStatus', () => {
    it('returns null for an unsupported model without touching the connection', async () => {
      const conn = { collection: vi.fn() } as any;
      expect(await getAtlasIndexStatus(conn, 'not-a-real-model')).toBeNull();
      expect(conn.collection).not.toHaveBeenCalled();
    });

    it('reports queryable status for an existing index', async () => {
      const target = getAtlasIndexForModel(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL)!;
      const collection = makeMockCollection([target.name]);
      const conn = { collection: vi.fn(() => collection) } as any;
      const status = await getAtlasIndexStatus(conn, OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL);
      expect(status).toEqual({ queryable: true, status: 'READY' });
    });

    it('caches the result and does not re-query within the TTL', async () => {
      const target = getAtlasIndexForModel(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL)!;
      const collection = makeMockCollection([target.name]);
      const conn = { collection: vi.fn(() => collection) } as any;
      await getAtlasIndexStatus(conn, OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL);
      await getAtlasIndexStatus(conn, OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL);
      expect(collection.listSearchIndexes).toHaveBeenCalledTimes(1);
    });
  });
});
