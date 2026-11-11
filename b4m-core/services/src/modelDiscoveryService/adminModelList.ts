import {
  ADMIN_MODEL_NEEDS_REVIEW_REASONS,
  ADMIN_MODEL_REASON_CODES,
  ADMIN_MODEL_RETIRING_HORIZON_DAYS,
  ADMIN_MODEL_STATUSES,
  ADMIN_MODEL_VIEWS,
  AdminModelFilterSchema,
  DISCOVERY_VERDICT_PREFIX,
  LIFECYCLE_SUNSET_STATUSES,
  ModelBackend,
  PRICE_ROW_BILLED_MODEL_TYPES,
  RETIRED_BY_PROVIDER_REASON,
  applyModelPriceCatalog,
  billableRealtimeVoiceTier,
  hasAdminRank,
  isDiscoveryVerdict,
  normalizeEntitlementKey,
  pickerProviderGroup,
  provisionalRank,
  resolveModelPriceRow,
  type AdminModelAccess,
  type AdminModelFilter,
  type AdminModelLifecycle,
  type AdminModelListResponse,
  type AdminModelPrice,
  type AdminModelReason,
  type AdminModelReasonCode,
  type AdminModelRow,
  type AdminModelSort,
  type AdminModelStatus,
  type AdminModelView,
  type DiscoveryRunMode,
  type IModelCatalogRow,
  type IModelDiscoveryState,
  type IModelPrice,
  type IModelPriceTier,
  type LLMModelConfig,
  type ModelInfo,
  type ResolvedAdminModelFilter,
} from '@bike4mind/common';
import {
  REALTIME_VOICE_PRICING,
  alignRouteTwinNames,
  isBackendUsable,
  mergeCatalogWithDrops,
  resolveCatalogRecords,
  type ApiKeyTable,
  type BackendGateContext,
} from '@bike4mind/llm-adapters';
import { isFreeTierModel, isUnpricedTextModel, type FreeTierAllowedModels } from '../llm/modelAdmission';
import {
  AWAITING_APPROVAL_REASON,
  AWAITING_PRICE_REASON,
  LEGACY_PRICED_IN_BUILD_REASON,
  NOT_INVOCABLE_REASON,
  PRICED_IN_BUILD_REASON,
  UNCORROBORATED_PRICE_REASON,
} from './promotion';
import { BEDROCK_NOT_ENTITLED_REASON, BEDROCK_NOT_ON_DEMAND_REASON } from './sources/bedrock';

/** 'off' while enableModelDiscovery is false, else modelDiscoveryMode: only a write-mode run promotes a model. */
export type AdminDiscoveryRunMode = DiscoveryRunMode | 'off';

/** Everything the admin model list reads, already loaded: it never calls a provider or the getAvailableModels cache. */
export interface AdminModelListInput {
  /** staticAdapterModels(): the adapter literals, read with no key and no network. */
  adapterModels: readonly ModelInfo[];
  catalogRows: IModelCatalogRow[];
  priceRows: IModelPrice[];
  /** The llmModelConfigurations entries. */
  accessEntries: readonly LLMModelConfig[];
  /** Unresolved lifecycle suggestions. */
  pendingSuggestions: readonly Pick<IModelDiscoveryState, 'modelId' | 'suggestion'>[];
  /** Per model, its first discovery row and the first discovery row that made it active. */
  discoveryMilestones: ReadonlyMap<string, { firstSeenAt: Date; activatedAt?: Date }>;
  /** Whether this environment holds a credential for the backend. */
  isBackendKeyed: (backend: string) => boolean;
  enforceCredits: boolean;
  /** Undefined while the free-tier gate is off. */
  freeTierAllowedModels?: FreeTierAllowedModels;
  /** The entitlement every signed-in user holds (BASE_ENTITLEMENT_KEY in server-utils). */
  baseEntitlementKey: string;
  discoveryRunMode: AdminDiscoveryRunMode;
  /** B4M_SELF_HOST: the picker gives self-hosted backends their own section. */
  isSelfHost?: boolean;
  now?: Date;
}

/**
 * Lists every backend this build can list as keyed, so the merge withholds no catalog-only model for want of a key.
 * Key presence is reported per model instead, as its own reason.
 */
const EVERY_BACKEND_KEYED: BackendGateContext = {
  apiKeys: Object.fromEntries(Object.values(ModelBackend).map(backend => [backend, 'admin-model-list'])) as ApiKeyTable,
  isSelfHost: false,
  bedrockReachable: true,
};

