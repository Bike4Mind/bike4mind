import { z } from 'zod';
import {
  ADMIN_MODEL_SORTS,
  AdminModelFilterSchema,
  bedrockClientCredentials,
  type AdminModelRow,
  type LLMModelConfig,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  apiKeyRepository,
  modelCatalogRepository,
  modelDiscoveryStateRepository,
  modelPriceRepository,
} from '@bike4mind/database';
import { buildApiKeyTable, isBackendUsable, staticAdapterModels } from '@bike4mind/llm-adapters';
import { apiKeyService, modelDiscoveryService } from '@bike4mind/services';
import { loadFreeTierAllowedModels } from '@bike4mind/services/llm/modelAdmission';
import { BASE_ENTITLEMENT_KEY } from '@bike4mind/server-utils/lib/entitlements/registry';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { getSettingsByNames } from '@bike4mind/utils';
import { isCreditsEnforced } from '@server/billing/meterPlatformCompletion';

/**
 * Every model this server knows, with its status and reasons, for GET /api/admin/models and the bulk access
 * `{ filter }` selection. Reads the stores directly and adapter literals with no egress: never the
 * getAvailableModels cache, so an admin sees a write on the next fetch.
 */
export async function loadAdminModelRows(now: Date = new Date()): Promise<AdminModelRow[]> {
  const [
    adapterModels,
    catalogRows,
    priceRows,
    accessSetting,
    pendingSuggestions,
    discoveryMilestones,
    platformKeys,
    enforceCredits,
    freeTierAllowedModels,
  ] = await Promise.all([
    staticAdapterModels(),
    modelCatalogRepository.rowsInForce(now),
    modelPriceRepository.rowsInForce(now),
    // Read directly: loadModelConfigurations fails open to [], which would show every model as unrestricted.
    adminSettingsRepository.findOne({ settingName: 'llmModelConfigurations' }),
    modelDiscoveryStateRepository.pendingSuggestions(),
    modelCatalogRepository.discoveryMilestones(),
    apiKeyService.getEffectiveLLMApiKeys(
      null,
      { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames },
      { skipCache: true }
    ),
    isCreditsEnforced(),
    loadFreeTierAllowedModels(adminSettingsRepository),
  ]);
  const gate = {
    apiKeys: buildApiKeyTable(platformKeys),
    isSelfHost: process.env.B4M_SELF_HOST === 'true',
    bedrockReachable: bedrockClientCredentials() !== null,
  };
  const accessEntries = Array.isArray(accessSetting?.settingValue)
    ? (accessSetting.settingValue as LLMModelConfig[])
    : [];

  return modelDiscoveryService.buildAdminModelRows({
    adapterModels,
    catalogRows,
    priceRows,
    accessEntries,
    pendingSuggestions,
    discoveryMilestones,
    isBackendKeyed: backend => isBackendUsable(backend, gate),
    enforceCredits,
    freeTierAllowedModels,
    baseEntitlementKey: BASE_ENTITLEMENT_KEY,
    now,
  });
}

/** A list parameter: repeated (`?types=a&types=b`) or comma-separated (`?types=a,b`). */
const listParam = z.preprocess(
  value =>
    value === undefined
      ? undefined
      : (Array.isArray(value) ? value : [value])
          .flatMap(item => String(item).split(','))
          .map(item => item.trim())
          .filter(item => item.length > 0),
  z.array(z.string()).optional()
);

const booleanParam = z.enum(['true', 'false', '1', '0']).transform(value => value === 'true' || value === '1');
const positiveInt = z.coerce.number().int().positive();

// Single-valued parameters reject a repeated value (an array) rather than pick one of them.
const ListQuerySchema = z.object({
  view: z.string().optional(),
  search: z.string().optional(),
  providers: listParam,
  types: listParam,
  sources: listParam,
  showFoundationIds: booleanParam.optional(),
  sort: z.enum(ADMIN_MODEL_SORTS).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  page: positiveInt.optional(),
  pageSize: positiveInt.max(modelDiscoveryService.ADMIN_MODEL_PAGE_SIZE_MAX).optional(),
});

/** GET /api/admin/models query string to a list query; 400 on anything it cannot read. */
export function parseAdminModelListQuery(
  query: Record<string, string | string[] | undefined>
): modelDiscoveryService.AdminModelListQuery {
  const parsed = ListQuerySchema.safeParse(query);
  if (!parsed.success) throw new BadRequestError(describeIssue(parsed.error));
  const { sort, dir, page, pageSize, ...filterFields } = parsed.data;
  const filter = AdminModelFilterSchema.safeParse(
    Object.fromEntries(Object.entries(filterFields).filter(([, value]) => value !== undefined))
  );
  if (!filter.success) throw new BadRequestError(describeIssue(filter.error));
  return { filter: filter.data, sort, dir, page, pageSize };
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid model list query';
  return issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}
