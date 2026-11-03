import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { searchFilesForRequest } from '@server/files/searchFilesForRequest';
import qs from 'qs';
import { FILES_READ_SCOPES } from '@server/files/fileScopes';

const handler = baseApi({ requiredScopes: FILES_READ_SCOPES }).get(
  asyncHandler<{}, unknown, unknown>(async (req, res) => {
    const parsed = qs.parse(req.query as Record<string, any>);

    const result = await searchFilesForRequest(req, parsed);

    return res.json(result);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
