import { adminSettingsRepository, dataLakeRepository } from '@bike4mind/database';
import { User } from '@bike4mind/database/auth';
import { FabFile } from '@bike4mind/database/content';
import { fabFilesService } from '@bike4mind/services';
import type { dataLakeService } from '@bike4mind/services';
import { getFilesStorage } from '@server/utils/storage';

/**
 * Binds the acquisition queue's approval step to the ORDINARY URL ingestion door (#1671): the same
 * `createFabFileByUrl` the Slack link path uses, with the same storage adapters, so an approved
 * proposal lands exactly where a manually-added link would and is picked up by the same S3
 * ObjectCreated -> chunk -> vectorize pipeline. This is the "no side doors" requirement made
 * concrete - there is deliberately no path that writes a FabFile from the proposal's stored excerpt.
 *
 * Mirrors `server/slack/dataLakeIngestDeps.ts`; any change to the storage wiring there belongs here
 * too. Un-transactioned for the same reason that path is: `createFabFileByUrl` performs the outbound
 * fetch itself, so a transaction would hold a Mongo session open across a network round trip (and
 * would re-fetch an attacker-chosen URL on each retry). `deleteCreatedFile` is the compensating
 * action that pays for the missing rollback.
 *
 * SSRF is enforced inside `fetchAndParseURL` (`validateUrlForFetch` on every redirect hop), which
 * matters here as much as it does for Slack: a proposal's URL originates from a producer, not from
 * the human who approves it.
 */
export function admitProposedSource(
  userId: string,
  params: dataLakeService.AdmitSourceParams
): Promise<dataLakeService.AdmittedFile> {
  return fabFilesService.createFabFileByUrl(
    userId,
    { url: params.url },
    {
      db: {
        adminSettings: adminSettingsRepository,
        fabFiles: FabFile,
        users: User,
        // Required by createFabFile's tag gate: the lake meta-tag we stamp is permission-bearing,
        // so it is gated at the create door as well as at the review gate.
        dataLakes: dataLakeRepository,
      },
      storage: {
        upload: async (filepath, content, option) => {
          await getFilesStorage().upload(content, filepath, {
            ContentType: option?.ContentType || 'text/plain',
            ContentLength: option?.ContentLength || Buffer.byteLength(content),
          });
          return filepath;
        },
        generateSignedUrl: (filepath, expireInSeconds, type: 'get' | 'put' = 'get') =>
          getFilesStorage().getSignedUrl(filepath, type, { expiresIn: expireInSeconds }),
      },
      tags: params.tags,
      provenance: params.provenance,
      deleteCreatedFile: (id: string) => FabFile.findByIdAndDelete(id),
    }
  );
}
