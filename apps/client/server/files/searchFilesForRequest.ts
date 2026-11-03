import { Permission } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { buildRequestFileScope } from '@server/utils/userFileScope';
import { fabFilesService } from '@bike4mind/services';
import {
  adminSettingsRepository,
  FabFile,
  fabFileRepository,
  projectRepository,
  userRepository,
} from '@bike4mind/database';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import type { Request } from 'express';

/**
 * Runs the file search for the caller with the server-built visibility scope, and returns the
 * service's result with every file signed. `parsed` is the already-parsed search params.
 *
 * Shared by the SPA-internal GET /api/files/search and the public GET /api/v1/files/search, so the
 * two doors cannot scope differently.
 */
export async function searchFilesForRequest<Params, ResBody, ReqBody, Query>(
  req: Request<Params, ResBody, ReqBody, Query>,
  parsed: Parameters<typeof fabFilesService.search>[1]
) {
  if (!req.ability?.can(Permission.read, FabFile)) {
    throw new ForbiddenError('Unauthorized');
  }

  const filters = (parsed.filters || {}) as Record<string, unknown>;
  // Bare Boolean() on purpose: the service parses these same two fields with
  // z.coerce.boolean(), which is Boolean(input) - so the string 'false' is TRUE there. Testing
  // for 'true' here instead would make the route and the query disagree about which view this
  // is, and the route would emit the default-view scope for a request the query then answers
  // from the shared-only branch.
  const isSharedView = Boolean(filters.shared);
  const isCuratedView = Boolean(filters.curated);
  // Strict, matching the service's own parse of `owned`: the string 'false' must not narrow the list.
  const isOwnedView = filters.owned === true || filters.owned === 'true';

  // Include shared/data-lake files in the default view so total count reflects all files the
  // user can access, not just owned files. The shared and curated views carry their own
  // ownership predicate, so widening them would be wrong as well as pointless. The owned view asks
  // for exactly the unwidened list.
  const scope =
    !isSharedView && !isCuratedView && !isOwnedView
      ? { includeShared: true, ...buildRequestFileScope(req, req.user) }
      : undefined;

  return fabFilesService.search(
    req.user.id,
    parsed,
    {
      db: {
        fabFiles: fabFileRepository,
        users: userRepository,
        projects: projectRepository,
        adminSettings: adminSettingsRepository,
      },
      storage: {
        ...(process.env.S3_PRESIGN_ENDPOINT?.trim() && { signedUrlCache: 'bypass' as const }),
        generateSignedUrl: async (path: string, expireInSeconds: number) => {
          try {
            return await getFilesStorage().getSignedUrl(path, 'get', {
              expiresIn: expireInSeconds,
              audience: 'browser',
            });
          } catch (e) {
            req.logger.error('Error generating signed URL for file', {
              error: e,
              filePath: path,
              userId: req.user.id,
            });
            return null;
          }
        },
      },
    },
    scope
  );
}
