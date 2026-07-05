import { AdminSettings } from '@bike4mind/database/infra';
import { SreAgentConfig, SreAgentConfigSchema, SRE_SECRET_PLACEHOLDER, settingsMap } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { ensurePublicSettingsArtifactOncePerInstance } from '@server/utils/publicSettingsArtifact';

const handler = baseApi({ auth: true }).get(async (req, res) => {
  // Bootstrap/self-heal the public CDN config artifact once per Lambda instance (M2.5).
  // Kick it off here and await before responding (below) - overlapping it with the settings
  // query. It MUST be awaited: in Lambda, un-awaited work is dropped when the handler
  // responds, so fire-and-forget never actually writes the artifact (verified on preview).
  // Only the first call per cold instance does work; later calls resolve instantly.
  const bootstrap = ensurePublicSettingsArtifactOncePerInstance(req.logger);

  const isAdmin = req.user?.isAdmin === true;
  const permittedKeys = (Object.values(settingsMap) as Array<{ isSensitive?: boolean; key: string }>)
    .filter(s => isAdmin || !s.isSensitive)
    .map(s => s.key);

  // Only fetch the specific settings that users are allowed to see
  const settings = await AdminSettings.find({ settingName: { $in: permittedKeys } }).lean();

  // Redact encrypted secrets before sending to client.
  // Parse through SreAgentConfigSchema first to migrate v1->v2 (so secrets
  // end up in repos[] where redaction looks for them), then mask them.
  const redacted = (settings ?? []).map(setting => {
    if (setting.settingName === 'sreAgentConfig' && setting.settingValue) {
      let config: SreAgentConfig;
      try {
        config = SreAgentConfigSchema.parse(setting.settingValue);
      } catch {
        return setting;
      }

      return {
        ...setting,
        settingValue: {
          ...config,
          repos: (config.repos ?? []).map(repo => ({
            ...repo,
            ...(repo.webhookSecret && { webhookSecret: SRE_SECRET_PLACEHOLDER }),
            ...(repo.callbackToken && { callbackToken: SRE_SECRET_PLACEHOLDER }),
          })),
        },
      };
    }
    return setting;
  });

  // Ensure the bootstrap completes before the handler returns (Lambda freeze - see above).
  // Swallowed internally, so this never fails the read.
  await bootstrap;

  return res.json(redacted);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
