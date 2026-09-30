import { baseApi } from '@server/middlewares/baseApi';
import { FabFile, researchDataRepository } from '@bike4mind/database';
import { usableObjectIds } from '@bike4mind/db-core';

const handler = baseApi({ auth: true }).get(async (req, res) => {
  // TODO: Create service and support pagination
  // Deliberate partial, and the reason both queries carry the ownership filter: ResearchData.userId
  // is optional, so a legacy row without one must not widen the FabFile lookup into another
  // tenant's files. Rows written before research dedup became owner-scoped can point at an org
  // peer's FabFile, and the bare userId filter drops those -- correct under this repo's ownership
  // model, and NOT to be "fixed" by widening the count below into a cross-tenant lookup. Making
  // this access-aware (owner/shared/group union, matching buildOwnershipConditions) is a follow-up.
  const userId = req.user.id;
  const researchData = await researchDataRepository.find({ userId });

  if (!researchData || researchData.length === 0) {
    return res.json([]);
  }

  // A legacy non-ObjectId fabFileId rejects the whole `_id.$in` cast with a CastError, which the
  // API error handler remaps to a 404 -- so the route would fail before reporting anything. Drop
  // and name those instead; they are counted on their own line, not as an owner-scoping drop.
  const referencedFileIds = usableObjectIds(
    researchData.map(({ fabFileId }) => fabFileId),
    'research-files',
    req.logger
  );
  // Hex-only after the guard above, so this is `canonicalId` (b4m-core/services/src/utils/objectIds.ts)
  // reduced to its hex arm. Mongo casts hex in either case to the same _id, but a resolved
  // document's `id` virtual is always canonical lowercase -- comparing raw stored strings would
  // report a file that WAS returned as omitted, and count a case-variant duplicate twice.
  const uniqueFileIds = [...new Set(referencedFileIds.map(fileId => fileId.toLowerCase()))];
  const files = await FabFile.find({ _id: { $in: uniqueFileIds }, userId });
  const accessibleFileIds = new Set(files.map(({ id }) => String(id).toLowerCase()));
  const droppedFileCount = uniqueFileIds.filter(fileId => !accessibleFileIds.has(fileId)).length;

  if (droppedFileCount > 0) {
    req.logger.warn('[research-files] Owner-scoped listing omitted referenced files', {
      droppedFileCount,
      referencedFileCount: uniqueFileIds.length,
    });
  }

  return res.json(files);
});

export default handler;
