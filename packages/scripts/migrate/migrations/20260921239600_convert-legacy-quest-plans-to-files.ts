import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { convertLegacyQuestPlans, type ArchiveStorage } from '../legacyQuestPlanConversion';
import { type MigrationFile } from './index';

/**
 * Writes each live, non-empty legacy QuestMaster plan (v4) and graph (v5) as one markdown file
 * owned by its owner, exempt from the storage quota. The conversion is in
 * ../legacyQuestPlanConversion.ts so a later pass can reuse it under a new migration id.
 */
const migration: MigrationFile = {
  // Backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), which must sort last.
  id: 20260921239600,
  name: 'convert legacy quest plans and graphs to markdown files',

  up: async () => {
    const files = getFilesStorage();
    const storage: ArchiveStorage = {
      upload: (path, content, options) =>
        files.upload(content ?? '', path, {
          ContentType: options?.ContentType || 'text/markdown',
          ContentLength: options?.ContentLength ?? Buffer.byteLength(content ?? '', 'utf8'),
        }),
      generateSignedUrl: (path, expiresIn, type) => files.getSignedUrl(path, type ?? 'get', { expiresIn }),
      overwrite: async (path, content, options) => {
        await files.upload(content, path, options);
      },
    };
    await convertLegacyQuestPlans({ storage, logger: console, now: new Date() });
  },

  // The files belong to their owners now, and the legacy rows are removed separately.
  down: async () => {},
};

export default migration;
