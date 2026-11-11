import { MODEL_LIST_REVISION_CACHE_KEY, modelListRevisionOf } from '@bike4mind/common';
import { cacheRepository } from './models/infra/ops/CacheModel';

/** The current model-list revision, or null before the first bump. getAvailableModels' revision provider. */
export async function readModelListRevision(): Promise<string | null> {
  return modelListRevisionOf(await cacheRepository.findOne({ key: MODEL_LIST_REVISION_CACHE_KEY }));
}