const BACKEND_LABEL: Readonly<Record<ModelBackend, string>> = {
  [ModelBackend.OpenAI]: 'OpenAI',
  [ModelBackend.Bedrock]: 'Bedrock',
  [ModelBackend.Anthropic]: 'Anthropic',
  [ModelBackend.Gemini]: 'Gemini',
  [ModelBackend.Ollama]: 'Ollama',
  [ModelBackend.OpenAICompatible]: 'OpenAI-compatible',
  [ModelBackend.BFL]: 'Black Forest Labs',
  [ModelBackend.XAI]: 'xAI',
  [ModelBackend.Kimi]: 'Moonshot',
  [ModelBackend.DeepSeek]: 'DeepSeek',
  [ModelBackend.VoyageAI]: 'Voyage AI',
  [ModelBackend.LocalImage]: 'Local image',
  [ModelBackend.AWS]: 'AWS',
};

const backendLabel = (backend: string): string =>
  Object.hasOwn(BACKEND_LABEL, backend) ? BACKEND_LABEL[backend as ModelBackend] : backend;

const REASON_ORDER = new Map<AdminModelReasonCode, number>(
  ADMIN_MODEL_REASON_CODES.map((code, index) => [code, index])
);

const reason = (
  code: AdminModelReasonCode,
  message: string,
  extra: Pick<AdminModelReason, 'fixAction' | 'detail'> = {}
): AdminModelReason => ({ code, message, ...extra });

const NO_PRICE_NEW = (): AdminModelReason =>
  reason('price-none', 'No price yet. New models list once they have a price.', { fixAction: 'add-price' });

const noRequestProfile = (backend: string, mode: AdminDiscoveryRunMode, detail?: string): AdminModelReason =>
  reason('not-callable', 'We cannot call this model yet: no request profile for it', {
    // A write-mode probe can find an OpenAI id's request profile; any other gap needs an engineer.
    ...(backend === ModelBackend.OpenAI && mode === 'write' ? { fixAction: 'run-discovery' as const } : {}),
    ...(detail ? { detail } : {}),
  });

/** A blocker cleared since the run that recorded it: the model waits for a run that can promote it. */
function awaitingRun(lead: string, mode: AdminDiscoveryRunMode): AdminModelReason {
  switch (mode) {
    case 'write':
      return reason('awaiting-discovery-run', `${lead}. It lists on the next discovery run.`, {
        fixAction: 'run-discovery',
      });
    case 'report':
      return reason(
        'awaiting-discovery-run',
        `${lead}. Discovery only reports right now, so it lists after a run in write mode.`
      );
    case 'off':
      return reason(
        'awaiting-discovery-run',
        `${lead}. Model discovery is off, so it lists after a run in write mode.`
      );
  }
}

/** A catalog-only model the merge dropped (llm-adapters mergeCatalog.ts), in the admin's words. */
function dropReason(drop: string, backend: string, mode: AdminDiscoveryRunMode): AdminModelReason {
  if (drop === 'no adapterFamily' || drop === 'no dispatchProfile') return noRequestProfile(backend, mode, drop);
  if (/^incomplete record: missing .*\bcontextWindow\b/.test(drop)) {
    return reason('missing-context-window', "We do not know this model's context window yet");
  }
  const notOffered = (message: string) => reason('not-callable', message, { detail: drop });
  const lifecycle = /^lifecycle status "(.*)" is not invocable$/.exec(drop);
  if (lifecycle) {
    return notOffered(
      lifecycle[1] === 'unset'
        ? 'Not offered: its catalog record has no lifecycle status'
        : `Not offered while its catalog lifecycle status is "${lifecycle[1]}"`
    );
  }
  const missing = /^incomplete record: missing (.*)$/.exec(drop);
  if (missing) return notOffered(`Its catalog record is missing ${missing[1]}`);
  const family = /^adapterFamily "(.*)" is not dispatchable by this build$/.exec(drop);
  if (family) return notOffered(`This build has no request client for the "${family[1]}" family`);
  if (drop.startsWith('needs a dedicated API')) {
    return notOffered('It needs a dedicated API or a mandatory tool, so it cannot be offered as a text model');
  }
  const unknownBackend = /^unknown backend "(.*)"$/.exec(drop);
  if (unknownBackend) return notOffered(`This build does not know the provider "${unknownBackend[1]}"`);
  const type = /^unsupported model type "(.*)"$/.exec(drop);
  if (type) return notOffered(`This build cannot list ${type[1]} models`);
  return notOffered(`This build cannot offer it: ${drop}`);
}

const noCredential = (backend: string): AdminModelReason =>
  reason('no-credential-for-backend', `No ${backendLabel(backend)} key is configured in this environment`, {
    fixAction: 'open-key-settings',
  });

/**
 * The reasons behind a stored disable text: the reason promotion or a source wrote on the catalog row
 * (promotion.ts, sources/bedrock.ts). Unknown text shows verbatim as a provider disable.
 */
