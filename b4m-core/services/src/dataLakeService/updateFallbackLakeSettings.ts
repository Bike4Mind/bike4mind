import type {
  AccessContext,
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
  IDataLakeRepository,
  IFallbackLakeSetting,
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
    fallbackLakeSettings: Pick<IFallbackLakeSettingsRepository, 'setFields'>;
  };
}

/**
 * Update a static registry lake's admin-settable overlay (`groundingMode`, `preferredSystemPromptId`).
 * The session-activatable ALLOWLIST check on `preferredSystemPromptId` is enforced at the write
 * route (apps/client), same as `updateDataLake`'s - this service trusts whatever value already
 * cleared that gate, matching the schema's own comment on why core cannot host the check itself.
 *
 * The merged lake is returned by re-deriving from the overlay write rather than re-calling
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

  const fields: Partial<Pick<IFallbackLakeSetting, 'groundingMode' | 'preferredSystemPromptId'>> = {};
  if (params.groundingMode) fields.groundingMode = params.groundingMode;
  // '' is the deliberate clear sentinel (see the schema comment) and is a PROVIDED value, distinct
  // from an omitted field - `!== undefined`, not truthiness, is what tells setFields to touch it.
  if (params.preferredSystemPromptId !== undefined) fields.preferredSystemPromptId = params.preferredSystemPromptId;

  if (Object.keys(fields).length === 0) return lake;

  await db.fallbackLakeSettings.setFields(lake.id, fields);
  return {
    ...lake,
    ...(fields.groundingMode ? { groundingMode: fields.groundingMode } : {}),
    // Falsy (including the just-applied '' clear) reads as absent, matching how the list
    // projections and resolveFallbackLake's merge all treat "no preferred prompt".
    ...(fields.preferredSystemPromptId ? { preferredSystemPromptId: fields.preferredSystemPromptId } : {}),
  };
};
