import { fabFileRepository } from '@bike4mind/database/content';
import { userRepository } from '@bike4mind/database/auth';
import { fabFilesService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { getFilesStorage } from '@server/utils/storage';
import { Request } from 'express';
import qs from 'qs';
import { adminSettingsRepository } from '@bike4mind/database/infra';

const handler = baseApi().get(async (req: Request<{}, {}, {}, { ids: string[] }>, res) => {
  const parsed = qs.parse(req.query as Record<string, any>) as { ids: string[] | Record<string, string> };

  // Next.js may parse ids[]=...&ids[]=... as an indexed object { '0': '...', '1': '...' }
  // instead of an array when there are many items. Normalize to ensure it's always an array.
  const ids = Array.isArray(parsed.ids) ? parsed.ids : Object.values(parsed.ids ?? {});

  const results = await fabFilesService.listFabFiles(
    req.user,
    { ids },
    {
      db: { fabFiles: fabFileRepository, users: userRepository, adminSettings: adminSettingsRepository },
      storage: {
        generateSignedUrl: async (path: string, expireInSeconds: number) => {
          return await getFilesStorage().getSignedUrl(path, 'get', { expiresIn: expireInSeconds });
        },
      },
    }
  );

  return res.json(results);
});

export default handler;
