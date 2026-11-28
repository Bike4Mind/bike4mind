import {
  SettingKeySchema,
  isBlankSettingValue,
  isEnforceCreditsLocked,
  mapNestedSecrets,
  NESTED_SECRET_PLACEHOLDER,
  redactNestedSecrets,
  formatUsdPerCredit,
  isMaskedSensitiveSettingValue,
  isPricePerCreditBelowFloor,
  maskSensitiveSettingValue,
  MIN_PRICE_PER_CREDIT_USD,
  partitionDomainList,
  partitionEmailList,
  partitionPythonDataOrigins,
  PYTHON_ARTIFACT_DATA_ORIGINS_MAX,
  FULL_ADMIN_SETTING_KEYS,
  isFullAdmin,
  isRegisteredSettingKey,
  resolveSettingDefinition,
  checkSignupGrantSave,
  isSignupGrantGuardedSaveKey,
  SIGNUP_GRANT_GUARD_SETTING_KEYS,
  type SignupGrantGuardSettings,
} from '@bike4mind/common';
import { withTransaction } from '@bike4mind/database';
import { AdminSettings } from '@bike4mind/database/infra';
import { invalidateSettingsCache } from '@bike4mind/utils';
import { decryptAtRest } from '@bike4mind/utils/security';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';

import { assertCanChangeManagedTags } from '@client/lib/entitlements/managedUserTags';
import { assertCanChangeLakeGateTagsBetween } from '@server/admin/lakeGateTags';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { Config } from '@bike4mind/server-utils/utils/config';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
} from '@bike4mind/server-utils/utils/errors';
import { encryptSecret, isEncrypted, isValidEncryptionKey } from '@bike4mind/server-utils/security/secretEncryption';
import { materializePublicSettingsArtifactSafe } from '@server/utils/publicSettingsArtifact';
import { refuseFloorAboveMeasured } from '@server/utils/refuseFloorAboveMeasured';
import { appReservedHosts } from '@server/utils/pythonArtifactDataOrigins';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { recordAdminSettingChange } from '@bike4mind/server-utils/utils/adminSettingsAudit';
import { AdminAiConfigSchema } from '@bike4mind/common';
import { validateAdminAiConfigPromotion } from '@bike4mind/server-utils/admin/ai/readiness';
import { statusTransportKind } from '@bike4mind/server-utils/utils/mailer/configStatus';
import { mailSenderSettingProblem } from '@bike4mind/server-utils/utils/mailer/sender';

// One-time guard so a self-host install running without a configured key logs the
// plaintext-at-rest degradation once, rather than silently or on every write.
let warnedSelfHostPlaintext = false;

// The stored settings checkSignupGrantSave reads. This route is the admin write path the check guards;
// migrations also write some of these keys, without the check.
async function readSignupGrantGuardSettings(): Promise<SignupGrantGuardSettings> {
  const rows = await AdminSettings.find({ settingName: { $in: [...SIGNUP_GRANT_GUARD_SETTING_KEYS] } }).lean();
  return Object.fromEntries(rows.map(row => [row.settingName, row.settingValue]));
}

