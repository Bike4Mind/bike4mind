import { describe, it, expect } from 'vitest';
import { buildSearchIndexSettings, buildSearchIndexSettingsForModel } from './config';

describe('buildSearchIndexSettings', () => {
  it('declares a flat knn_vector field at the given dimension with cosine similarity', () => {
    const settings = buildSearchIndexSettings(1536);

    expect(settings.mappings.properties.vector).toMatchObject({
      type: 'knn_vector',
      dimension: 1536,
      method: { engine: 'lucene', space_type: 'cosinesimil' },
    });
  });

  it('declares metadata as keyword fields so term queries can filter/delete by them', () => {
    const settings = buildSearchIndexSettings(1024);

    expect(settings.mappings.properties.metadata.properties).toEqual({
      fabFileId: { type: 'keyword' },
      embeddingModel: { type: 'keyword' },
      sourceType: { type: 'keyword' },
    });
  });
});

describe('buildSearchIndexSettingsForModel', () => {
  it('resolves the dimension for a registered model', () => {
    const settings = buildSearchIndexSettingsForModel('text-embedding-3-small');
    expect(settings?.mappings.properties.vector.dimension).toBeGreaterThan(0);
  });

  it('returns null for an unregistered model rather than defaulting silently', () => {
    expect(buildSearchIndexSettingsForModel('not-a-real-model')).toBeNull();
  });
});
