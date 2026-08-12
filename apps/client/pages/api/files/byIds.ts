import { fabFileRepository } from '@bike4mind/database/content';
import { userRepository } from '@bike4mind/database/auth';
import { fabFilesService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { isFileInAccessibleLake, resolveAccessibleLakes } from '@server/dataLakes';
import { getFilesStorage } from '@server/utils/storage';
import { Request } from 'express';
import qs from 'qs';
import { adminSettingsRepository } from '@bike4mind/database/infra';
import type { IFabFileDocument } from '@bike4mind/common';

// The id list is caller-controlled and every unmatched id costs DB work in the lake fallback
// below, so it needs a bound. Matches METADATA_PAGE_CAP, the same ceiling FabFileModel puts on
// its byIds metadata fetches.
const MAX_IDS = 500;

const isObjectIdHex = (id: string) => /^[a-f0-9]{24}$/i.test(id);

const handler = baseApi().get(async (req: Request<{}, {}, {}, { ids: string[] }>, res) => {
  const parsed = qs.parse(req.query as Record<string, any>) as { ids: string[] | Record<string, string> };

  // Next.js may parse ids[]=...&ids[]=... as an indexed object { '0': '...', '1': '...' }
  // instead of an array when there are many items. Normalize to ensure it's always an array.
  const ids = Array.isArray(parsed.ids) ? parsed.ids : Object.values(parsed.ids ?? {});

  if (ids.length > MAX_IDS) {
    return res.status(400).json({ message: `Too many ids (max ${MAX_IDS})` });
  }

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
  //
  // The lakes are resolved ONCE and the candidates fetched in one $in query - a per-id
  // findLakeAccessibleFabFile would re-run lake resolution per miss, making bogus ids the
  // most expensive input the endpoint accepts.
  const found = new Set(results.map((f: IFabFileDocument) => f.id));
  const missing = ids.filter(id => isObjectIdHex(id) && !found.has(id));
  if (missing.length > 0) {
    const lakes = await resolveAccessibleLakes(req);
    if (lakes.length > 0) {
      const candidates: IFabFileDocument[] = await fabFileRepository.findAllInIds(missing);
      const accessible = candidates.filter(file => !file.deletedAt && isFileInAccessibleLake(lakes, file));
      results.push(...(await Promise.all(accessible.map(file => fabFilesService.generateSignedUrl(file, adapter)))));
    }
  }

  return res.json(results);
});

export default handler;