export function adminReasonsFromDisableText(
  text: string | undefined,
  backend: string,
  mode: AdminDiscoveryRunMode
): AdminModelReason[] {
  if (!text) return [];
  switch (text) {
    case AWAITING_PRICE_REASON:
      return [NO_PRICE_NEW()];
    case UNCORROBORATED_PRICE_REASON:
      return [reason('price-aggregator-quote', 'Price found from one source only', { fixAction: 'add-price' })];
    case PRICED_IN_BUILD_REASON:
    case LEGACY_PRICED_IN_BUILD_REASON:
      return [reason('price-no-build-literal', "No price in this build's model tables")];
    case AWAITING_APPROVAL_REASON:
      return [reason('manual-approval-required', 'Waiting for your approval')];
    case NOT_INVOCABLE_REASON:
      return [noRequestProfile(backend, mode)];
    case BEDROCK_NOT_ON_DEMAND_REASON:
      return [reason('source-not-on-demand', 'Bedrock serves this model only through an inference profile')];
    case BEDROCK_NOT_ENTITLED_REASON:
      return [reason('source-not-entitled', 'This account is not entitled to this model')];
  }
  if (
    isDiscoveryVerdict(text) &&
    text.slice(DISCOVERY_VERDICT_PREFIX.length).split(', ').includes('no-credential-for-backend')
  ) {
    return [noCredential(backend)];
  }
  return [reason('source-disabled', `The provider lists it as unavailable: ${text}`, { detail: text })];
}

/** For a model known to be disabled: a missing text still has to keep it off the Listed view. */
function disabledReasons(text: string | undefined, backend: string, mode: AdminDiscoveryRunMode): AdminModelReason[] {
  const mapped = adminReasonsFromDisableText(text, backend, mode);
  return mapped.length > 0 ? mapped : [reason('source-disabled', 'Disabled, with no reason recorded')];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from today (UTC) to a YYYY-MM-DD date; zero or less means the date has arrived. */
function daysUntil(calendarDate: string | undefined, now: Date): number | undefined {
  if (!calendarDate) return undefined;
  const at = Date.parse(`${calendarDate}T00:00:00Z`);
  if (Number.isNaN(at)) return undefined;
  return Math.round((at - Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)) / DAY_MS);
}

/** The sooner of a lifecycle's deprecation and retirement dates, and whole days to it. */
function sunsetOf(lifecycle: AdminModelLifecycle, now: Date): Pick<AdminModelRow, 'sunsetDate' | 'sunsetDays'> {
  let soonest: { date: string; days: number } | undefined;
  for (const date of [lifecycle.deprecationDate, lifecycle.retirementDate]) {
    const days = daysUntil(date, now);
    if (date && days !== undefined && (!soonest || days < soonest.days)) soonest = { date, days };
  }
  return { sunsetDate: soonest?.date ?? null, sunsetDays: soonest?.days ?? null };
}

/**
 * In the retiring window by lifecycle facts alone: a deprecated or retired lifecycle status, or a deprecation or
 * retirement date within ADMIN_MODEL_RETIRING_HORIZON_DAYS or already past. Both the Retiring status and the Retiring
 * view read it.
 */
const inRetiringWindow = (row: Pick<AdminModelRow, 'lifecycle' | 'sunsetDays'>): boolean =>
  row.lifecycle.status === 'deprecated' ||
  row.lifecycle.status === 'retired' ||
  (row.sunsetDays !== null && row.sunsetDays <= ADMIN_MODEL_RETIRING_HORIZON_DAYS);

/** The display fields of a catalog-only record no ModelInfo was rendered for. */
interface DisplayModel {
  id: string;
  name: string;
  type: string;
  backend: string;
  vendor?: string;
  description?: string;
  contextWindow?: number;
  releaseDate?: string;
  private: boolean;
  freeToRun: boolean;
  rank?: number;
}

function displayOf(id: string, served: ModelInfo | undefined, draft: Record<string, unknown>): DisplayModel {
  if (served) {
    return {
      id,
      name: served.name,
      type: served.type,
      backend: served.backend,
      vendor: str(draft.vendor),
      description: served.description,
      contextWindow: served.contextWindow,
      releaseDate: served.releaseDate,
      private: served.private === true,
      freeToRun: served.freeToRun === true,
      rank: served.rank,
    };
  }
  return {
    id,
    name: str(draft.name) ?? id,
    type: str(draft.type) ?? 'unknown',
    backend: str(draft.backend) ?? 'unknown',
    vendor: str(draft.vendor),
    description: str(draft.description),
    contextWindow: num(draft.contextWindow),
    releaseDate: str(draft.releaseDate),
    private: draft.private === true,
    freeToRun: draft.freeToRun === true,
    rank: num(draft.rank),
  };
}

