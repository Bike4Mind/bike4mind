import { buildApiKeyTable, getAvailableModels, getSupersededModels } from '@bike4mind/llm-adapters';
import { apiKeyService } from '@bike4mind/services';
import {
  createModelAdmission,
  isFreeTierExempt,
  isFreeTierModel,
  isUnpricedTextModel,
  loadFreeTierAllowedModels,
  loadModelConfigurations,
} from '@bike4mind/services/llm/modelAdmission';
import { apiKeyRepository, adminSettingsRepository, cacheRepository } from '@bike4mind/database';
import { getSettingsByNames, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import {
  getImageModelCapabilities,
  isImageModel,
  PAID_PLAN_ENTITLEMENT_KEY,
  type IUserDocument,
  type ModelAccessLock,
  type ModelInfo,
  type SupersededModelInfo,
} from '@bike4mind/common';
import { getUserEntitlements, toEntitlementUser } from '@server/entitlements';
import { Logger } from '@bike4mind/observability';
import { CacheKeys } from '@server/utils/cacheKeys';
import { modelCatalogListingOptions } from '@server/utils/modelCatalogOptions';

/**
 * The models one caller can use, shared by `GET /api/models` (internal shape, SPA + CLI) and
 * `GET /api/v1/models` (public projection) so the two can never disagree on which models exist.
 */
type CatalogModelList = { models: ModelInfo[]; supersededModels: SupersededModelInfo[] };

/** `lockedModels`: paid-only models a free account sees but cannot select (see ModelInfo.access). */
export type CallerModelList = CatalogModelList & { lockedModels: ModelInfo[] };

const PAID_PLAN_LOCK: ModelAccessLock = { locked: true, reason: 'requires_paid_plan' };

// Short floor for cross-tab / fresh page loads. The dominant repeat-open case is
// already absorbed by useModelInfo's 1h client staleTime; this just bounds how
// often the multi-backend fan-out runs server-side.
const MODELS_CACHE_TTL_MS = 60_000;

// Cache identity for a caller with no session. Distinct from any real user id and
// from the ids system callers use, so an anonymous page load can never be served
// a list assembled from someone else's keys.
const ANONYMOUS_CACHE_ID = 'anonymous';

// Self-hosted `local-image/*` checkpoints are discovered at runtime and carry no known rules.
function withImageCapabilities(model: ModelInfo): ModelInfo {
  if (!isImageModel(model.id)) return model;
  return { ...model, image: getImageModelCapabilities(model.id) };
}

async function buildCallerModelList(userId: string | null, enforceCredits: boolean): Promise<CatalogModelList> {
  const dbAdapters = { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames };
  const coreKeys = await apiKeyService.getEffectiveLLMApiKeys(userId, dbAdapters);

  // Keyed by ModelBackend, which is what the shared listing gate reads. Built by
  // the shared helper rather than a literal here: this list is the picker, so a
  // provider missing from the table is a provider no user can select.
  const apiKeys = buildApiKeyTable(coreKeys);

  const listedModels = await getAvailableModels(apiKeys, modelCatalogListingOptions());
  // Same rule createModelAdmission refuses at call time (llm/modelAdmission.ts): with credits on,
  // an unpriced text model settles at $0, so the picker must not offer it either.
  const offered = enforceCredits ? listedModels.filter(model => !isUnpricedTextModel(model)) : listedModels;
  const models = offered.map(withImageCapabilities);

  // Superseded pins the client can offer to upgrade, resolved by llm-adapters
  // through the same catalog-overlay-then-static-map chain a pinned request takes.
  // Reads the fan-out getAvailableModels just did, so it costs no extra work.
  return { models, supersededModels: getSupersededModels(offered) };
}

// Fails closed to "free" for the listing: a failed subscription read must not 500 the picker.
async function holdsPaidPlan(user: IUserDocument): Promise<boolean> {
  try {
    return (await getUserEntitlements(toEntitlementUser(user))).includes(PAID_PLAN_ENTITLEMENT_KEY);
  } catch (error) {
    Logger.globalInstance.warn('callerModelList: entitlement read failed; listing free-tier models only', { error });
    return false;
  }
}

/**
 * Same free-tier rule createModelAdmission refuses at call time (llm/modelAdmission.ts), applied after the
 * cache so a plan change or a gate toggle shows on the next load. Paid-only models move from `models` to
 * `lockedModels`. An anonymous caller is left unfiltered: it cannot call a model, so this list is not a gate
 * for it. A failed allowlist read also lists unfiltered: the picker is not the gate, call-time admission
 * still enforces.
 */
async function withoutPaidOnlyModels(list: CatalogModelList, user: IUserDocument | null): Promise<CallerModelList> {
  const unfiltered = { ...list, lockedModels: [] };
  if (!user || isFreeTierExempt(user)) return unfiltered;
  let allowedModels: ReadonlySet<string> | undefined;
  try {
    allowedModels = await loadFreeTierAllowedModels(adminSettingsRepository);
  } catch (error) {
    Logger.globalInstance.warn('callerModelList: free-tier allowlist read failed; listing unfiltered', { error });
    return unfiltered;
  }
  if (!allowedModels) return unfiltered;
  if (await holdsPaidPlan(user)) return unfiltered;
  const models: ModelInfo[] = [];
  const lockedModels: ModelInfo[] = [];
  for (const model of list.models) {
    if (isFreeTierModel(model.id, allowedModels)) models.push(model);
    else lockedModels.push({ ...model, access: PAID_PLAN_LOCK });
  }
  const offeredIds = new Set<string>(models.map(model => model.id));
  // An upgrade offer pointing at a paid-only model would only lead to a refusal.
  return {
    models,
    supersededModels: list.supersededModels.filter(entry => offeredIds.has(entry.replacementId)),
    lockedModels,
  };
}

/**
 * The model for a request that names none: a free account whose default is paid-only starts on the first allowlisted
 * text model (admin order) that admission accepts. Read failures propagate, as they do at call time.
 */
export async function resolveCallerDefaultModel(
  defaultModel: string,
  user: IUserDocument,
  logger: { log: (message: string) => void }
): Promise<string> {
  if (isFreeTierExempt(user)) return defaultModel;
  const allowedModels = await loadFreeTierAllowedModels(adminSettingsRepository);
  if (!allowedModels || allowedModels.has(defaultModel)) return defaultModel;
  const entitlements = await getUserEntitlements(toEntitlementUser(user));
  if (entitlements.includes(PAID_PLAN_ENTITLEMENT_KEY)) return defaultModel;
  const { models } = await getCachedCallerModelList(user.id, logger);
  const admission = createModelAdmission({
    user,
    configs: await loadModelConfigurations(adminSettingsRepository),
    getEntitlements: async () => entitlements,
    models,
    freeTierAllowedModels: allowedModels,
  });
  for (const id of allowedModels) {
    if (models.some(model => model.id === id && model.type === 'text') && (await admission.admits(id))) return id;
  }
  return defaultModel;
}

export async function getCallerModelList(
  user: IUserDocument | null,
  logger: { log: (message: string) => void }
): Promise<CallerModelList> {
  return withoutPaidOnlyModels(await getCachedCallerModelList(user?.id ?? null, logger), user);
}

async function getCachedCallerModelList(
  userId: string | null,
  logger: { log: (message: string) => void }
): Promise<CatalogModelList> {
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { names: ['enforceCredits'] });
  const enforceCredits = Boolean(getSettingsValue('enforceCredits', settings));
  // The flag is in the key so toggling enforceCredits takes effect immediately, not after the TTL.
  const cacheKey = `${CacheKeys.modelList(userId ?? ANONYMOUS_CACHE_ID)}:credits-${enforceCredits ? 'on' : 'off'}`;

  const cached = await cacheRepository.findOne({ key: cacheKey });
  if (cached) {
    logger.log(`Cache hit for key: ${cacheKey}`);
    return cached.result as CatalogModelList;
  }

  logger.log(`Cache miss for key: ${cacheKey}`);
  const payload = await buildCallerModelList(userId, enforceCredits);

  // Don't cache an empty result. If every backend timed out (network blip, all
  // providers slow at once), caching `{ models: [] }` for 60s would hide healthy
  // backends from the next request until expiry.
  //
  // INVARIANT: this function is the only writer of `model-list:*`. The entries
  // are per-caller views built from that caller's keys, so background jobs (model
  // discovery included) must bust these keys, never populate them.
  if (payload.models.length > 0) {
    await cacheRepository.createOrUpdate({
      key: cacheKey,
      result: payload,
      expiresAt: new Date(Date.now() + MODELS_CACHE_TTL_MS),
    });
  }

  return payload;
}
