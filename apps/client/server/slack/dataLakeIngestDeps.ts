import {
  adminSettingsRepository,
  scopedSettingsRepository,
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  organizationRepository,
  withTransaction,
} from '@bike4mind/database';
import { User } from '@bike4mind/database/auth';
import { FabFile } from '@bike4mind/database/content';
import { fabFilesService } from '@bike4mind/services';
import { getUserEntitlements } from '@server/entitlements';
import { getFilesStorage } from '@server/utils/storage';
import type { DataLakeCommandRepo } from './handleDataLakeCommand';
import type { SlackLakeIngestDeps } from './dataLakeFileIngest';
import type { SlackLinkIngestDeps } from './dataLakeLinkIngest';

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
}): SlackLakeIngestDeps & SlackLinkIngestDeps & { dataLakes: DataLakeCommandRepo } {
  // Shared by the attachment and link paths so a Slack-ingested file lands identically however it
  // arrived. Declared once rather than per-call: two copies is how the two paths would drift.
  const db = {
    adminSettings: adminSettingsRepository,
    fabFiles: FabFile,
    users: User,
    // Required by createFabFile's tag gate (assertCanWriteDataLakeTags +
    // assertCanWriteStaticRegistryTags), which every caller now passes through. Declared on the
    // shared adapter so BOTH the attachment and link paths are gated - a link path that quietly
    // skipped it would be a tag-write hole, since this PR is what gives that path caller-set tags.
    dataLakes: dataLakeRepository,
    // GATE 4 (found live, #2034): `createFabFile`'s own tag gate re-resolves manage from THIS `db`,
    // not from the caller's already-authorized ctx. Absent, `resolveCanManageLake` there degrades to
    // createdByUserId + org rungs only (`CreateFabFileAdapters.db.dataLakeAccessGrants`'s own
    // comment names this exact case: "NOT... adequate... where the reviewer may be a curator or a
    // grant-transferred owner" - the Slack `add` door is exactly that shape) - so a curator grantee
    // passed both prologue gates and was refused here with "You do not have permission to change
    // this data lake's files", identical wording to gate 3's `administeredOrgIds` omission but a
    // different missing field. Mirrors `proposalAdmissionDeps.ts`'s wiring.
    dataLakeAccessGrants: dataLakeAccessGrantRepository,
    // Scoped-override store for the admission contract's enforcement lever (#1680); without it the
    // lever would resolve platform-only and a per-lake enforcement setting would silently do
    // nothing on the Slack door.
    scopedSettings: scopedSettingsRepository,
  };
  const storage = {
    upload: async (
      filepath: string,
      content: string | Buffer,
      option?: { ContentType?: string; ContentLength?: number }
    ) => {
      await getFilesStorage().upload(content, filepath, {
        ContentType: option?.ContentType || 'text/plain',
        ContentLength: option?.ContentLength || Buffer.byteLength(content),
      });
      return filepath;
    },
    // Thread `type` through rather than hardcoding 'put': createFabFile asks for 'get'
    // when it stores fileUrl, and a PUT URL parked there costs a wasted round-trip on
    // first read (get.ts test-fetches and regenerates). Mirrors researchEngineQueue.
    generateSignedUrl: (filepath: string, expireInSeconds: number, type: 'get' | 'put' = 'get') =>
      getFilesStorage().getSignedUrl(filepath, type, { expiresIn: expireInSeconds }),
  };

  return {
    dataLakes: dataLakeRepository,
    dataLakeAccessGrants: dataLakeAccessGrantRepository,
    adminSettings: adminSettingsRepository,
    fabFiles: fabFileRepository,
    downloadFile: args.downloadFile,
    logger: args.logger,
    // Same setting createFabFile enforces post-download, read here so an over-limit file is
    // refused before the transfer. Stored in MB; undefined leaves the Slack ceiling as the only
    // pre-download bound.
    resolveMaxFileSizeBytes: async () => {
      const mb = await adminSettingsRepository.getSettingsValue('MaxFileSize');
      // `>= 0`, not `> 0`: an admin-set 0 must mean "refuse everything" here because that is what
      // create.ts does with it (`fileSize >= 0` is always true). Collapsing it into undefined
      // would read as "no limit" and hand the pre-check the opposite of the configured intent.
      return typeof mb === 'number' && mb >= 0 ? mb * 1024 * 1024 : undefined;
    },
    resolveEntitlementKeys: actor =>
      getUserEntitlements({
        id: actor.id,
        tags: actor.tags,
        isAdmin: actor.isAdmin,
        email: actor.email,
        emailVerified: actor.emailVerified,
      }),
    resolveMembershipOrgIds: userId => organizationRepository.findMembershipOrgIds(userId),
    resolveAdministeredOrgIds: userId => organizationRepository.findIdsWithAdminRights(userId),
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
          },
          {
            db,
            storage,
            // Server-supplied: the request body can never reach this, so a Slack origin stamp
            // cannot be forged by a caller who merely uploaded a file.
            provenance: params.provenance,
            // createFabFile runs its OWN tag gate and cannot derive this from the user document, so
            // omitting it zeroes canManageLake's org rungs and refuses the write the prologue just
            // authorized. Resolved once by the prologue and carried on the params - never
            // re-resolved here, so the create re-checks against the value that granted the write.
            administeredOrgIds: params.administeredOrgIds,
          }
        )
      ),
    // LINK ingest. `tags` and `provenance` are adapters on this service too, for the same reason:
    // both are server-only facts, and a lake meta-tag is permission-bearing.
    //
    // NOT wrapped in `withTransaction`, unlike `createLakeFile` above, and the asymmetry is
    // deliberate: `createFabFileByUrl` performs the outbound HTTP fetch ITSELF, so a transaction
    // here would hold a Mongo session open across a network round trip. Two concrete failures come
    // with that - `withTransaction` retries transient errors up to two extra attempts, so an
    // attacker-chosen URL would be fetched up to three times; and a slow or redirecting URL can
    // approach MongoDB's default 60s transactionLifetimeLimitSeconds and abort AFTER the bytes were
    // already transferred. The file path keeps its transaction because the download happens outside
    // it, so only DB work is inside. (`pages/api/files/createFabFileURL.ts` still has the wrapped
    // shape; it predates this and is a single hop, so it is left alone rather than widening this
    // change into the web door.)
    //
    // Losing the transaction does cost something, and `deleteCreatedFile` is what pays for it: the
    // service creates the row and THEN uploads the object, so without a rollback an upload failure
    // would strand a FabFile whose S3 object never arrives - and since chunk/vectorize is driven by
    // the ObjectCreated event, that row would be listed but never indexable. This is the
    // compensating action that a transaction would otherwise have given us for free.
    createLakeFileFromUrl: (userId, params) =>
      fabFilesService.createFabFileByUrl(
        userId,
        { url: params.url },
        {
          db,
          storage,
          tags: params.tags,
          provenance: params.provenance,
          // Relayed to createFabFile's tag gate (createByUrl.ts:108) for the same reason as the
          // file adapter above; FILE and LINK must not diverge on who is allowed to write.
          administeredOrgIds: params.administeredOrgIds,
          deleteCreatedFile: (id: string) => FabFile.findByIdAndDelete(id),
        }
      ),
  };
}
