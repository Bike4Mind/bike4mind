import { fabFileRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { FILES_READ_SCOPES } from '@bike4mind/server-utils/files/fileScopes';

/** The generation models behind the caller's own files, for the Library's model filter. */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: FILES_READ_SCOPES }).get(async (req, res) => {
  const modelIds = await fabFileRepository.listGenerationModelIds(req.user.id);
  return res.json({ modelIds });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
