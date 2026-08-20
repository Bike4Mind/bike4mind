import { adminSettingsRepository, dataLakeAccessGrantRepository, dataLakeRepository } from '@bike4mind/database';
import { User } from '@bike4mind/database/auth';
import { FabFile } from '@bike4mind/database/content';
import { fabFilesService } from '@bike4mind/services';
import type { dataLakeService } from '@bike4mind/services';
import type { AccessContext } from '@bike4mind/common';
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
 *
 * INVARIANT: this adapter's authorization inputs must stay at least as wide as the review route's.
 * `createFabFile` re-gates the lake tag, so anything the route's manage check honors and this `db`
 * omits becomes a reviewer who is authorized to approve but cannot complete an approval. Both the
 * grant repo and `administeredOrgIds` below exist for that reason; the same shape is still missing
 * on the Slack link door (`server/slack/dataLakeIngestDeps.ts`), which is a live gap there.
 */
export function admitProposedSource(
  actor: AccessContext,
  params: dataLakeService.AdmitSourceParams
): Promise<dataLakeService.AdmittedFile> {
  return fabFilesService.createFabFileByUrl(
    actor.userId,
    { url: params.url },
    {
      db: {
        adminSettings: adminSettingsRepository,
        fabFiles: FabFile,
        users: User,
        // Required by createFabFile's tag gate: the lake meta-tag we stamp is permission-bearing,
        // so it is gated at the create door as well as at the review gate.
        dataLakes: dataLakeRepository,
        // Load-bearing, not defensive: without it `loadActiveLakeGrants` returns [] and that same
        // tag gate loses the curator and grant-transferred-owner rungs. Since the review route in
        // front of this IS grant-aware, omitting it made the write gate strictly narrower than the
        // authorization gate - so a curator passed the 403, had the proposal claimed to `approved`,
        // and was then refused the admission with a message retrying could never fix.
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
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
      // The other half of the same problem: the grant repo restores the grant-derived rungs, but the
      // two ORG rungs need the actor's administered-org set, which `createFabFile` cannot derive from
      // a user document. Without this an org admin of the lake's org - the case that rung exists for,
      // so that org lakes survive their creator - is refused the write its role entitles it to.
      administeredOrgIds: actor.administeredOrgIds,
      deleteCreatedFile: (id: string) => FabFile.findByIdAndDelete(id),
    }
  );
}
