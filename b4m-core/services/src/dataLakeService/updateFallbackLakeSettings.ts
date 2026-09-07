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
     * audit that makes it so: the `before` side of the config diff below is read from the overlay
     * row DIRECTLY (see the comment at that read), not from the synthetic lake. Wired optionally,
     * that read would be unavailable and every field would diff as unset -> value on every write,
     * so the history would record a first-time set each time an admin re-saved the same prompt.
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
  const lake = await assertFallbackLakeSettingsWriteAccess(lakeIdOrSlug, ctx, { db, logger });

  // The audit's BEFORE side is read here, from the overlay row itself - deliberately NOT taken from
  // `lake`. `resolveFallbackLake` merges only the fields that are safe to expose on a synthetic
  // document every reader receives, and `systemPrompt` is intentionally not among them (it reaches
  // only the admin projection - see toFallbackConfig). Deriving `before` from what that merge
  // happens to include made the diff silently blind to the one FINGERPRINTED field: a clear
  // recorded nothing at all, and every re-save of an unchanged prompt forged a first-time set.
  //
  // Read BEFORE the write and deliberately UNGUARDED: a failed read here aborts the request with
  // nothing persisted, which is strictly better than completing the write and recording a history
  // entry that claims values moved from nowhere.
  const overlayBefore = await db.fallbackLakeSettings.findByLakeId(lake.id);
  const before: Partial<IDataLake> = {
    ...(lake as Partial<IDataLake>),
    groundingMode: overlayBefore?.groundingMode,
    preferredSystemPromptId: overlayBefore?.preferredSystemPromptId,
    systemPrompt: overlayBefore?.systemPrompt,
  };

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
  const projected: Partial<IDataLake> = { ...before };
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
      changes: diffLakeConfig(before, projected),
      // Overridden, because this route's gate is `ctx.isAdmin` directly (see
      // assertFallbackLakeSettingsWriteAccess) and nothing else: `resolveLakeManageRung` checks the
      // admin rung LAST, so on an ORG-SCOPED registry lake (overlay-contributed entries may carry
      // `organizationId`) it would name `org-admin` for an admin who also administers that org - a
      // rung that cannot pass this gate at all, since an org admin who is not a platform admin is
      // refused here. The rung is an authorization fact, so it must name the branch that let the
      // call through. If this gate is ever widened, this literal must be revisited with it.
      manageRung: 'platform-admin',
    },
    { db, logger }
  );

  // Built from `before` (which carries the stored overlay) rather than `lake`, and each applied
  // field is DELETED when it lands blank rather than merely not re-added: spreading a base that
  // still holds the old value and then skipping the falsy branch left a cleared field reading as
  // unchanged in the response body.
  const merged = { ...before } as Record<string, unknown>;
  const applied: Array<[keyof IFallbackLakeSetting, string | undefined]> = [
    ['groundingMode', fields.groundingMode],
    ['preferredSystemPromptId', fields.preferredSystemPromptId],
    // Trimmed + blank-as-absent, matching toManageableConfig's systemPrompt handling for a DB lake.
    ['systemPrompt', fields.systemPrompt?.trim()],
  ];
  for (const [key, value] of applied) {
    if (value === undefined) continue; // omitted by the caller - leave whatever was stored
    if (value) merged[key] = value;
    else delete merged[key]; // an applied clear must not fall back to the pre-write value
  }
  return merged as unknown as IDataLakeDocument;
};
