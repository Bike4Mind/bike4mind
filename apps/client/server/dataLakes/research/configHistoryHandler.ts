import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  lakeConfigChangeEventRepository,
  lakeMembershipChangeEventRepository,
  lakeConfigUndoClaimRepository,
  dataLakeResearchConfigRepository,
  fabFileRepository,
  userRepository,
  userApiKeyRepository,
} from '@bike4mind/database';
import type { AccessContext, LakeConfigHistoryView } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';

/** The config-history read shared by the SPA route and the public v1 route. */
export async function readLakeConfigHistory(
  lakeId: string,
  ctx: AccessContext,
  limit: number | undefined,
  includeFiles = false
): Promise<LakeConfigHistoryView> {
  const lake = await dataLakeService.assertLakeAccess(lakeId, ctx, {
    db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
  });

  const canManage = await dataLakeService.resolveCanManageLake(lake, ctx, {
    db: { dataLakeAccessGrants: dataLakeAccessGrantRepository },
  });
  if (!canManage) {
    throw new ForbiddenError('You must be able to manage this data lake to view its configuration history.');
  }

  return dataLakeService.assembleLakeConfigHistory(lake, {
    db: {
      lakeConfigChangeEvents: lakeConfigChangeEventRepository,
      lakeMembershipChangeEvents: lakeMembershipChangeEventRepository,
      users: userRepository,
      userApiKeys: userApiKeyRepository,
      lakeConfigUndoClaims: lakeConfigUndoClaimRepository,
      dataLakeResearchConfigs: dataLakeResearchConfigRepository,
      fabFiles: fabFileRepository,
    },
    limit,
    includeFiles,
    viewerUserId: ctx.userId,
  });
}
