import {
  adminSettingsRepository,
  fabFileRepository,
  lakeAccessEventRepository,
  userRepository,
} from '@bike4mind/database';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import { NotFoundError } from '@bike4mind/utils';
import { normalizeId } from '@bike4mind/utils/normalizeId';
import { adminBypassLakeIds, grantingLakes, resolveAccessibleLakes } from '@server/dataLakes';
import { holdsDataLakeReadScope } from '@server/dataLakes/dataLakeScopes';
import { resolveAuditPrincipal } from '@bike4mind/server-utils/dataLakes/resolveAuditPrincipal';
import type { EntitlementRequest } from '@bike4mind/server-utils/entitlements/index';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { fileContentUrl } from '@server/files/browserFileSigner';
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

/**
 * Storage and repository adapter shared by the file read doors. `browser` hands out the stable app
 * URL (browserFileSigner.ts) instead of a raw S3 link; leave it off where a server or API client reads `fileUrl`.
 */
export function buildFabFileAdapter(req: FabFileAccessRequest, { browser = false }: { browser?: boolean } = {}) {
  return {
    db: {
      fabFiles: fabFileRepository,
      users: userRepository,
      adminSettings: adminSettingsRepository,
    },
    storage: {
      generateSignedUrl: async (path: string, expireInSeconds: number, options?: { signingDate?: Date }) => {
        try {
          return await getFilesStorage().getSignedUrl(path, 'get', {
            expiresIn: expireInSeconds,
            audience: 'browser',
            signingDate: options?.signingDate,
          });
        } catch (error) {
          req.logger.error('Error generating signed URL:', { error, path });
          throw error;
        }
      },
      ...(browser && { contentUrl: fileContentUrl }),
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
export async function loadAccessibleFabFile(
  req: FabFileAccessRequest,
  id: string,
  options: { browser?: boolean } = {}
) {
  const adapter = buildFabFileAdapter(req, options);
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
    const resolvedLakeIds = grantors.map(lake => lake.id);
    const bypass = await adminBypassLakeIds(req, resolvedLakeIds);
    // Same single-file read as the articles `?id=` deep link, via the direct-fetch fallback;
    // strict for an admin-bypass read.
    await dataLakeService.recordLakeAccessEvent(
      lakeAccessEventRepository,
      {
        ...resolveAuditPrincipal(user, req.apiKeyInfo),
        organizationId: normalizeId(user.organizationId),
        resolvedLakeIds,
        fileIds: [candidate.id],
        ...(bypass.length ? { adminBypassLakeIds: bypass } : {}),
        surface: 'data-lake-file-fallback',
      },
      req.logger,
      adminSettingsRepository
    );
    return fabFile;
  }
}