function priceRow(row: IModelPrice): AdminModelPrice {
  return {
    source: 'row',
    unit: row.unit,
    pricing: row.pricing,
    effectiveFrom: row.effectiveFrom.toISOString(),
    ...(row.note ? { note: row.note } : {}),
    ...(row.id ? { rowId: row.id } : {}),
  };
}

/** The price that bills the model: its per-token row where rows bill its type, else its build literal. */
function priceOf(
  id: string,
  type: string,
  adapter: ModelInfo | undefined,
  priceRows: IModelPrice[],
  now: Date
): AdminModelPrice | null {
  const row = PRICE_ROW_BILLED_MODEL_TYPES.has(type)
    ? resolveModelPriceRow(priceRows, id, 'per_token', now)
    : undefined;
  if (type === 'realtime-voice') {
    // As voice settlement reads it (pickRealtimeVoiceTier): a row without audio rates yields to the literal.
    if (row && billableRealtimeVoiceTier(row.pricing)) return priceRow(row);
    const literal = Object.hasOwn(REALTIME_VOICE_PRICING, id) ? REALTIME_VOICE_PRICING[id] : undefined;
    return literal ? { source: 'build', pricing: { '0': literal } } : null;
  }
  if (row) return priceRow(row);
  if (!adapter || adapter.freeToRun || Object.keys(adapter.pricing).length === 0) return null;
  const pricing: Record<string, IModelPriceTier> = {};
  for (const [threshold, tier] of Object.entries(adapter.pricing)) pricing[threshold] = tier;
  return { source: 'build', pricing };
}

const hasPricedTier = (price: AdminModelPrice | null): boolean =>
  price !== null && Object.values(price.pricing).some(tier => tier.input > 0 || tier.output > 0);

/** The newest disable text a non-operator row wrote, under an operator row that owns the availability group. */
function sourceDisableText(bucket: readonly IModelCatalogRow[]): string | undefined {
  let newest: { at: Date; text: string } | undefined;
  for (const row of bucket) {
    if (row.source === 'operator' || !row.ownedGroups.includes('availability')) continue;
    const text = str(row.patch.autoDisabledReason) ?? str(row.patch.disabledReason);
    if (text && (!newest || row.effectiveFrom > newest.at)) newest = { at: row.effectiveFrom, text };
  }
  return newest?.text;
}

/** The operator row winning a group: operator rows outrank every other source, the newest of them wins. */
function operatorWinner(bucket: readonly IModelCatalogRow[], group: string): IModelCatalogRow | undefined {
  let winner: IModelCatalogRow | undefined;
  for (const row of bucket) {
    if (row.source !== 'operator' || !row.ownedGroups.includes(group)) continue;
    if (!winner || row.effectiveFrom > winner.effectiveFrom) winner = row;
  }
  return winner;
}

/** What the web picker offers: served, and blocked by nothing an admin has to clear first. */
const offeredInPicker = (row: AdminModelRow): boolean =>
  row.status === 'listed' ||
  row.status === 'limited' ||
  row.status === 'retiring' ||
  (row.status === 'needs-review' && row.reasons.every(entry => entry.code === 'lifecycle-suggestion'));

function sortReasons(reasons: AdminModelReason[]): AdminModelReason[] {
  const seen = new Set<AdminModelReasonCode>();
  return reasons
    .filter(entry => (seen.has(entry.code) ? false : (seen.add(entry.code), true)))
    .sort((a, b) => (REASON_ORDER.get(a.code) ?? 0) - (REASON_ORDER.get(b.code) ?? 0));
}

/**
 * Every model this server knows, from adapter literals and catalog rows, with its status and the reasons behind it.
 * Seeded and invocable catalog-only models are merged exactly as getAvailableModels merges them; the rest are rendered
 * from their resolved catalog record.
 */
