import { baseApi } from '@server/middlewares/baseApi';
import { FabFile, researchDataRepository } from '@bike4mind/database';

const handler = baseApi({ auth: true }).get(async (req, res) => {
  // TODO: Create service and support pagination
  // Both queries carry the ownership filter: ResearchData.userId is optional, so a legacy row
  // without one must not widen the FabFile lookup into another tenant's files.
  const userId = req.user.id;
  const researchData = await researchDataRepository.find({ userId });

  if (!researchData || researchData.length === 0) {
    return res.json([]);
  }

  const files = await FabFile.find({ _id: { $in: researchData.map(d => d.fabFileId) }, userId });

  return res.json(files);
});

export default handler;