// Update Admin Setting
const handler = adminApi({ adminPermissions: { PUT: 'settings:manage' } }).put(
  asyncHandler<
    unknown,
    unknown,
    { key: string; value: unknown; confirmClear?: boolean; confirmAboveMeasuredFloor?: boolean }
  >(async (req, res) => {
    // A contributed key is accepted once registered; anything else still fails SettingKeySchema (400).
    const key: string =
      typeof req.body.key === 'string' && isRegisteredSettingKey(req.body.key)
        ? req.body.key
        : SettingKeySchema.parse(req.body.key);
    if (FULL_ADMIN_SETTING_KEYS.has(key) && !isFullAdmin(req.user)) {
      throw new ForbiddenError('Only full administrators can change this setting');
    }
    const definition = resolveSettingDefinition(key)!;

    // Delete, not store the default, so the setting reads as unset again. hardDelete: the upsert below
    // would match a soft-deleted tombstone without reviving it (softDeletePlugin, db-core/src/utils/mongo.ts).
    if (definition.clearDeletesRow && isBlankSettingValue(req.body.value)) {
      await withTransaction(async () => {
        const existing = await AdminSettings.findOne({ settingName: key }).lean();
        await AdminSettings.deleteOne({ settingName: key }, { hardDelete: true });
        await recordAdminSettingChange(req, { settingName: key, before: existing?.settingValue ?? null, after: null });
      });
      invalidateSettingsCache(key);
      // null, not the declared default: the client renders that as "per embedding space", so an
      // admin can tell a cleared setting apart from one pinned to the default's own number.
      return res.json({ settingName: key, settingValue: null });
    }

    let value = definition.schema.parse(req.body.value);

    if (key === 'forcedRetrievalMinSimilarityPct' && req.body.confirmAboveMeasuredFloor !== true) {
      await refuseFloorAboveMeasured(Number(value), req.logger);
    }

    // pricePerCredit is not scope-capable, so this is its only write path; a stored value that
    // predates the floor is still refused at charge time (lib/credits/utils.ts).
    if (key === 'pricePerCredit' && isPricePerCreditBelowFloor(Number(value))) {
      throw new BadRequestError(
        `Price Per Credit must be at least ${formatUsdPerCredit(MIN_PRICE_PER_CREDIT_USD)}, the per-credit sale price including markup.`
      );
    }

    if (key === 'enforceCredits' && value === false && isEnforceCreditsLocked()) {
      await recordAdminActionFromRequest(req, {
        action: 'settings.admin_settings.denied',
        target: { kind: 'settings', id: key, displayName: key },
        summary: 'blocked disabling enforceCredits on a hosted deployment',
        details: { attemptedAction: 'settings.admin_settings.updated', value: false },
      });
      throw new BadRequestError('enforceCredits is always on for hosted deployments.');
    }

    // The schema accepts any strings so a bad stored entry cannot blank the list on read; the write is
    // where an admin can still fix a typo, so refuse it here.
    if (key === 'ImageModerationReviewerEmails' || key === 'ImageModerationEscalationEmails') {
      const { valid, invalid } = partitionEmailList(value);
      if (invalid.length > 0) {
        throw new BadRequestError(`Not a valid email address: ${invalid.map(e => JSON.stringify(e)).join(', ')}`);
      }
      value = valid;
    }

    if (key === 'blockedEmailDomains') {
      const { valid, invalid } = partitionDomainList(value);
      if (invalid.length > 0) {
        throw new BadRequestError(`Not a valid domain: ${invalid.map(d => JSON.stringify(d)).join(', ')}`);
      }
      // Entries match every subdomain, so a bare public suffix (co.uk, github.io) would block everyone on it.
      const suffixes = valid.filter(d => registrableDomain(d, { allowPrivateDomains: true }) === null);
      if (suffixes.length > 0) {
        throw new BadRequestError(
          `Not an owned domain (public suffix): ${suffixes.map(d => JSON.stringify(d)).join(', ')}`
        );
      }
      value = valid;
    }

    if (key === 'pythonArtifactDataOrigins') {
      const { valid, invalid } = partitionPythonDataOrigins(value, appReservedHosts());
      if (invalid.length > 0) {
        throw new BadRequestError(
          `Not an allowed data origin: ${invalid.map(({ entry, problem }) => `${JSON.stringify(entry)} (${problem})`).join(', ')}`
        );
      }
      if (valid.length > PYTHON_ARTIFACT_DATA_ORIGINS_MAX) {
        throw new BadRequestError(`At most ${PYTHON_ARTIFACT_DATA_ORIGINS_MAX} data origins can be listed.`);
      }
      value = valid;
    }

    if (key === 'mailFrom') {
      const sender = String(value).trim();
      value = sender;
      const problem = mailSenderSettingProblem(sender, {
        transport: statusTransportKind(),
        secretFrom: Config.MAIL_FROM,
      });
      if (problem) throw new BadRequestError(problem);
    }

    if (isSignupGrantGuardedSaveKey(key)) {
      const verdict = checkSignupGrantSave(key, value, await readSignupGrantGuardSettings());
      if (!verdict.ok) throw new UnprocessableEntityError(verdict.reason);
    }

    const isSensitiveSetting = definition.isSensitive === true;

    // The client is only ever sent a mask for a sensitive setting (see fetch.ts), so a
    // mask arriving here is never a real value - keep what is stored rather than
    // overwriting a secret with asterisks. Same "placeholder means preserve" contract
    // sreAgentConfig already uses.
    //
    // The reachable path is the post-save window: the field adopts the new mask while its
    // defaultValue prop still holds the old one, so it reads as dirty and a second Save
    // submits the mask. A stale browser tab holding a mask from a previous page load does
    // the same.
    if (isSensitiveSetting && isMaskedSensitiveSettingValue(value)) {
      const existing = await AdminSettings.findOne({ settingName: key }).lean();
      if (!existing) throw new NotFoundError('Admin setting not found');
      // The stored value is ciphertext; mask the decrypted plaintext so the admin still
      // sees the real last-4, not the ciphertext tail. decryptAtRest passes plaintext
      // (not-yet-migrated) values through unchanged.
      const existingPlaintext = typeof existing.settingValue === 'string' ? decryptAtRest(existing.settingValue) : '';
      return res.json({ ...existing, settingValue: maskSensitiveSettingValue(existingPlaintext) });
    }

    // Clearing a sensitive setting is a legitimate admin action, but it destroys a live
    // credential and an empty value is also what an accidental submit produces. The UI
    // guards its own accidental path; require the intent to be explicit on the wire too,
    // so the destructive case cannot be reached by a bare PUT that merely omits a value.
    if (isSensitiveSetting && value === '' && req.body.confirmClear !== true) {
      throw new BadRequestError(`Refusing to clear ${key}: send confirmClear: true to unset a sensitive setting.`);
    }

    // Nested secret fields (BaseSetting.nestedSecrets): encrypt new plaintext, keep the stored
    // value when the mask comes back, leave an already-encrypted value alone.
    const nestedSecretGroups = definition.nestedSecrets;
    if (nestedSecretGroups?.length) {
      const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
      const existing = await AdminSettings.findOne({ settingName: key }).lean();
      value = mapNestedSecrets(value, existing?.settingValue, nestedSecretGroups, (submitted, stored) => {
        if (submitted === NESTED_SECRET_PLACEHOLDER) return stored ?? '';
        if (isEncrypted(submitted)) return submitted;
        if (!encryptionKey) {
          throw new Error('SECRET_ENCRYPTION_KEY is not configured - cannot store secrets');
        }
        return encryptSecret(submitted, encryptionKey);
      });
    }

    // Encrypt sensitive scalar values at rest. A nestedSecrets setting (an object handled above)
    // is not isSensitive and never reaches this branch. A confirmed clear ('') is stored as-is,
    // and an already-encrypted value is left untouched (idempotent). The submitted plaintext
    // stays in `value` for the response mask below so the admin sees the real last-4.
    //
    // This handler is the ONLY sanctioned writer of a sensitive admin setting, so the
    // encrypt-on-write decision lives here rather than at the repository choke point the read
    // path uses (a future writer - e.g. an OAuth flow persisting a refreshed secret - must
    // encrypt here too, or route through AdminSettings with the same guard). The fail-closed
    // contract is kept identical to the per-user provider-key path (ApiKeyModel.create): a
    // cloud stage without a valid key throws; only a deliberate self-host install
    // (B4M_SELF_HOST) degrades to plaintext at rest, so an admin can still save a local-only
    // sensitive setting such as ollamaBackend before running the openssl key step.
    let settingValueToStore: unknown = value;
    if (key === 'adminAiConfig') await validateAdminAiConfigPromotion(AdminAiConfigSchema.parse(value));
    if (isSensitiveSetting && typeof value === 'string' && value !== '' && !isEncrypted(value)) {
      const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
      if (encryptionKey && isValidEncryptionKey(encryptionKey)) {
        settingValueToStore = encryptSecret(value, encryptionKey);
      } else if (process.env.B4M_SELF_HOST === 'true') {
        if (!warnedSelfHostPlaintext) {
          warnedSelfHostPlaintext = true;
          req.logger?.warn(
            'SECRET_ENCRYPTION_KEY is not configured; storing sensitive admin settings in plaintext at rest ' +
              '(self-host). Set a 64-hex SECRET_ENCRYPTION_KEY to encrypt them.'
          );
        }
        // settingValueToStore stays the plaintext `value`.
      } else {
        throw new Error(
          'SECRET_ENCRYPTION_KEY is not configured (needs a 64-hex value), refusing to store a sensitive ' +
            'setting in plaintext. Set a 64-hex key on this stage (sst secret set SECRET_ENCRYPTION_KEY <value>), ' +
            'or set B4M_SELF_HOST=true to opt into plaintext.'
        );
      }
    }

    const updatedSetting = await withTransaction(async () => {
      const existing = await AdminSettings.findOne({ settingName: key }).lean();
      // Every signup receives these tags (register.ts). Compared against the row read in this
      // transaction, so a concurrent edit conflicts rather than slipping a managed tag past the check.
      if (key === 'defaultTags') {
        const splitTags = (raw: unknown) => (typeof raw === 'string' ? raw.split(',') : []);
        assertCanChangeManagedTags(req.user, splitTags(existing?.settingValue), splitTags(value));
        await assertCanChangeLakeGateTagsBetween(req.user, splitTags(existing?.settingValue), splitTags(value));
      }
      const written = await AdminSettings.findOneAndUpdate(
        { settingName: key },
        { $set: { settingValue: settingValueToStore } },
        { upsert: true, new: true }
      );
      await recordAdminSettingChange(req, {
        settingName: key,
        before: existing?.settingValue ?? null,
        after: written?.settingValue ?? null,
      });
      return written;
    });

    if (!updatedSetting) throw new NotFoundError('Admin setting not found');

    // Invalidate cache for this specific setting
    invalidateSettingsCache(key);
    req.logger?.info(`🗑️ Invalidated cache for updated setting: ${key}`);

    // Write-through: when a publicSafe setting changes, refresh the public CDN config
    // artifact so clients pick up the change on next load without a DB round-trip (M2.5).
    // Best-effort - a failure here must never fail the settings write; the authed
    // /api/settings/fetch remains the source of truth and the client reconciles against it.
    //
    // We intentionally AWAIT (rather than fire-and-forget): in Lambda the execution
    // environment is frozen once the handler responds, so un-awaited background work can be
    // dropped - which for a security-relevant flag like enforceMFA would leave the public
    // artifact stale. The cost is bounded (one indexed find + one small S3 PUT) and this
    // branch only runs on the rare publicSafe-settings write, so it can't realistically
    // approach the 60s function timeout.
    if (definition.publicSafe) {
      await materializePublicSettingsArtifactSafe(req.logger);
    }

    // Mask nested secret fields before responding; the stored ciphertext never leaves the server.
    if (nestedSecretGroups?.length && updatedSetting.settingValue) {
      const redacted = updatedSetting.toObject();
      (redacted as unknown as Record<string, unknown>).settingValue = redactNestedSecrets(
        JSON.parse(JSON.stringify(updatedSetting.settingValue)),
        nestedSecretGroups
      );
      return res.json(redacted);
    }

    // Never echo a sensitive value back, not even the one just submitted - the write
    // response is the other way a stored secret could land in the browser payload. Mask
    // the submitted plaintext (`value`), not the stored ciphertext, so the last-4 is real.
    if (isSensitiveSetting) {
      const redacted = updatedSetting.toObject();
      (redacted as unknown as Record<string, unknown>).settingValue = maskSensitiveSettingValue(
        typeof value === 'string' ? value : ''
      );
      return res.json(redacted);
    }

    return res.json(updatedSetting);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
