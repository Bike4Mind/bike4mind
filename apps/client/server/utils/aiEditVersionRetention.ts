import { resolveAiEditVersionRetention, type IFabFileVersion } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { getSettingsByNames } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { getFilesStorage } from '@server/utils/storage';

/** The admin-configured AI-edit version cap. Never throws: a settings outage must not fail an edit. */
export async function getAiEditVersionRetention(): Promise<number> {
  try {
    const values = await getSettingsByNames(['AiEditVersionRetention'], { adminSettings: adminSettingsRepository });
    return resolveAiEditVersionRetention(values.AiEditVersionRetention);
  } catch (err) {
    Logger.globalInstance.warn('[aiEditVersionRetention] could not read setting; using default', err);
    return resolveAiEditVersionRetention(undefined);
  }
}

/**
 * Best-effort delete of the objects behind versions trimmed by `appendEditedVersion`. Call only
 * after the DB write that drops them from `versions[]` has succeeded; a failed delete just
 * orphans the object, it never fails the edit.
 */
export async function deleteDroppedVersions(dropped: IFabFileVersion[]): Promise<void> {
  const results = await Promise.allSettled(dropped.map(v => getFilesStorage().delete(v.filePath)));
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      Logger.globalInstance.warn(
        `[aiEditVersionRetention] failed to delete trimmed version ${dropped[i].filePath}`,
        result.reason
      );
    }
  });
}
