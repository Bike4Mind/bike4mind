import { AdminSettings } from '@bike4mind/database/infra';
import { ApiKeyScope, HTTPError, MODEL_ACCESS_REVISION_HEADER } from '@bike4mind/common';
import { readModelAccessRevision } from '@bike4mind/server-utils/modelDiscovery/modelAccessRevision';

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';

// Get LLM Model Configurations (readable by all authenticated users, needed for model selection)
const getHandler = asyncHandler(async (req, res) => {
  if (!req.user) throw new ForbiddenError('Authentication required');

  // In a header so the array body that pickers and API-key callers read keeps its shape.
  const revision = await readModelAccessRevision().catch(() => null);
  if (revision) res.setHeader(MODEL_ACCESS_REVISION_HEADER, revision);

  try {
    const setting = await AdminSettings.findOne({ settingName: 'llmModelConfigurations' });
    const configurations = setting?.settingValue || [];

    // Ensure configurations is an array
    if (!Array.isArray(configurations)) {
      return res.json({ settingValue: [] });
    }

    // Ensure we only return essential fields (in case legacy data exists).
    // allowedEntitlements is included only when non-empty so tag-only models
    // stay byte-identical (no behavior change for existing configs).
    const optimizedConfigurations = configurations.map((config: any) => ({
      id: config.id,
      enabled: config.enabled,
      allowedUserTags: config.allowedUserTags,
      ...(Array.isArray(config.allowedEntitlements) &&
        config.allowedEntitlements.length > 0 && { allowedEntitlements: config.allowedEntitlements }),
      ...(config.fallbackModel && { fallbackModel: config.fallbackModel }),
      ...(config.rank !== undefined && { rank: config.rank }),
    }));

    return res.json({ settingValue: optimizedConfigurations });
  } catch (error) {
    return res.json({ settingValue: [] });
  }
});

// Save-all replaced the whole array, so one save from a stale tab would undo other admins' per-model edits.
const putHandler = asyncHandler(async () => {
  throw new HTTPError(410, 'Use the per-model access editor');
});

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] })
  .get(getHandler)
  .put(putHandler);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
