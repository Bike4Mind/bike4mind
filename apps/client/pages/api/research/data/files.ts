import { baseApi } from '@server/middlewares/baseApi';
import { FabFile, researchDataRepository } from '@bike4mind/database';

const handler = baseApi({ auth: true }).get(async (req, res) => {
  // TODO: Create service and support pagination
  const userId = req.user.id;
  const researchData = await researchDataRepository.find({ userId });

  if (!researchData || researchData.length === 0) {
    return res.json([]);
  }

  const referencedFileIds = [...new Set(researchData.map(({ fabFileId }) => fabFileId))];
  const files = await FabFile.find({ _id: { $in: referencedFileIds }, userId });
  const accessibleFileIds = new Set(files.map(({ id }) => id));
  const droppedFileCount = referencedFileIds.filter(fileId => !accessibleFileIds.has(fileId)).length;

  if (droppedFileCount > 0) {
    req.logger.warn('[research-files] Owner-scoped listing omitted referenced files', {
      droppedFileCount,
      referencedFileCount: referencedFileIds.length,
    });
  }

  return res.json(files);
});

export default handler;
