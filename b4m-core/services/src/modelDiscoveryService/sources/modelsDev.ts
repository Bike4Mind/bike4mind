import { MODELS_DEV_PROVIDER_BY_BACKEND, type ModelRecord } from '@bike4mind/common';
import type { DiscoveredModel, DiscoveredPrice, DiscoveryFetchContext, DiscoverySource, SourceResult } from '../types';
import { joinTargets, logCoverage, type AggregatorSourceOptions, type JoinTarget } from './aggregator';
import { boolean, compact, contentHashOf, count, fetchJson } from './http';

export const MODELS_DEV_URL = 'https://models.dev/api.json';

/**
 * models.dev (MIT) is the PRIMARY enrichment source: 172 providers, cost already
 * quoted in $/MTok, correct temperature gating, and the only feed that prices
 * Bedrock. It fills gaps; it never adds or retires a model, because a listing
 * nobody can call is not evidence a model exists at a backend we have.
 */
interface ModelsDevCost {
  input?: unknown;
  output?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
}

interface ModelsDevModel {
  id?: unknown;
  name?: unknown;
  reasoning?: unknown;
  tool_call?: unknown;
  structured_output?: unknown;
  temperature?: unknown;
  status?: unknown;
  modalities?: { input?: unknown; output?: unknown };
  limit?: { context?: unknown; output?: unknown };
  cost?: ModelsDevCost;
}

interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}

export type ModelsDevDocument = Record<string, ModelsDevProvider>;

/** Only 'deprecated' maps; 'beta' and 'alpha' are pre-release notes, not lifecycle states. */
const LIFECYCLE_STATUS: Readonly<Record<string, NonNullable<ModelRecord['lifecycle']>['status']>> = {
  deprecated: 'deprecated',
};

const modalityList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * Flatten the document to `key -> model`, restricted to the providers a backend
 * of ours maps to. Indexing all 172 would drop 5,755 bare ids into one namespace,
 * where a reseller's copy of a model can shadow the one we actually call - and
 * with it, that reseller's price.
 */
export function indexModelsDev(document: unknown, backends: Iterable<string>): Map<string, ModelsDevModel> {
  const doc = (document ?? {}) as ModelsDevDocument;
  const providers = new Set<string>();
  for (const backend of backends) {
    const provider = MODELS_DEV_PROVIDER_BY_BACKEND[backend];
    if (provider) providers.add(provider);
  }

  const entries = new Map<string, ModelsDevModel>();
  for (const provider of providers) {
    for (const [key, model] of Object.entries(doc[provider]?.models ?? {})) {
      if (model && typeof model === 'object') entries.set(key, model);
    }
  }
  return entries;
}

const rate = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** models.dev already quotes $/MTok, so there is no unit conversion to get wrong. */
function priceOf(cost: ModelsDevCost | undefined): DiscoveredPrice | undefined {
  const inputPerMTok = rate(cost?.input);
  const outputPerMTok = rate(cost?.output);
  if (inputPerMTok === undefined || outputPerMTok === undefined) return undefined;
  if (inputPerMTok === 0 && outputPerMTok === 0) return undefined;
  return compact({
    inputPerMTok,
    outputPerMTok,
    cacheReadPerMTok: rate(cost?.cache_read),
    cacheWritePerMTok: rate(cost?.cache_write),
  });
}

function patchOf(model: ModelsDevModel): Partial<ModelRecord> {
  const inputs = modalityList(model.modalities?.input);
  const reasoning = boolean(model.reasoning);
  const temperature = boolean(model.temperature);
  const status = LIFECYCLE_STATUS[String(model.status ?? '').toLowerCase()];

  return compact<Partial<ModelRecord>>({
    contextWindow: count(model.limit?.context),
    maxOutputTokens: count(model.limit?.output),
    // No `style`: models.dev says a model reasons, not which request shape does
    // it, and guessing that would mis-build the call.
    reasoning: reasoning === undefined ? undefined : { supported: reasoning },
    // models.dev is the feed that knows opus-5 rejects temperature; a `true`
    // here is not claimed as 'free' because a provider may still pin it.
    temperatureMode: temperature === false ? 'unsupported' : undefined,
    supportsVision: inputs.length > 0 ? inputs.includes('image') : undefined,
    supportsPdfInput: inputs.length > 0 ? inputs.includes('pdf') : undefined,
    supportsTools: boolean(model.tool_call),
    supportsStructuredOutput: boolean(model.structured_output),
    lifecycle: status ? { status } : undefined,
  });
}

export function normalizeModelsDev(
  document: unknown,
  targets: readonly JoinTarget[],
  aliases?: AggregatorSourceOptions['aliases']
): { records: DiscoveredModel[]; unmatched: string[] } {
  const entries = indexModelsDev(
    document,
    targets.map(target => target.backend ?? '')
  );
  const { matched, unmatched } = joinTargets(targets, entries, 'modelsDev', aliases);

  const records: DiscoveredModel[] = [];
  for (const [modelId, model] of matched) {
    // Emitted even when nothing usable came back: AggregatorJoinCoverage is
    // computed from the emitted records, so withholding a matched id would
    // report it as unmatched and alarm on a healthy run. The write path counts
    // an empty one as dropped, which is the accurate statement.
    records.push(compact({ modelId, patch: patchOf(model), pricing: priceOf(model.cost) }));
  }

  return { records: records.sort((a, b) => a.modelId.localeCompare(b.modelId)), unmatched: unmatched.sort() };
}

export function createModelsDevSource(options: AggregatorSourceOptions): DiscoverySource {
  return {
    name: 'models.dev',
    kind: 'aggregator',
    // Public and unauthenticated; the egress switch is the only gate, and the
    // runner applies that before isConfigured is consulted.
    isConfigured: () => true,
    async fetch(ctx: DiscoveryFetchContext): Promise<SourceResult> {
      // If-None-Match is sent because the document revalidates to a 0-byte 304
      // and that answers "did the aggregator change under us" for free. A 304
      // is then followed by ONE unconditional read: the join needs the body, and
      // reporting an empty aggregator contribution would drive
      // AggregatorJoinCoverage to zero on a run where nothing was actually
      // wrong. The extra request is a few hundred bytes against a 3 MB body.
      let response = await fetchJson<ModelsDevDocument>({ url: MODELS_DEV_URL, ifNoneMatch: ctx.previous?.etag }, ctx);
      if (response.ok && response.notModified) {
        ctx.logger.info(`[model-discovery] models.dev unchanged (etag ${response.etag ?? ctx.previous?.etag ?? '?'})`);
        response = await fetchJson<ModelsDevDocument>({ url: MODELS_DEV_URL }, ctx);
      }
      if (!response.ok) return { ok: false, error: response.error, httpStatus: response.status };
      if (response.notModified) return { ok: false, error: 'models.dev kept returning 304', httpStatus: 304 };

      const targets = await options.targets();
      const { records, unmatched } = normalizeModelsDev(response.body, targets, options.aliases);
      logCoverage(ctx, 'models.dev', { matched: new Map(records.map(r => [r.modelId, r])), unmatched });

      // No authoritativeFor, ever: an aggregator can neither add nor retire.
      return {
        ok: true,
        records,
        httpStatus: response.status,
        etag: response.etag,
        contentHash: contentHashOf(response.text),
      };
    },
  };
}
