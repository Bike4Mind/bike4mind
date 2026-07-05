import { baseApi } from '@server/middlewares/baseApi';
import { FabFile, researchDataRepository } from '@bike4mind/database';

const handler = baseApi({ auth: true }).get(async (req, res) => {
  // TODO: Create service and support pagination
  const researchData = await researchDataRepository.find({});

  if (!researchData || researchData.length === 0) {
    return res.json([]);
  }

  const files = await FabFile.find({ _id: { $in: researchData.map(d => d.fabFileId) } });

  return res.json(files);
});

export default handler;
