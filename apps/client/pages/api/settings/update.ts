import {
  SettingKeySchema,
  SreAgentConfig,
  SRE_SECRET_PLACEHOLDER,
  isMaskedSensitiveSettingValue,
  maskSensitiveSettingValue,
  settingsMap,
} from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database/infra';
import { invalidateSettingsCache } from '@bike4mind/utils';
import { decryptAtRest } from '@bike4mind/utils/security';

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { Config } from '@server/utils/config';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { encryptSecret, isEncrypted, isValidEncryptionKey } from '@server/security/secretEncryption';
import { materializePublicSettingsArtifactSafe } from '@server/utils/publicSettingsArtifact';

// One-time guard so a self-host install running without a configured key logs the
// plaintext-at-rest degradation once, rather than silently or on every write.
let warnedSelfHostPlaintext = false;

// Update Admin Setting
const handler = baseApi().put(
  asyncHandler<unknown, unknown, { key: string; value: unknown; confirmClear?: boolean }>(async (req, res) => {
    if (!req.user.isAdmin) throw new ForbiddenError('Permission denied');

    // Authorize before any branch reads or returns stored setting data.
    if (!req.ability) throw new NotFoundError('Ability not found');
    if (!req.ability.can('update', AdminSettings)) throw new NotFoundError('Permission denied');

    const key = SettingKeySchema.parse(req.body.key);

    let value = settingsMap[key].schema.parse(req.body.value);

    const isSensitiveSetting = settingsMap[key].isSensitive === true;

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

    // Encrypt sensitive fields before storing (v2 config: defaults + per-repo secrets)
    if (key === 'sreAgentConfig') {
      const sreValue = value as SreAgentConfig;
      const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
      const existing = await AdminSettings.findOne({ settingName: key }).lean();
      const existingConfig = existing?.settingValue as SreAgentConfig | undefined;

      /**
       * Encrypt or preserve a single secret field.
       * - New plaintext -> encrypt
       * - Placeholder (--------) -> preserve existing encrypted value from DB
       * - Already encrypted -> keep as-is
       */
      const processSecret = (current: string | undefined, existingValue: string | undefined): string | undefined => {
        if (!current) return current;
        if (current === SRE_SECRET_PLACEHOLDER) return existingValue || '';
        if (isEncrypted(current)) return current;
        if (!encryptionKey) {
          throw new Error('SECRET_ENCRYPTION_KEY is not configured — cannot store secrets');
        }
        return encryptSecret(current, encryptionKey);
      };

      // Encrypt per-repo secrets (match by owner/repo key, not array index)
      if (sreValue.repos) {
        for (let i = 0; i < sreValue.repos.length; i++) {
          const repo = sreValue.repos[i];
          const existingRepo = existingConfig?.repos?.find(r => r.owner === repo.owner && r.repo === repo.repo);
          repo.webhookSecret = processSecret(repo.webhookSecret, existingRepo?.webhookSecret) ?? '';
          repo.callbackToken = processSecret(repo.callbackToken, existingRepo?.callbackToken) ?? '';
        }
      }

      value = sreValue;
    }

    // Encrypt sensitive scalar values at rest. sreAgentConfig (an object handled above) is
    // not isSensitive and never reaches this branch. A confirmed clear ('') is stored as-is,
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

    const updatedSetting = await AdminSettings.findOneAndUpdate(
      { settingName: key },
      { $set: { settingValue: settingValueToStore } },
      { upsert: true, new: true }
    );

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
    if (settingsMap[key]?.publicSafe) {
      await materializePublicSettingsArtifactSafe(req.logger);
    }

    // Redact encrypted secrets before responding (v2 config: defaults + per-repo)
    if (key === 'sreAgentConfig' && updatedSetting.settingValue) {
      const cfg = updatedSetting.settingValue as unknown as SreAgentConfig;
      const redacted = updatedSetting.toObject();
      const redactedCfg = JSON.parse(JSON.stringify(cfg)) as SreAgentConfig;

      // Redact per-repo secrets
      if (redactedCfg.repos) {
        for (const repo of redactedCfg.repos) {
          if (repo.webhookSecret) repo.webhookSecret = SRE_SECRET_PLACEHOLDER;
          if (repo.callbackToken) repo.callbackToken = SRE_SECRET_PLACEHOLDER;
        }
      }

      (redacted as unknown as Record<string, unknown>).settingValue = redactedCfg;
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
