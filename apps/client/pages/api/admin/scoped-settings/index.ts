import { Request, Response } from 'express';
import { z } from 'zod';
import { fromZodError } from 'zod-validation-error';
import { CreditHolderType, SettingKeySchema, SettingScopeLevel } from '@bike4mind/common';
import { scopedSettingsRepository } from '@bike4mind/database/infra';
import { scopedSettingsService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ensureAdmin } from '@server/utils/errors';

/**
 * Admin write surface for the scoped-settings overlay - the org/owner/lake OVERRIDES read by
 * `resolveScopedSetting`. Platform values keep their own writer (`PUT /api/settings/update`) and are
 * untouched here, which is why `platform` is not a level this route accepts.
 *
 * Admin-only at EVERY rung, including `lake`: these are operational and cost levers, so the operator
 * is the platform operator rather than a lake manager.
 *
 * Session/admin route, not a public API-key endpoint, so it carries no api-contract definition.
 */

// The override altitudes only. Rejecting `platform` structurally (rather than with a hand-written
// check) is what keeps this route from ever looking like a second writer of the platform value.
const ScopeLevelSchema = z.enum([SettingScopeLevel.Organization, SettingScopeLevel.Owner, SettingScopeLevel.Lake]);

const ScopeAddressSchema = z.object({
  settingName: SettingKeySchema,
  scopeLevel: ScopeLevelSchema,
  scopeId: z.string().min(1),
});

const PutBodySchema = ScopeAddressSchema.extend({
  ownerType: z.enum([CreditHolderType.User, CreditHolderType.Organization]).optional(),
  /**
   * Required, and scalar only. Both guards are load-bearing rather than defensive:
   * `makeNumberSetting`/`makeBooleanSetting` schemas end in `.prefault(...)`, so the write service's
   * `safeParse(undefined)` SUCCEEDS and a missing value would sail past its validation to die on the
   * Mongoose `required: true` as a 500. zod's `number` refuses NaN/Infinity, so `1e999` is rejected
   * here instead of being stored as the string "Infinity".
   */
  value: z.union([z.boolean(), z.number(), z.string()]),
});

export type ScopedOverridePutBody = z.infer<typeof PutBodySchema>;
export type ScopedOverrideDeleteQuery = z.infer<typeof ScopeAddressSchema>;

/**
 * Every rejection on this route answers 400. A raw ZodError would instead reach `errorHandler` as a
 * 422 (see its `isZodError` branch), leaving the admin UI two statuses to message off for the same
 * class of mistake.
 */
const parseOrBadRequest = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestError(fromZodError(parsed.error).message);
  return parsed.data;
};

/**
 * How `writeScopedOverride` marks its own rejections (not settable at this level, sensitive, failed
 * validation, either ownerType violation). MUST STAY IN SYNC with the message prefix in
 * `b4m-core/services/src/settings/writeScopedOverride.ts`.
 */
const SERVICE_REJECTION_PREFIX = '[scopedSettings]';

/**
 * The write service signals a rejection by throwing a plain `Error`, and `errorHandler` maps a plain
 * `Error` to 500 AND logs it at `error` level - which is what the LiveOps CloudWatch filter keys on.
 * An admin typing 500 into a `max: 100` field must not page anyone, so the service's rejections come
 * back as a 400 with its own wording intact. Anything else (a driver or connection failure) is a
 * real server error and is rethrown untouched.
 */
const runWrite = async (write: () => Promise<void>): Promise<void> => {
  try {
    await write();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(SERVICE_REJECTION_PREFIX)) {
      throw new BadRequestError(error.message);
    }
    throw error;
  }
};

const handler = baseApi()
  .get(async (req: Request, res: Response) => {
    ensureAdmin(req.user?.isAdmin);
    // The whole collection in one read. It is small by design - a row exists only where an operator
    // actually set an override - and both questions the admin UI asks ("which rungs override setting
    // X" and "what is overridden at scope Y") are answered from the same inventory. The soft-delete
    // pre-hook excludes tombstones.
    return res.json(await scopedSettingsRepository.find({}));
  })
  .put(async (req: Request, res: Response) => {
    ensureAdmin(req.user?.isAdmin);
    const { settingName, scopeLevel, scopeId, ownerType, value } = parseOrBadRequest(PutBodySchema, req.body);

    // The overlay stores the raw string and the resolver re-parses it through the setting's own
    // schema (pickOverride), so String() is the exact round trip for all three scalar types.
    const settingValue = typeof value === 'string' ? value : String(value);

    await runWrite(() =>
      scopedSettingsService.writeScopedOverride(
        settingName,
        { scopeLevel, scopeId, ownerType },
        settingValue,
        { scopedSettings: scopedSettingsRepository },
        { logger: req.logger }
      )
    );

    return res.json({ settingName, scopeLevel, scopeId, ownerType, settingValue });
  })
  .delete(async (req: Request, res: Response) => {
    ensureAdmin(req.user?.isAdmin);
    // Address comes from the query, not a body: a DELETE body is awkward to send through axios and
    // next-connect.
    const { settingName, scopeLevel, scopeId } = parseOrBadRequest(ScopeAddressSchema, req.query);

    await runWrite(() =>
      scopedSettingsService.clearScopedOverride(
        settingName,
        { scopeLevel, scopeId },
        { scopedSettings: scopedSettingsRepository },
        { logger: req.logger }
      )
    );

    return res.json({ cleared: true });
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
