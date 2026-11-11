import { questRepository, sessionRepository } from '@bike4mind/database';
import type { fabFilesService } from '@bike4mind/services';
import { getGeneratedImageStorage } from '../utils/storage/index';
import {
  type CdnInvalidationBatch,
  generatedCdnPath,
  invalidateRouterPaths,
} from '../services/cdn/invalidateRouterCdn';
import type { MinimalLogger } from '../services/publish/minimalLogger';

/**
 * The generated bucket and reply lookup every file delete door (and account erasure) hands deleteStoredObjects.
 * A deleted copy's `/generated/<key>` CDN path joins `batch` when given (the caller flushes it), else is
 * invalidated right away.
 */
export const getGeneratedCopyStore = ({
  batch,
  logger,
}: { batch?: CdnInvalidationBatch; logger?: MinimalLogger } = {}): fabFilesService.GeneratedCopyStore => ({
  storage: {
    delete: async key => {
      await getGeneratedImageStorage().delete(key);
      if (batch) batch.add(generatedCdnPath(key));
      else await invalidateRouterPaths([generatedCdnPath(key)], { label: 'generated-copy', logger });
    },
  },
  // Live notebooks only: no restore exists for a deleted one, so a dead fork must not pin the copy forever.
  // Deferred, so a door that never meets a generated copy does not touch the quest repository.
  quests: {
    findSessionIdsByMedia: async key => {
      const sessionIds = await questRepository.findSessionIdsByMedia(key);
      if (sessionIds.length === 0) return sessionIds;
      return (await sessionRepository.findAllByIds(sessionIds)).map(session => String(session.id));
    },
  },
});
