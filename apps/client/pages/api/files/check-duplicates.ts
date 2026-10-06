import { baseApi } from '@server/middlewares/baseApi';
import { fabFileRepository } from '@bike4mind/database';
import { CheckDuplicatesRequestInput } from '@bike4mind/common';
import { FILES_READ_SCOPES } from '@server/files/fileScopes';
import { Request } from 'express';

const handler = baseApi({ requiredScopes: FILES_READ_SCOPES }).post(async (req: Request, res) => {
  const userId = req.user.id;
  const { hashes } = CheckDuplicatesRequestInput.parse(req.body);

  const matchingFiles = await fabFileRepository.findByContentHashes(userId, hashes);

  const duplicates = matchingFiles.map(file => ({
    hash: file.contentHash!,
    fileId: file.id,
    fileName: file.fileName,
  }));

  return res.json({ duplicates });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
