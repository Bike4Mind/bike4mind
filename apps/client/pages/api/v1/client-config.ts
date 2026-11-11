/**
 * GET /api/v1/client-config - everything an API client needs to configure itself, in one call.
 *
 * Auth mode and scopes come from `getClientConfigContract`. Every field is picked by name below;
 * nothing is copied wholesale from admin settings, so an internal setting can only reach the wire
 * if someone adds it to this file AND to ClientConfigResponseSchema. Settings are read through
 * getSettingsValue so stored overrides, defaults and the hosted `enforceCredits` lock apply exactly
 * as they do for the server-side gates.
 */

import {
  CLIENT_CONFIG_SERVER_STATUSES,
  getClientConfigContract,
  type ClientConfigFeatures,
  type ClientConfigResponse,
  type SettingKey,
} from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { getCallerModelList } from '@server/utils/callerModelList';
import { CLIENT_CONFIG_FEATURE_SETTINGS } from '@server/utils/clientConfigFeatures';
import { callablePublicModels, toPublicModelWithReasoning } from '@server/utils/publicModels';
import { publicAppUrl } from '@bike4mind/server-utils/utils/validators';
import { configuredSupportEmail } from '@server/auth/blockedSignIn';
import { resolveRecommendedModelIds } from '@client/app/utils/recommendedModels';

/**
 * A stored row that fails its schema (blank, off-list, malformed) already reads as the setting's
 * own default. Every key published here declares one, so `undefined` is a broken definition: fail
 * loudly rather than publish a hole the contract does not allow.
 */
const readSetting = <K extends SettingKey>(key: K, settings: Record<string, string>) => {
  const value = getSettingsValue(key, settings);
  if (value === undefined) throw new Error(`client-config: setting ${key} resolved to no value and has no default`);
  return value;
};

const resolveFeatures = (settings: Record<string, string>): ClientConfigFeatures => {
  const entries = Object.entries(CLIENT_CONFIG_FEATURE_SETTINGS).map(([flag, key]) => [
    flag,
    readSetting(key, settings) === true,
  ]);
  return Object.fromEntries(entries) as ClientConfigFeatures;
};

const isServerStatus = (value: string): value is ClientConfigResponse['server']['status'] =>
  (CLIENT_CONFIG_SERVER_STATUSES as readonly string[]).includes(value);

const resolveServerStatus = (settings: Record<string, string>): ClientConfigResponse['server']['status'] => {
  const status = readSetting('serverStatus', settings);
  // getSettingsValue already reads an off-enum row as the default; this narrows the type and, should
  // the setting gain a value the wire enum lacks, reports it as not-live rather than failing the response.
  return isServerStatus(status) ? status : 'maintenance';
};

const handler = nextRouteForContract(getClientConfigContract, {
  // Read once at client start-up; it should not spend the daily budget the real work needs.
  exemptReadsFromDailyRateLimit: true,
}).get(async (req, res) => {
  const [settings, { models }] = await Promise.all([
    getSettingsMap({ adminSettings: adminSettingsRepository }, { logger: req.logger }),
    getCallerModelList(req.user, req.logger),
  ]);

  const available = callablePublicModels(models)
    .map(toPublicModelWithReasoning)
    .sort((a, b) => a.id.localeCompare(b.id));
  const availableIds = new Set(available.map(model => model.id));
  const defaultId = readSetting('DefaultAPIModel', settings);

  const body: ClientConfigResponse = {
    server: {
      status: resolveServerStatus(settings),
      app_url: publicAppUrl(req),
      support_email: configuredSupportEmail() ?? null,
    },
    features: resolveFeatures(settings),
    limits: {
      max_upload_size_mb: readSetting('MaxFileSize', settings),
      credits_enforced: readSetting('enforceCredits', settings) === true,
      low_credits_threshold: readSetting('lowCreditsThreshold', settings),
    },
    models: {
      default_id: defaultId,
      recommended_ids: resolveRecommendedModelIds(readSetting('recommendedModelIds', settings), defaultId).filter(id =>
        availableIds.has(id)
      ),
      available,
    },
  };

  // `available` is built from the caller's own provider keys - never cacheable by a shared cache.
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(body);
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
