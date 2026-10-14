import { questRepository } from '@bike4mind/database';
import type { fabFilesService } from '@bike4mind/services';
import { getGeneratedImageStorage } from '@server/utils/storage';

/** The generated bucket and reply lookup every file and notebook delete door hands deleteStoredObjects. */
export const getGeneratedCopyStore = (): fabFilesService.GeneratedCopyStore => ({
  storage: getGeneratedImageStorage(),
  // Deferred, so a door that never meets a generated copy does not touch the quest repository.
  quests: { findSessionIdsByImage: key => questRepository.findSessionIdsByImage(key) },
});
