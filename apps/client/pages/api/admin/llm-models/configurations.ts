import { z } from 'zod';
import { AdminSettings } from '@bike4mind/database/infra';
import {
  ApiKeyScope,
  ConflictError,
  ForbiddenError,
  MODEL_ACCESS_REVISION_HEADER,
  ModelAccessSaveRequestSchema,
  isFullAdmin,
} from '@bike4mind/common';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { readModelAccessRevision } from '@bike4mind/server-utils/modelDiscovery/modelAccessRevision';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { assertFullAdmin, saveModelAccess } from '@server/modelAccess/modelAccess';
import { indexEntries, stampOf } from '@server/modelAccess/modelAccessEntries';

// Pickers retain the array body. Full admins additionally receive their editor's loaded stamps.
const getHandler = asyncHandler(async (req, res) => {
  if (!req.user) throw new ForbiddenError('Authentication required');
  res.setHeader('Cache-Control', 'no-store');
  // Read before the entries: a concurrent write may cause a conservative refetch, never a false fresh header.
  const revision = await readModelAccessRevision().catch(() => null);
  if (revision) res.setHeader(MODEL_ACCESS_REVISION_HEADER, revision);
  const setting = await AdminSettings.findOne({ settingName: 'llmModelConfigurations' });
  const rawEntries = setting ? z.array(z.unknown()).parse(setting.settingValue) : [];
  const configurations = [...indexEntries(rawEntries).values()].map(entry => ({
    id: entry.id,
    enabled: entry.enabled,
    allowedUserTags: entry.allowedUserTags,
    ...(entry.allowedEntitlements.length > 0 && { allowedEntitlements: entry.allowedEntitlements }),
    ...(entry.fallbackModel && { fallbackModel: entry.fallbackModel }),
    ...(entry.rank !== undefined && { rank: entry.rank }),
    ...(isFullAdmin(req.user) && { updatedAt: stampOf(entry) }),
  }));
  // A failed access read must propagate; an empty array would restore defaults in every picker.
  return res.json({ settingValue: configurations });
});

const putHandler = asyncHandler(async (req, res) => {
  if (req.apiKeyInfo) throw new ForbiddenError('Model access saves require a session');
  assertFullAdmin(req.user);
  if (typeof req.body === 'object' && req.body !== null && 'configurations' in req.body) {
    throw new ConflictError('The model editor changed. Reload this page before saving.');
  }
  const body = parseOrBadRequest(ModelAccessSaveRequestSchema, req.body);
  return res.json(await saveModelAccess(req, body));
});

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] })
  .get(getHandler)
  .put(putHandler);
export const config = { api: { externalResolver: true } };
export default handler;
