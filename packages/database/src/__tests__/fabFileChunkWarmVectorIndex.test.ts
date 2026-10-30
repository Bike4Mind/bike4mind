import { getAtlasIndexForModel } from '@bike4mind/fab-pipeline';
import { describe, expect, it, vi } from 'vitest';
import { FabFileChunkRepository } from '../models/content/FabFileModel';

const makeRepository = (docs: unknown[] = [{ _id: 'c1' }]) => {
  const aggregate = vi.fn().mockResolvedValue(docs);
  const repository = new FabFileChunkRepository({ aggregate } as unknown as ConstructorParameters<
    typeof FabFileChunkRepository
  >[0]);
  return { repository, aggregate };
};

describe('FabFileChunkRepository.warmVectorIndex', () => {
  it('runs one wide $vectorSearch over the model partition with a unit query vector', async () => {
    const model = 'text-embedding-3-small';
    const target = getAtlasIndexForModel(model);
    const { repository, aggregate } = makeRepository();

    expect(await repository.warmVectorIndex(model)).toEqual({ hits: 1 });

    const stage = aggregate.mock.calls[0][0][0].$vectorSearch;
    expect(stage).toMatchObject({
      index: target?.name,
      path: 'vector',
      numCandidates: 10_000,
      limit: 1,
      filter: { embeddingModel: model },
    });
    expect(stage.queryVector).toHaveLength(target?.numDimensions ?? -1);
    expect(Math.hypot(...stage.queryVector)).toBeCloseTo(1, 6);
  });

  it('returns null without querying when the model has no Atlas index', async () => {
    const { repository, aggregate } = makeRepository();

    expect(await repository.warmVectorIndex('not-a-model')).toBeNull();
    expect(aggregate).not.toHaveBeenCalled();
  });
});
