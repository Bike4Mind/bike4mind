import { baseApi } from '@server/middlewares/baseApi';
import { FabFile, researchDataRepository } from '@bike4mind/database';

const handler = baseApi({ auth: true }).get(async (req, res) => {
  // TODO: Create service and support pagination
  // Both queries carry the ownership filter: ResearchData.userId is optional, so a legacy row
  // without one must not widen the FabFile lookup into another tenant's files.
  //
  // Deliberate partial: an org peer's research task can dedup onto the SAME FabFile (see
  // findByUrlAndOrganizationId in ResearchDataModel.ts), which this caller then also has a
  // ResearchData row pointing at. The bare userId filter below drops that row, since the file
  // itself is owned by the peer with no users[]/groups[] share entry -- correct under this
  // repo's ownership model, but silent. Not made access-aware (owner/shared/group union,
  // matching buildOwnershipConditions) here to avoid widening a security-fix PR's blast
  // radius; tracked as a follow-up rather than fixed in place.
  const userId = req.user.id;
  const researchData = await researchDataRepository.find({ userId });

  if (!researchData || researchData.length === 0) {
    return res.json([]);
  }

  const files = await FabFile.find({ _id: { $in: researchData.map(d => d.fabFileId) }, userId });

  return res.json(files);
});

export default handler;
