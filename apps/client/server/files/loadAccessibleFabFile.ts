import {
  adminSettingsRepository,
  fabFileRepository,
  lakeAccessEventRepository,
  userRepository,
} from '@bike4mind/database';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import { NotFoundError } from '@bike4mind/utils';
import { normalizeId } from '@bike4mind/utils/normalizeId';
import { grantingLakes, resolveAccessibleLakes } from '@server/dataLakes';
import { holdsDataLakeReadScope } from '@server/dataLakes/dataLakeScopes';
import { resolveAuditPrincipal } from '@bike4mind/server-utils/dataLakes/resolveAuditPrincipal';
import type { EntitlementRequest } from '@server/entitlements';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import type { Logger } from '@bike4mind/observability';

/**
 * The authenticated-request slice these file read doors need. Any Express.Request is assignable
 * to it, and a caller with no HTTP request (the decisions runner behind a tool call) can build one,
 * which is what keeps this ACL off the Express request. The three memo fields are the per-request
 * caches `resolveAccessibleLakes` writes - forwarded so a batched caller reuses its lookups.
 */
export type FabFileAccessRequest = Omit<EntitlementRequest, 'apiKeyInfo'> & {
  apiKeyInfo?: Pick<Express.ApiKeyInfo, 'keyId' | 'scopes'>;
  logger: Logger;
};

/** Storage and repository adapter shared by the file read doors. */
export function buildFabFileAdapter(req: FabFileAccessRequest) {
  // Browser URLs only differ from private ones when S3_PRESIGN_ENDPOINT is set (see S3Storage), and only
  // then must they stay out of the shared URL cache. Without it the cached URL is valid for every reader.
  const browserSigningIsDistinct = Boolean(process.env.S3_PRESIGN_ENDPOINT?.trim());
  return {
    db: {
      fabFiles: fabFileRepository,
      users: userRepository,
      adminSettings: adminSettingsRepository,
    },
    storage: {
      ...(browserSigningIsDistinct && { signedUrlCache: 'bypass' as const }),
      generateSignedUrl: async (path: string, expireInSeconds: number) => {
        try {
          return await getFilesStorage().getSignedUrl(path, 'get', { expiresIn: expireInSeconds, audience: 'browser' });
        } catch (error) {
          req.logger.error('Error generating signed URL:', { error, path });
          throw error;
        }
      },
    },
  };
}

/**
 * Loads one FabFile the caller may read, with a fresh signed `fileUrl` when it is serveable
 * (withheld by moderation otherwise - see fabFileService's generateSignedUrl). Throws
 * NotFoundError when neither the per-file ACL nor any accessible data lake grants it.
 *
 * Shared by the SPA-internal `GET /api/files/{id}` and the public `GET /api/v1/files/{id}`, so
 * the two doors cannot authorize differently.
 */
export async function loadAccessibleFabFile(req: FabFileAccessRequest, id: string) {
  const adapter = buildFabFileAdapter(req);
  const { user } = req;
  // Every door here is authenticated; a caller that built the slice without a user is a wiring bug.
  if (!user) throw new NotFoundError('Fabfile not found');

  try {
    return await fabFilesService.getFabFile(user.id, { id }, adapter);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    // The same lake read through /api/data-lakes/articles needs datalake:read, so a key scoped to
    // files alone must not reach lake files through this fallback. JWT callers are unaffected.
    if (!holdsDataLakeReadScope(req)) throw error;
    // Fallback: data-lake files are authorized by lake tag/prefix, NOT by per-file ACL.
    // Curated/shared lake articles (e.g. OptiHashi's opti-knowledge) are owned by a curator,
    // so getFabFile 404s for entitled non-owner users. Re-authorize via the SAME lake gate the
    // browse endpoints use and, if granted, mint a fresh signed URL through the same path so
    // the shared file viewer (KnowledgeModal) can render it. (#836)
    const lakes = await resolveAccessibleLakes(req);
    // Fetched directly and checked against the already-resolved `lakes` rather than a per-id
    // helper that would re-run resolveAccessibleLakes's own DB read - the same one-resolve,
    // reuse-everywhere shape as files/byIds.ts's lake fallback.
    const candidate = lakes.length > 0 ? await fabFileRepository.findById(id) : null;
    // The SAME computation grants access and names the grantor, so an open-prefix match (no
    // tag to reverse) attributes to the specific lake whose prefix matched rather than falling
    // back to every accessible lake - a false row in an immutable, 450-day-floor audit trail is
    // worse than a missing one.
    const grantors =
      candidate && !candidate.deletedAt ? grantingLakes(lakes, candidate.tags?.map(t => t.name) ?? []) : [];
    // No accessible lake serves this id either - never an audit-worthy read, so nothing is
    // recorded; preserve the original 404 exactly as getFabFile raised it.
    if (!candidate || grantors.length === 0) throw error;
    const fabFile = await fabFilesService.generateSignedUrl(candidate, adapter);
    // Best-effort audit write - this is the same single-file metadata + URL read as the
    // articles `?id=` deep link, just reached through the direct-fetch fallback door instead.
    // Awaited (never rethrows): a per-request serverless route must not race a post-response
    // freeze of the execution environment.
    await dataLakeService.recordLakeAccessEvent(
      lakeAccessEventRepository,
      {
        ...resolveAuditPrincipal(user, req.apiKeyInfo),
        organizationId: normalizeId(user.organizationId),
        resolvedLakeIds: grantors.map(lake => lake.id),
        fileIds: [candidate.id],
        surface: 'data-lake-file-fallback',
      },
      req.logger,
      adminSettingsRepository
    );
    return fabFile;
  }
}