export async function buildAdminModelRows(input: AdminModelListInput): Promise<AdminModelRow[]> {
  const now = input.now ?? new Date();
  const mode = input.discoveryRunMode;
  const adapterModels = [...input.adapterModels];
  const { models, dropped } = mergeCatalogWithDrops(adapterModels, input.catalogRows, EVERY_BACKEND_KEYED);
  const served = applyModelPriceCatalog(await alignRouteTwinNames(models), input.priceRows, now);
  const servedById = new Map(served.map(model => [String(model.id), model]));
  const adapterById = new Map(adapterModels.map(model => [String(model.id), model]));
  const resolved = resolveCatalogRecords(input.catalogRows);
  const dropReasons = new Map<string, string>();
  for (const drop of dropped) if (!servedById.has(drop.modelId)) dropReasons.set(drop.modelId, drop.reason);

  const rowsByModel = new Map<string, IModelCatalogRow[]>();
  for (const row of input.catalogRows) {
    const bucket = rowsByModel.get(row.modelId);
    if (bucket) bucket.push(row);
    else rowsByModel.set(row.modelId, [row]);
  }
  const entries = new Map(input.accessEntries.map(entry => [String(entry.id), entry]));
  const suggestions = new Map(input.pendingSuggestions.map(state => [state.modelId, state.suggestion]));
  const ids = [...new Set([...adapterById.keys(), ...resolved.keys()])];

  const displays = new Map(ids.map(id => [id, displayOf(id, servedById.get(id), resolved.get(id)?.record ?? {})]));
  const savedRank = (id: string): number | undefined => {
    const entry = entries.get(id);
    return entry && hasAdminRank(entry) ? entry.rank : undefined;
  };

  const rows = ids.map((id): AdminModelRow => {
    const display = displays.get(id) as DisplayModel;
    const servedModel = servedById.get(id);
    const adapter = adapterById.get(id);
    const draft = resolved.get(id)?.record ?? {};
    const bucket = rowsByModel.get(id) ?? [];
    const entry = entries.get(id);
    const reasons: AdminModelReason[] = [];

    const catalogLifecycle = isRecord(draft.lifecycle) ? draft.lifecycle : {};
    const catalogStatus = str(catalogLifecycle.status);
    // A served seeded model's own rows read 'discovered' before the merge folds in its adapter literal.
    const status =
      servedModel && (catalogStatus === undefined || catalogStatus === 'discovered') ? 'active' : catalogStatus;
    const lifecycle: AdminModelLifecycle = {
      ...(status ? { status } : {}),
      ...((servedModel?.deprecationDate ?? str(catalogLifecycle.deprecationDate))
        ? { deprecationDate: servedModel?.deprecationDate ?? str(catalogLifecycle.deprecationDate) }
        : {}),
      ...(str(catalogLifecycle.retirementDate) ? { retirementDate: str(catalogLifecycle.retirementDate) } : {}),
      ...((servedModel?.replacedBy ?? str(catalogLifecycle.replacedBy))
        ? { replacedBy: servedModel?.replacedBy ?? str(catalogLifecycle.replacedBy) }
        : {}),
    };

    // updatedAt is not on LLMModelConfig: entries carry it once the access write stamps it.
    const entrySavedAt = entry ? toDate((entry as { updatedAt?: unknown }).updatedAt) : undefined;
    if (entry && entry.enabled === false) {
      const activatedAt = input.discoveryMilestones.get(id)?.activatedAt;
      reasons.push(
        entrySavedAt && activatedAt && entrySavedAt.getTime() < activatedAt.getTime()
          ? reason('admin-off-before-promotion', 'Turned off by an older bulk save, before it was ready', {
              fixAction: 'turn-on',
            })
          : reason('admin-off', 'Turned off by an admin', { fixAction: 'turn-on' })
      );
    }

    // An operator row owns the whole availability group, so the resolved disable fields are the operator's.
    const operatorAvailability = operatorWinner(bucket, 'availability');
    const operatorDisabled = operatorAvailability?.patch.disabled === true;
    if (operatorAvailability && operatorDisabled) {
      const why = str(operatorAvailability.patch.disabledReason);
      reasons.push(reason('operator-disabled', why ? `Disabled: ${why}` : 'Disabled by an admin'));
    }

    // toModelInfo folds a 'retired' lifecycle into disabled: a disable from that fold alone is the retirement itself.
    const retiredByProvider =
      servedModel?.disabled === true &&
      status === 'retired' &&
      !operatorDisabled &&
      servedModel.disabledReason === RETIRED_BY_PROVIDER_REASON;

    if (servedModel) {
      if (servedModel.disabled && !operatorDisabled && !retiredByProvider) {
        if (adapter?.disabled && servedModel.disabledReason === adapter.disabledReason) {
          reasons.push(
            reason(
              'build-disabled',
              adapter.disabledReason ? `Disabled in this build: ${adapter.disabledReason}` : 'Disabled in this build'
            )
          );
        } else {
          reasons.push(...disabledReasons(servedModel.disabledReason, display.backend, mode));
        }
      }
      if (input.enforceCredits && isUnpricedTextModel(servedModel)) {
        reasons.push(
          reason('price-missing', 'No price yet. Text models need a price while credits are enforced.', {
            fixAction: 'add-price',
          })
        );
      }
    } else if (catalogStatus === 'discovered') {
      const stored = adminReasonsFromDisableText(
        operatorAvailability ? sourceDisableText(bucket) : (str(draft.autoDisabledReason) ?? str(draft.disabledReason)),
        display.backend,
        mode
      );
      if (stored.length > 0) reasons.push(...stored);
      else if (!operatorDisabled)
        reasons.push(reason('not-callable', 'Discovered, and no run has recorded why it is held'));
    } else if (!LIFECYCLE_SUNSET_STATUSES.has(catalogStatus ?? '')) {
      const drop = dropReasons.get(id);
      if (!operatorAvailability && (draft.autoDisabled === true || draft.disabled === true)) {
        reasons.push(
          ...disabledReasons(str(draft.disabledReason) ?? str(draft.autoDisabledReason), display.backend, mode)
        );
      }
      if (drop) {
        reasons.push(dropReason(drop, display.backend, mode));
      } else if (!isBackendUsable(display.backend, EVERY_BACKEND_KEYED)) {
        reasons.push(reason('not-callable', `This build cannot list ${backendLabel(display.backend)} models`));
      }
    }

    const keyPresent = input.isBackendKeyed(display.backend);
    const price = priceOf(id, display.type, adapter, input.priceRows, now);
    // Priced or keyed since the run that blocked it: the stored wording is stale until a run promotes it.
    if (display.type === 'text' && price?.source === 'row' && hasPricedTier(price)) {
      const stale = reasons.findIndex(entry => entry.code === 'price-none' || entry.code === 'price-aggregator-quote');
      if (stale >= 0) reasons.splice(stale, 1, awaitingRun('Priced', mode));
    }
    if (keyPresent) {
      const stale = reasons.findIndex(entry => entry.code === 'no-credential-for-backend');
      if (stale >= 0) reasons.splice(stale, 1, awaitingRun(`${backendLabel(display.backend)} key configured`, mode));
    }

    const suggestion = suggestions.get(id);
    if (suggestion && !suggestion.resolution) {
      reasons.push(
        reason(
          'lifecycle-suggestion',
          suggestion.status
            ? `Provider marked it ${suggestion.status}`
            : suggestion.replacedBy
              ? `Provider named a replacement: ${suggestion.replacedBy}`
              : 'Provider changed its lifecycle',
          { fixAction: 'review-lifecycle', ...(suggestion.detail ? { detail: suggestion.detail } : {}) }
        )
      );
    }

    if (!keyPresent && isBackendUsable(display.backend, EVERY_BACKEND_KEYED))
      reasons.push(noCredential(display.backend));
    if (display.private) reasons.push(reason('private', 'Private model'));

    const sorted = sortReasons(reasons);
    const allowedEntitlements = entry?.allowedEntitlements ?? [];
    const allowedUserTags = entry?.allowedUserTags ?? [];
    const access: AdminModelAccess = {
      entry: entry
        ? {
            enabled: entry.enabled !== false,
            allowedUserTags,
            allowedEntitlements,
            ...(entry.fallbackModel ? { fallbackModel: entry.fallbackModel } : {}),
            ...(hasAdminRank(entry) ? { rank: entry.rank } : {}),
            ...(entrySavedAt ? { updatedAt: entrySavedAt.toISOString() } : {}),
          }
        : null,
      everyone:
        !entry ||
        allowedEntitlements.some(
          key => normalizeEntitlementKey(key) === normalizeEntitlementKey(input.baseEntitlementKey)
        ),
      adminsOnly:
        !!entry && entry.enabled !== false && allowedUserTags.length === 0 && allowedEntitlements.length === 0,
      freeTierLocked:
        input.freeTierAllowedModels !== undefined &&
        !isFreeTierModel(id, input.freeTierAllowedModels, { type: display.type as ModelInfo['type'] }),
    };

    const deprecationDays = daysUntil(lifecycle.deprecationDate, now);
    const sunset = sunsetOf(lifecycle, now);
    // Retired means no user can pick it for its lifecycle: getAvailableModels drops a model from its deprecationDate
    // (same UTC day boundary as isModelDeprecated), the catalog's retired fold disables it, and the merge never
    // serves a catalog-only model in a sunset status.
    const retired =
      (deprecationDays !== undefined && deprecationDays <= 0) ||
      retiredByProvider ||
      (!servedModel && LIFECYCLE_SUNSET_STATUSES.has(status ?? ''));
    const retiring = inRetiringWindow({ lifecycle, ...sunset });
    const limited = !access.everyone || access.freeTierLocked;

    let modelStatus: AdminModelStatus;
    if (retired) modelStatus = 'retired';
    else if (sorted.some(entry => !ADMIN_MODEL_NEEDS_REVIEW_REASONS.has(entry.code))) modelStatus = 'hidden';
    else if (sorted.length > 0) modelStatus = 'needs-review';
    else if (retiring) modelStatus = 'retiring';
    else if (limited) modelStatus = 'limited';
    else modelStatus = 'listed';

    // The web picker reads the saved access entry's rank over the catalog's.
    const setRank = savedRank(id) ?? (hasAdminRank(display) ? display.rank : undefined);
    const sources = new Set(bucket.map(row => row.source));
    const firstSeenAt = input.discoveryMilestones.get(id)?.firstSeenAt;

    return {
      id,
      name: display.name,
      type: display.type,
      backend: display.backend,
      ...(display.vendor ? { vendor: display.vendor } : {}),
      ...(display.description ? { description: display.description } : {}),
      ...(display.contextWindow !== undefined ? { contextWindow: display.contextWindow } : {}),
      ...(display.releaseDate ? { releaseDate: display.releaseDate } : {}),
      private: display.private,
      freeToRun: display.freeToRun,
      status: modelStatus,
      reasons: sorted,
      rank: setRank ?? null,
      rankProvisional: setRank === undefined,
      origin: adapter || sources.has('seed') ? 'default' : sources.has('discovery') ? 'discovered' : 'admin',
      adminEdited: sources.has('operator'),
      keyPresent,
      access,
      price,
      lifecycle,
      ...sunset,
      lifecycleSuggestion:
        suggestion && !suggestion.resolution
          ? {
              ...(suggestion.status ? { status: suggestion.status } : {}),
              ...(suggestion.deprecationDate ? { deprecationDate: suggestion.deprecationDate } : {}),
              ...(suggestion.retirementDate ? { retirementDate: suggestion.retirementDate } : {}),
              ...(suggestion.replacedBy ? { replacedBy: suggestion.replacedBy } : {}),
              source: suggestion.source,
              ...(suggestion.detail ? { detail: suggestion.detail } : {}),
              suggestedAt: suggestion.suggestedAt.toISOString(),
            }
          : null,
      firstSeenAt: firstSeenAt ? firstSeenAt.toISOString() : null,
      profileOnlyFoundation: sorted.some(entry => entry.code === 'source-not-on-demand'),
    };
  });

  // Approximates the picker's provisional rank (ModelSelection.tsx, sortModelsForPicker) over each section's offered
  // models. The picker first dedupes twins per viewer (dedupeModelsForPicker), which this list cannot know.
  const sections = new Map<string, AdminModelRow[]>();
  for (const row of rows) {
    if (!offeredInPicker(row)) continue;
    const key = pickerProviderGroup(row, input.isSelfHost === true);
    const section = sections.get(key);
    if (section) section.push(row);
    else sections.set(key, [row]);
  }
  for (const section of sections.values()) {
    const rankables = section.map(row => ({ row, type: row.type, name: row.name, rank: row.rank ?? undefined }));
    for (const rankable of rankables) {
      if (rankable.row.rankProvisional) rankable.row.rank = provisionalRank(rankable, rankables);
    }
  }
  return rows;
}

