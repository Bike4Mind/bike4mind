import { Permission, getDataLakeTags } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
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

const handler = baseApi()
  .get(
    asyncHandler<{}, unknown, unknown>(async (req, res) => {
      if (!req.ability?.can(Permission.read, FabFile)) {
        throw new ForbiddenError('Unauthorized');
      }

      const parsed = qs.parse(req.query as Record<string, any>);
      const filters = (parsed.filters || {}) as Record<string, unknown>;
      const isSharedView = filters.shared === 'true' || filters.shared === true;
      const isCuratedView = filters.curated === 'true' || filters.curated === true;

      // Include shared/data-lake files in the default view so total count
      // reflects all files the user can access, not just owned files.
      if (!isSharedView && !isCuratedView) {
        if (!parsed.options || typeof parsed.options !== 'object') {
          parsed.options = {};
        }
        (parsed.options as Record<string, unknown>).includeShared = true;
        (parsed.options as Record<string, unknown>).userGroups = req.user.groups ?? [];
        (parsed.options as Record<string, unknown>).dataLakeTags = getDataLakeTags(req.user.tags ?? []);
      }

      const result = await fabFilesService.search(req.user.id, parsed, {
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
      });

      return res.json(result);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
