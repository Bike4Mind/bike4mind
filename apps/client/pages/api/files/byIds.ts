import { fabFileRepository } from '@bike4mind/database/content';
import { userRepository } from '@bike4mind/database/auth';
import { fabFilesService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { findLakeAccessibleFabFile } from '@server/dataLakes';
import { getFilesStorage } from '@server/utils/storage';
import { Request } from 'express';
import qs from 'qs';
import { adminSettingsRepository } from '@bike4mind/database/infra';
import type { IFabFileDocument } from '@bike4mind/common';

const handler = baseApi().get(async (req: Request<{}, {}, {}, { ids: string[] }>, res) => {
  const parsed = qs.parse(req.query as Record<string, any>) as { ids: string[] | Record<string, string> };

  // Next.js may parse ids[]=...&ids[]=... as an indexed object { '0': '...', '1': '...' }
  // instead of an array when there are many items. Normalize to ensure it's always an array.
  const ids = Array.isArray(parsed.ids) ? parsed.ids : Object.values(parsed.ids ?? {});

  const adapter = {
    db: { fabFiles: fabFileRepository, users: userRepository, adminSettings: adminSettingsRepository },
    storage: {
      generateSignedUrl: async (path: string, expireInSeconds: number) => {
        return await getFilesStorage().getSignedUrl(path, 'get', { expiresIn: expireInSeconds });
      },
    },
  };

  const results = await fabFilesService.listFabFiles(req.user, { ids }, adapter);

  // Fallback for the ids the ACL list dropped: data-lake files are authorized by lake
  // tag/prefix, NOT by per-file ACL, so a shared lake's articles (owned by their curator)
  // vanish from a bulk lookup even though the caller may read them. This is the byIds twin
  // of the single-file fallback in files/[id] (#836); without it, hydrating a session whose
  // knowledgeIds point at lake files zeroes the workbench for every non-owner.
  const found = new Set(results.map((f: IFabFileDocument) => f.id));
  const missing = ids.filter(id => !found.has(id));
  if (missing.length > 0) {
    const lakeFiles = await Promise.all(missing.map(id => findLakeAccessibleFabFile(req, id)));
    for (const lakeFile of lakeFiles) {
      if (!lakeFile) continue; // not lake-accessible either - stays omitted, as before
      results.push(await fabFilesService.generateSignedUrl(lakeFile, adapter));
    }
  }

  return res.json(results);
});

export default handler;