const VIEW_STATUSES: Readonly<Record<AdminModelView, ReadonlySet<AdminModelStatus> | null>> = {
  all: null,
  'needs-review': new Set(['needs-review']),
  listed: new Set(['listed', 'limited']),
  hidden: new Set(['hidden']),
  retiring: new Set(['retiring', 'retired']),
};

function matchesFacets(row: AdminModelRow, filter: ResolvedAdminModelFilter): boolean {
  if (filter.search) {
    const needle = filter.search.toLowerCase();
    if (!row.id.toLowerCase().includes(needle) && !row.name.toLowerCase().includes(needle)) return false;
  }
  if (filter.providers?.length && !filter.providers.includes(row.backend)) return false;
  if (filter.types?.length && !filter.types.includes(row.type)) return false;
  if (filter.sources?.length) {
    const matches = filter.sources.some(source => (source === 'admin' ? row.adminEdited : row.origin === source));
    if (!matches) return false;
  }
  return true;
}

// Needs review takes any pending lifecycle suggestion and Retiring any model in the retiring window, whatever reason
// outranks them in the model's status.
const matchesView = (row: AdminModelRow, view: AdminModelView): boolean =>
  (view === 'needs-review' && row.lifecycleSuggestion !== null) ||
  (view === 'retiring' && inRetiringWindow(row)) ||
  (VIEW_STATUSES[view]?.has(row.status) ?? true);

