/**
 * GET /api/v1/files/by-ids - read several files back at once. The public twin of GET
 * /api/files/byIds; authorization is shared through `listFilesByIds`, and this handler only maps the
 * published snake_case shape.
 */

import { MAX_FILE_IDS_PER_REQUEST, getFilesByIdsContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { listFilesByIds } from '@server/files/listFilesByIds';
import { toPublicFile } from '@server/files/toPublicFile';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { UnprocessableEntityError } from '@bike4mind/server-utils/utils/errors';

const handler = nextRouteForContract(getFilesByIdsContract, {
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/files/by-ids'),
}).get(async (req, res) => {
  const requested = [
    ...new Set(
      req.validatedQuery.ids
        .split(',')
        .map(id => id.trim())
        .filter(Boolean)
    ),
  ];
  if (requested.length === 0 || requested.length > MAX_FILE_IDS_PER_REQUEST) {
    throw new UnprocessableEntityError(`ids must list between 1 and ${MAX_FILE_IDS_PER_REQUEST} file ids`);
  }

  // A malformed id is simply absent from the answer, as one that does not exist: it never reaches a
  // query that would cast it.
  const valid = requested.filter(isValidObjectId);
  const files = valid.length > 0 ? await listFilesByIds(req, valid) : [];

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ files: files.map(toPublicFile) });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
