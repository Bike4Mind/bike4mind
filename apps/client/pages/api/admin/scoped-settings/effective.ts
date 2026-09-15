import { Request, Response } from 'express';
import { z } from 'zod';
import {
  ApiKeyScope,
  CreditHolderType,
  redactSettingSecrets,
  SettingKeySchema,
  type SettingScope,
} from '@bike4mind/common';
import { adminSettingsRepository, scopedSettingsRepository } from '@bike4mind/database/infra';
import { scopedSettingsService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin, parseOrBadRequest } from '@server/utils/errors';

/**
 * Admin read surface for the EFFECTIVE value of a scoped setting - sibling to `./index.ts`, which only
 * reads/writes the override rows themselves. `resolveScopedSetting` already computes the winning value
 * and which rung produced it (platform/organization/owner/lake); nothing exposed that pair before this
 * route, so the only way to see it was to run a real request as the affected user and read the value
 * off its response (#2769 item 3 - the observability gap that let items 1/2's stale-pointer bugs go
 * unnoticed for as long as they did).
 *
 * A separate route rather than a query-param mode on `./index.ts`: that route's GET returns the whole
 * override inventory (an array); this one resolves a single setting for a single scope (an object) -
 * different shapes are clearer as different resources than as one endpoint branching on query params.
 *
 * Session/admin route, not a public API-key endpoint, so it carries no api-contract definition (mirrors
 * `./index.ts`). requiredScopes gates the API-key path only; ensureAdmin still runs for the session path.
 */

// Owner must be identified as a pair (id + type) - reject either half arriving alone. Mirrors the
// `SettingOwner` shape `resolveScopedSetting` expects, split into two query params since a query string
// has no nested-object syntax.
//
// This route does NOT derive ownership - it resolves exactly the scope the caller supplies. A real
// caller's scope is normally built by scopeForLake/scopeForCaller/scopeForFileOwner, which set org AND
// owner together from a resource's ownership; passing only `lakeId` here tests the lake rung alone and
// will silently miss an org/owner override that a real request for that lake would have picked up. To
// match a real caller, supply the full scope (organizationId + ownerId/ownerType + lakeId), not just
// the one id you're investigating.
const EffectiveQuerySchema = z
  .object({
    settingName: SettingKeySchema,
    organizationId: z.string().min(1).optional(),
    ownerId: z.string().min(1).optional(),
    ownerType: z.enum([CreditHolderType.User, CreditHolderType.Organization]).optional(),
    lakeId: z.string().min(1).optional(),
  })
  .superRefine(({ ownerId, ownerType }, ctx) => {
    if (!!ownerId === !!ownerType) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [ownerId ? 'ownerType' : 'ownerId'],
      message: 'ownerId and ownerType must be provided together',
    });
  });

export type EffectiveSettingQuery = z.infer<typeof EffectiveQuerySchema>;

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req: Request, res: Response) => {
  ensureAdmin(req.user?.isAdmin);
  const { settingName, organizationId, ownerId, ownerType, lakeId } = parseOrBadRequest(
    EffectiveQuerySchema,
    req.query
  );

  const scope: SettingScope = {
    organizationId,
    owner: ownerId && ownerType ? { id: ownerId, type: ownerType } : undefined,
    lakeId,
  };

  // Resolving a key with no `scope` metadata (settableAt) is harmless by design - it degrades to the
  // platform value with source `platform`, the same "byte-for-byte unchanged" contract every existing
  // platform-only consumer already relies on. No pre-check needed here.
  const resolved = await scopedSettingsService.resolveScopedSetting(
    settingName,
    scope,
    { adminSettings: adminSettingsRepository, scopedSettings: scopedSettingsRepository },
    { logger: req.logger }
  );

  // A sensitive key is never scopable (computeCandidateRefs refuses it), so it always resolves from
  // the decrypted platform value - the same redaction every other admin settings-read route applies
  // (pages/api/settings/index.ts, pages/api/settings/fetch.ts) has to run here too, or this route
  // becomes a plaintext-secret leak for any isSensitive key.
  const { settingValue: value } = redactSettingSecrets({ settingName, settingValue: resolved.value });

  // Surfaced so an admin investigating "I set this lever and nothing happened" can see a discarded
  // narrower-rung override rather than get the same source:"platform" a never-set lever would show.
  return res.json({
    settingName,
    scope,
    value,
    source: resolved.source,
    ...(resolved.ignoredOverrides?.length ? { ignoredOverrides: resolved.ignoredOverrides } : {}),
  });
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