/** The order filterAdminModels returns ids in. */
export const compareAdminModelIds = (a: string, b: string): number => a.localeCompare(b);

/** Throws a ZodError on a filter that does not parse. */
export function parseAdminModelFilter(filter: AdminModelFilter): ResolvedAdminModelFilter {
  return AdminModelFilterSchema.parse(filter);
}

/**
 * The rows a filter selects, in id order: what the list shows across all its pages, including the default exclusion
 * of profile-only Bedrock foundation ids.
 */
export function filterAdminModels(rows: readonly AdminModelRow[], filter: AdminModelFilter): AdminModelRow[] {
  const resolvedFilter = parseAdminModelFilter(filter);
  return rows
    .filter(
      row =>
        matchesFacets(row, resolvedFilter) &&
        matchesView(row, resolvedFilter.view) &&
        (resolvedFilter.showFoundationIds || !row.profileOnlyFoundation)
    )
    .sort((a, b) => compareAdminModelIds(a.id, b.id));
}

/** Actionable first. */
const STATUS_ORDER = new Map<AdminModelStatus, number>(
  (['needs-review', 'hidden', 'retiring', 'limited', 'listed', 'retired'] as const).map((status, index) => [
    status,
    index,
  ])
);

function compareRows(sort: AdminModelSort): (a: AdminModelRow, b: AdminModelRow) => number {
  // A model the picker does not offer has no rank and sorts after every ranked one.
  const byRank = (a: AdminModelRow, b: AdminModelRow) =>
    a.rank === b.rank ? 0 : a.rank === null ? 1 : b.rank === null ? -1 : a.rank - b.rank;
  const byName = (a: AdminModelRow, b: AdminModelRow) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const bySunset = (a: AdminModelRow, b: AdminModelRow) =>
    a.sunsetDays === b.sunsetDays
      ? 0
      : a.sunsetDays === null
        ? 1
        : b.sunsetDays === null
          ? -1
          : a.sunsetDays - b.sunsetDays;
  switch (sort) {
    case 'name':
      return byName;
    case 'rank':
      return (a, b) => byRank(a, b) || byName(a, b);
    case 'type':
      return (a, b) => a.type.localeCompare(b.type) || byRank(a, b) || byName(a, b);
    case 'provider':
      return (a, b) => a.backend.localeCompare(b.backend) || byRank(a, b) || byName(a, b);
    case 'status':
      return (a, b) =>
        (STATUS_ORDER.get(a.status) ?? 0) - (STATUS_ORDER.get(b.status) ?? 0) || byRank(a, b) || byName(a, b);
    case 'sunset':
      return (a, b) => bySunset(a, b) || byRank(a, b) || byName(a, b);
  }
}

