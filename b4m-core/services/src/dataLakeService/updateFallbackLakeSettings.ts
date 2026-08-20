import type {
  AccessContext,
  IDataLake,
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
import { diffLakeConfig } from './diffLakeConfig';
import { recordLakeConfigChange, type LakeConfigAuditAdapters } from './recordLakeConfigChange';

type UpdateFallbackLakeSettingsParams = z.infer<typeof UpdateFallbackLakeSettingsRequestInput>;

interface UpdateFallbackLakeSettingsAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'findBySlug'>;
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
    /**
     * `findByLakeId` is REQUIRED here, unlike everywhere else this repo is consumed, and it is the
     * audit that makes it so: `assertLakeAccess` merges the CURRENT overlay onto the synthetic lake
     * only when it is wired, and that merged lake is the `before` side of the config diff below.
     * Wired optionally, every field would read as unset -> value on every write and the history
     * would record a first-time set each time an admin edited the same prompt.
     */
    fallbackLakeSettings: Pick<IFallbackLakeSettingsRepository, 'setFields' | 'findByLakeId'>;
  } & LakeConfigAuditAdapters['db'];
  logger?: LakeConfigAuditAdapters['logger'];
}

/**
 * Update a static registry lake's admin-settable overlay (`groundingMode`, `preferredSystemPromptId`,
 * `systemPrompt`). The session-activatable ALLOWLIST check on `preferredSystemPromptId` is enforced
 * at the write route (apps/client), same as `updateDataLake`'s - this service trusts whatever value
 * already cleared that gate, matching the schema's own comment on why core cannot host the check
 * itself. `systemPrompt` carries no such write-time gate: whether it is ever INJECTED is decided at
 * read time by `isTrustedForInjection` (org-scoped registry lakes only), not here - this service
 * stores whatever a `canManageSettings` admin sets, unconditionally.
 *
 * AUDITED (#1769), on the same terms as `updateDataLake`: a registry lake's config write changes
 * how that lake answers for every reader of it, which is exactly what the config-change trail
 * exists to make visible - and here the actor is ALWAYS a platform admin acting on a lake nobody
 * owns, the case the `manageRung` field was added to surface as such.
 *
 * The merged lake is returned by re-deriving from the overlay write rather than re-calling
 * `assertLakeAccess`, so the response reflects exactly what was just persisted even if a caller
 * hasn't wired `fallbackLakeSettings` into their own read path.
 */
export const updateFallbackLakeSettings = async (
  lakeIdOrSlug: string,
  ctx: AccessContext,
  parameters: UpdateFallbackLakeSettingsParams,
  { db, logger }: UpdateFallbackLakeSettingsAdapters
): Promise<IDataLakeDocument> => {
  const params = secureParameters(parameters, UpdateFallbackLakeSettingsRequestInput);
  // Carries the CURRENT overlay values merged in (see the adapter's findByLakeId note), so this is
  // both the authorization result and the `before` side of the audit diff.
  const lake = await assertFallbackLakeSettingsWriteAccess(lakeIdOrSlug, ctx, { db });

  const fields: Partial<Pick<IFallbackLakeSetting, 'groundingMode' | 'preferredSystemPromptId' | 'systemPrompt'>> = {};
  if (params.groundingMode) fields.groundingMode = params.groundingMode;
  // '' is the deliberate clear sentinel (see the schema comment) and is a PROVIDED value, distinct
  // from an omitted field - `!== undefined`, not truthiness, is what tells setFields to touch it.
  if (params.preferredSystemPromptId !== undefined) fields.preferredSystemPromptId = params.preferredSystemPromptId;
  // Same `!== undefined` reasoning: an omitted field means unchanged, and a blank/whitespace-only
  // value is a deliberate clear (mirrors toManageableConfig's blank-as-absent read, not a write-time
  // no-op) - the client is expected to send '' explicitly to clear, same as it does for a DB lake.
  if (params.systemPrompt !== undefined) fields.systemPrompt = params.systemPrompt;

  if (Object.keys(fields).length === 0) return lake;

  await db.fallbackLakeSettings.setFields(lake.id, fields);

  // Bounded to the keys this caller supplied, exactly as updateDataLake projects its own write:
  // spreading `fields` wholesale would let a key present with an `undefined` value overwrite the
  // stored one and read as a deliberate clear. `recordLakeConfigChange` records nothing when the
  // diff is empty, so a write that moved no value needs no guard here.
  const projected: Partial<IDataLake> = { ...(lake as Partial<IDataLake>) };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (projected as Record<string, unknown>)[key] = value;
  }

  await recordLakeConfigChange(
    {
      actor: ctx,
      lake,
      // No grants: a fallback lake can never hold one (assertLakeGrantable refuses), so there is
      // nothing for the resolver to read even if it were consulted - which it is not, given the
      // explicit rung below.
      action: 'update',
      changes: diffLakeConfig(lake as Partial<IDataLake>, projected),
      // No `manageRung` override, deliberately. This route's gate is `ctx.isAdmin` directly (see
      // assertFallbackLakeSettingsWriteAccess), and `resolveLakeManageRung`'s FIRST arm is
      // `isAdmin -> 'platform-admin'`, so it already returns the one rung that can ever authorize
      // this call. Hardcoding it would be redundant today and a LIE tomorrow: were the gate ever
      // widened, the resolver would name the new rung while a literal kept reporting an admin who
      // was not involved - and the rung is an authorization fact, not a label (see the override's
      // own doc comment).
    },
    { db, logger }
  );

  return {
    ...lake,
    ...(fields.groundingMode ? { groundingMode: fields.groundingMode } : {}),
    // Falsy (including the just-applied '' clear) reads as absent, matching how the list
    // projections and resolveFallbackLake's merge all treat "no preferred prompt".
    ...(fields.preferredSystemPromptId ? { preferredSystemPromptId: fields.preferredSystemPromptId } : {}),
    // Trimmed + blank-as-absent, matching toManageableConfig's systemPrompt handling for a DB lake.
    ...(fields.systemPrompt?.trim() ? { systemPrompt: fields.systemPrompt.trim() } : {}),
  };
};
