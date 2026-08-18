import type {
  AccessContext,
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
  IDataLakeRepository,
  IFallbackLakeSettingsRepository,
} from '@bike4mind/common';
import { UpdateFallbackLakeSettingsRequestInput } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import type { z } from 'zod';
import { assertFallbackLakeSettingsWriteAccess } from './authorizeLakeWrite';

type UpdateFallbackLakeSettingsParams = z.infer<typeof UpdateFallbackLakeSettingsRequestInput>;

interface UpdateFallbackLakeSettingsAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'findBySlug'>;
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
    fallbackLakeSettings: Pick<IFallbackLakeSettingsRepository, 'setGroundingMode'>;
  };
}

/**
 * Update a static registry lake's admin-settable overlay (`groundingMode` only, for now). The
 * merged lake is returned by re-deriving from the overlay write rather than re-calling
 * `assertLakeAccess`, so the response reflects exactly what was just persisted even if a caller
 * hasn't wired `fallbackLakeSettings` into their own read path.
 */
export const updateFallbackLakeSettings = async (
  lakeIdOrSlug: string,
  ctx: AccessContext,
  parameters: UpdateFallbackLakeSettingsParams,
  { db }: UpdateFallbackLakeSettingsAdapters
): Promise<IDataLakeDocument> => {
  const params = secureParameters(parameters, UpdateFallbackLakeSettingsRequestInput);
  const lake = await assertFallbackLakeSettingsWriteAccess(lakeIdOrSlug, ctx, { db });

  if (!params.groundingMode) return lake;

  await db.fallbackLakeSettings.setGroundingMode(lake.id, params.groundingMode);
  return { ...lake, groundingMode: params.groundingMode };
};
