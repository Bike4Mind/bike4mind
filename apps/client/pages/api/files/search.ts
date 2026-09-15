import { Permission } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { buildUserFileScope } from '@server/utils/userFileScope';
import { fabFilesService } from '@bike4mind/services';
import qs from 'qs';
import {
  adminSettingsRepository,
  FabFile,
  fabFileRepository,
  projectRepository,
  userRepository,
} from '@bike4mind/database';
import { getFilesStorage } from '@server/utils/storage';

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown>(async (req, res) => {
    if (!req.ability?.can(Permission.read, FabFile)) {
      throw new ForbiddenError('Unauthorized');
    }

    const parsed = qs.parse(req.query as Record<string, any>);
    const filters = (parsed.filters || {}) as Record<string, unknown>;
    // Bare Boolean() on purpose: the service parses these same two fields with
    // z.coerce.boolean(), which is Boolean(input) - so the string 'false' is TRUE there. Testing
    // for 'true' here instead would make the route and the query disagree about which view this
    // is, and the route would emit the default-view scope for a request the query then answers
    // from the shared-only branch.
    const isSharedView = Boolean(filters.shared);
    const isCuratedView = Boolean(filters.curated);

    // Include shared/data-lake files in the default view so total count reflects all files the
    // user can access, not just owned files. The shared and curated views carry their own
    // ownership predicate, so widening them would be wrong as well as pointless.
    const scope =
      !isSharedView && !isCuratedView ? { includeShared: true, ...buildUserFileScope(req.user) } : undefined;

    const result = await fabFilesService.search(
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
          generateSignedUrl: async (path: string, expireInSeconds: number) => {
            try {
              return await getFilesStorage().getSignedUrl(path, 'get', { expiresIn: expireInSeconds });
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

    return res.json(result);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