export const ADMIN_MODEL_PAGE_SIZE_DEFAULT = 50;
export const ADMIN_MODEL_PAGE_SIZE_MAX = 500;

export interface AdminModelListQuery {
  filter: AdminModelFilter;
  sort?: AdminModelSort;
  dir?: 'asc' | 'desc';
  /** 1-based. */
  page?: number;
  pageSize?: number;
}

/** One page of the list plus the counts the page header shows. */
export function adminModelListPage(rows: readonly AdminModelRow[], query: AdminModelListQuery): AdminModelListResponse {
  const filter = parseAdminModelFilter(query.filter);
  const facetMatched = rows.filter(row => matchesFacets(row, filter));
  const shown = (row: AdminModelRow) => filter.showFoundationIds || !row.profileOnlyFoundation;

  const counts = Object.fromEntries(ADMIN_MODEL_STATUSES.map(status => [status, 0])) as Record<
    AdminModelStatus,
    number
  >;
  const viewCounts = Object.fromEntries(ADMIN_MODEL_VIEWS.map(view => [view, 0])) as Record<AdminModelView, number>;
  for (const row of facetMatched) {
    if (!shown(row)) continue;
    counts[row.status] += 1;
    for (const view of ADMIN_MODEL_VIEWS) if (matchesView(row, view)) viewCounts[view] += 1;
  }

  const viewMatched = facetMatched.filter(row => matchesView(row, filter.view));
  const matched = viewMatched.filter(shown);
  const compare = compareRows(query.sort ?? 'status');
  const sorted = [...matched].sort(query.dir === 'desc' ? (a, b) => compare(b, a) : compare);

  const pageSize = Math.min(Math.max(1, query.pageSize ?? ADMIN_MODEL_PAGE_SIZE_DEFAULT), ADMIN_MODEL_PAGE_SIZE_MAX);
  const page = Math.max(1, query.page ?? 1);
  return {
    models: sorted.slice((page - 1) * pageSize, page * pageSize),
    total: matched.length,
    page,
    pageSize,
    counts,
    viewCounts,
    foundationIds: viewMatched.filter(row => row.profileOnlyFoundation).length,
    facets: {
      providers: [...new Set(rows.map(row => row.backend))].sort(),
      types: [...new Set(rows.map(row => row.type))].sort(),
    },
  };
}
