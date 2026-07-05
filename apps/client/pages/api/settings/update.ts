import { SettingKeySchema, SreAgentConfig, SRE_SECRET_PLACEHOLDER, settingsMap } from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database/infra';
import { invalidateSettingsCache } from '@bike4mind/utils';

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { Config } from '@server/utils/config';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';
import { encryptSecret, isEncrypted } from '@server/security/secretEncryption';
import { materializePublicSettingsArtifactSafe } from '@server/utils/publicSettingsArtifact';

// Update Admin Setting
const handler = baseApi().put(
  asyncHandler<unknown, unknown, { key: string; value: unknown }>(async (req, res) => {
    if (!req.user.isAdmin) throw new ForbiddenError('Permission denied');

    const key = SettingKeySchema.parse(req.body.key);

    let value = settingsMap[key].schema.parse(req.body.value);

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

    if (!req.ability) throw new NotFoundError('Ability not found');

    // Assuming you have a function to check permissions
    if (!req.ability.can('update', AdminSettings)) throw new NotFoundError('Permission denied');

    const updatedSetting = await AdminSettings.findOneAndUpdate(
      { settingName: key },
      { $set: { settingValue: value } },
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

    return res.json(updatedSetting);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
