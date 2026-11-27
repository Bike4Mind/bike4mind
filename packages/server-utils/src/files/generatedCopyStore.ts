import { questRepository, sessionRepository } from '@bike4mind/database';
import type { fabFilesService } from '@bike4mind/services';
import { getGeneratedImageStorage } from '../utils/storage/index';

/**
 * The generated bucket and reply lookup every file delete door (and account erasure) hands deleteStoredObjects.
 */
export const getGeneratedCopyStore = (): fabFilesService.GeneratedCopyStore => ({
  storage: {
    delete: key => getGeneratedImageStorage().delete(key),
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
