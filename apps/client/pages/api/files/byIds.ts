import { baseApi } from '@server/middlewares/baseApi';
import { FILES_READ_SCOPES } from '@server/files/fileScopes';
import { listFilesByIds } from '@server/files/listFilesByIds';
import { Request } from 'express';
import qs from 'qs';

// The id list is caller-controlled and every unmatched id costs DB work in the lake fallback
// (listFilesByIds), so it needs a bound. Matches METADATA_PAGE_CAP, the same ceiling FabFileModel puts on
// its byIds metadata fetches.
const MAX_IDS = 500;

// A lone `?ids=<id>` arrives as a scalar string; spreading it via Object.values yields one
// "id" per character, every one of which misses, so the route answered 200 [] for a readable file.
// qs may also yield an indexed object { '0': '...', '1': '...' } instead of an array for many items.
const toIdList = (raw: unknown): string[] => {
  if (typeof raw === 'string') return [raw];
  const values = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
  return values.filter((v): v is string => typeof v === 'string');
};

const handler = baseApi({ requiredScopes: FILES_READ_SCOPES }).get(
  async (req: Request<{}, {}, {}, { ids: string[] }>, res) => {
    const ids = toIdList(qs.parse(req.query as Record<string, any>).ids);

    if (ids.length > MAX_IDS) {
      return res.status(400).json({ message: `Too many ids (max ${MAX_IDS})` });
    }

    const results = await listFilesByIds(req, ids);

    return res.json(results);
  }
);

export default handler;
