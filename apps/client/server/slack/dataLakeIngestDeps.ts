import { adminSettingsRepository, dataLakeRepository, fabFileRepository, withTransaction } from '@bike4mind/database';
import { User } from '@bike4mind/database/auth';
import { FabFile } from '@bike4mind/database/content';
import { fabFilesService } from '@bike4mind/services';
import { getUserEntitlements } from '@server/entitlements';
import { getFilesStorage } from '@server/utils/storage';
import type { DataLakeCommandRepo } from './handleDataLakeCommand';
import type { SlackLakeIngestDeps } from './dataLakeFileIngest';

/**
 * Bind the Slack data-lake ingest to the app's real repositories and storage. Kept out of
 * `events.ts` (which is already long) and out of the ingest module itself, so the ingest logic
 * stays free of wiring and unit-testable with plain fakes.
 *
 * The storage adapter mirrors `pages/api/files/createFabFile.ts` - the web single-file door - so
 * a Slack-ingested file lands in exactly the same place, with the same S3 ObjectCreated ->
 * chunk -> vectorize pipeline picking it up. Any change there must be mirrored here.
 */
export function buildSlackLakeIngestDeps(args: {
  downloadFile: (url: string, fileName: string) => Promise<Buffer>;
  logger: SlackLakeIngestDeps['logger'];
}): SlackLakeIngestDeps & { dataLakes: DataLakeCommandRepo } {
  return {
    dataLakes: dataLakeRepository,
    fabFiles: fabFileRepository,
    downloadFile: args.downloadFile,
    logger: args.logger,
    resolveEntitlementKeys: actor =>
      getUserEntitlements({
        id: actor.id,
        tags: actor.tags,
        isAdmin: actor.isAdmin,
        email: actor.email,
        emailVerified: actor.emailVerified,
      }),
    createLakeFile: (userId, params) =>
      withTransaction(async () =>
        fabFilesService.createFabFile(
          userId,
          {
            fileName: params.fileName,
            mimeType: params.mimeType,
            fileSize: params.fileSize,
            type: params.type,
            content: params.content,
            contentType: params.contentType,
            contentHash: params.contentHash,
            tags: params.tags,
            ...(params.organizationId && { organizationId: params.organizationId }),
          },
          {
            db: {
              adminSettings: adminSettingsRepository,
              fabFiles: FabFile,
              users: User,
            },
            storage: {
              upload: async (filepath, content, option) => {
                await getFilesStorage().upload(content, filepath, {
                  ContentType: option?.ContentType || 'text/plain',
                  ContentLength: option?.ContentLength || Buffer.byteLength(content),
                });
                return filepath;
              },
              // Thread `type` through rather than hardcoding 'put': createFabFile asks for 'get'
              // when it stores fileUrl, and a PUT URL parked there costs a wasted round-trip on
              // first read (get.ts test-fetches and regenerates). Mirrors researchEngineQueue.
              generateSignedUrl: (filepath: string, expireInSeconds: number, type = 'get') =>
                getFilesStorage().getSignedUrl(filepath, type, { expiresIn: expireInSeconds }),
            },
            // Server-supplied: the request body can never reach this, so a Slack origin stamp
            // cannot be forged by a caller who merely uploaded a file.
            provenance: params.provenance,
          }
        )
      ),
  };
}
