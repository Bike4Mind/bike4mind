import type { AccessContext, IDataLakeDocument, IDataLakeFindingDocument } from '@bike4mind/common';
import { dataLakeAccessGrantRepository, dataLakeFindingRepository, dataLakeRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { NotFoundError } from '@bike4mind/utils';
import type { Request } from 'express';
import { assertDataLakeWriteScope } from './dataLakeScopes';
import { toAccessContext } from './toAccessContext';

/**
 * Authorize a caller to WRITE against one finding, and hand back the finding with the lake it
 * belongs to. The single front door for `POST /api/data-lakes/:id/findings/:findingId` and its
 * `/belief` sibling, which asked the same four questions in the same order.
 *
 * BELONGS-TO-LAKE IS THE HALF THAT IS EASY TO DROP, and it is the half that matters: the gate above
 * it authorizes a LAKE, so without the cross-lake check a caller who manages one lake could reach
 * any finding id in the database by quoting their own lake in the URL. Not-found rather than
 * forbidden, so the refusal leaks nothing about findings in lakes the caller cannot see. Extracted
 * because two copies of an authorization sequence drift silently - the second door would still
 * answer 200 while having stopped asking.
 *
 * Note this returns the finding by id ALONE (having checked its lake), so a caller that mutates it
 * must still carry `lake.id` as a filter term on the write: this read decides the status code, the
 * filter is what refuses the write. See the resolve route for why both exist.
 */
export async function loadFindingForLake(
  req: Request,
  params: { lakeId: string; findingId: string }
): Promise<{ lake: IDataLakeDocument; finding: IDataLakeFindingDocument; ctx: AccessContext }> {
  assertDataLakeWriteScope(req);
  const ctx = await toAccessContext(req);

  const lake = await dataLakeService.assertLakeWriteAccess(params.lakeId, ctx, {
    db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
  });

  const finding = await dataLakeFindingRepository.findById(params.findingId);
  if (!finding || finding.lakeId !== lake.id) throw new NotFoundError('Finding not found');

  return { lake, finding, ctx };
}
