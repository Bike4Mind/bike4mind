import { AdminSettings } from '@bike4mind/database/infra';
import { redactSettingSecrets, settingsMap, type AdminSettingDoc } from '@bike4mind/common';
import { decryptAtRest } from '@bike4mind/utils/security';
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

  // isSensitive gates WHO may fetch a setting; it does not by itself keep the value out
  // of the response. Redact on the way out so a sensitive value never reaches the browser
  // THROUGH THIS ENDPOINT - admins get a mask and write a replacement, never a round-trip
  // of the stored secret.
  //
  // Scope, deliberately stated: this closes the HTTP read path only. It is NOT a
  // system-wide guarantee. The `adminsettings` WebSocket subscription
  // (UserSettingsContext) still fans unredacted documents out to admin browsers and
  // lands them in the same react-query cache key this endpoint fills, and
  // GET /api/settings returns the collection unredacted. Both are pre-existing and
  // tracked separately. The real chokepoint for all three would be a redacting
  // toJSON/toObject transform on AdminSettingsSchema.
  //
  // Server-side consumers (apiKeyService.getEffective*) read AdminSettings directly and
  // are unaffected by this endpoint.
  //
  // Sensitive values are stored encrypted; decrypt before redacting so the mask carries the
  // real last-4 rather than the ciphertext tail. Only the mask leaves the server - the
  // decrypted plaintext exists here just long enough to compute it. decryptAtRest passes a
  // plaintext (not-yet-migrated) or non-encrypted value through unchanged.
  const redacted: AdminSettingDoc[] = (settings ?? []).map(setting => {
    const decrypted =
      typeof setting.settingValue === 'string'
        ? { ...setting, settingValue: decryptAtRest(setting.settingValue) }
        : setting;
    return redactSettingSecrets(decrypted as unknown as AdminSettingDoc);
  });

  // defaultEmbeddingModel's default is env-dependent on self-host (a local Ollama embedder when
  // no cloud key, else the cloud default - see defaultEmbeddingModelForEnv). The client cannot
  // re-derive it: OLLAMA_BASE_URL is not inlined into the browser bundle, so a browser fallback
  // resolves to the cloud default and then flags every locally-embedded file as a model mismatch
  // (useEmbeddingMismatchStatus). When no admin override is stored, surface the server-resolved
  // effective default so client and server agree. Hosted is unaffected (same cloud default).
  if (
    !redacted.some(s => s.settingName === 'defaultEmbeddingModel') &&
    permittedKeys.includes('defaultEmbeddingModel')
  ) {
    redacted.push({
      settingName: 'defaultEmbeddingModel',
      settingValue: settingsMap.defaultEmbeddingModel.defaultValue,
    });
  }

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
