import { ModelBackend, bedrockFoundationIdOf, type ModelRecord } from '@bike4mind/common';
import { limitConcurrency } from '../concurrency';
import type {
  DiscoveredModel,
  DiscoveryCredentials,
  DiscoveryFetchContext,
  DiscoverySource,
  DroppedSourceRecord,
  SourceResult,
} from '../types';
import { PAGINATED_SOURCE_DEADLINE_MS } from '../runModelDiscovery';
import { compact, text } from './http';

/**
 * Bedrock's `ListFoundationModels` carries the best deprecation feed of any
 * provider - a typed ACTIVE/LEGACY status with four timestamps - and no context
 * window at all. Its per-model companion, `GetFoundationModelAvailability`, is
 * the entitlement check, and it is the specific latency risk in this whole
 * feature: ~300 foundation models, one round trip each (sec 6.3).
 *
 * The AWS SDK client is INJECTED rather than imported. `@aws-sdk/client-bedrock`
 * is a control-plane package this package does not depend on (only the runtime
 * client is a dependency here), and pulling it in for one listing call would
 * add a dependency to every consumer of @bike4mind/services. The driver that
 * already has it wires this port; the shapes below mirror the SDK's
 * FoundationModelSummary and GetFoundationModelAvailabilityResponse exactly.
 */
export interface BedrockModelLifecycle {
  /** 'ACTIVE' | 'LEGACY' as the SDK spells it; read as a free string for forward compat. */
  status?: string;
  // The wire sends null for a date that does not apply.
  startOfLifeTime?: Date | string | null;
  legacyTime?: Date | string | null;
  publicExtendedAccessTime?: Date | string | null;
  endOfLifeTime?: Date | string | null;
}

export interface BedrockFoundationModelSummary {
  modelId?: string;
  modelName?: string;
  providerName?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  responseStreamingSupported?: boolean;
  inferenceTypesSupported?: string[];
  modelLifecycle?: BedrockModelLifecycle;
}

export interface BedrockAvailability {
  modelId?: string;
  authorizationStatus?: string;
  entitlementAvailability?: string;
  regionAvailability?: string;
}

export interface BedrockControlPlane {
  listFoundationModels(signal: AbortSignal): Promise<BedrockFoundationModelSummary[]>;
  /**
   * Null means "no availability data for this model this run". A per-model
   * failure MUST arrive here as null and never as an unavailable verdict
   * (sec 6.3): one throttled call must not disable a model.
   */
  getFoundationModelAvailability(modelId: string, signal: AbortSignal): Promise<BedrockAvailability | null>;
}

/** Matches the run's source concurrency cap; ~300 serial round trips would blow the deadline. */
export const BEDROCK_AVAILABILITY_CONCURRENCY = 4;

const LIFECYCLE_STATUS: Readonly<Record<string, NonNullable<ModelRecord['lifecycle']>['status']>> = {
  ACTIVE: 'active',
  LEGACY: 'legacy',
};

const calendarDay = (value: Date | string | null | undefined): string | undefined => {
  if (value == null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : undefined;
};

/**
 * Bedrock exposes no model kind, so it is read off the modality pair: text out
 * is a text model, image out an image model, and anything else is left unset
 * rather than guessed.
 */
function inferType(summary: BedrockFoundationModelSummary): ModelRecord['type'] | undefined {
  const outputs = (summary.outputModalities ?? []).map(value => value.toUpperCase());
  if (outputs.includes('TEXT')) return 'text';
  if (outputs.includes('IMAGE')) return 'image';
  if (outputs.includes('EMBEDDING')) return 'embedding';
  return undefined;
}

const rawStatusOf = (summary: BedrockFoundationModelSummary): string | undefined =>
  text(summary.modelLifecycle?.status)?.toUpperCase();

type Lifecycle = NonNullable<ModelRecord['lifecycle']>;

/**
 * The lifecycle block (undefined when Bedrock makes no usable claim) plus the problems found
 * reading it. An unknown status reads as legacy only with a parseable `legacyTime`.
 */
function readLifecycle(summary: BedrockFoundationModelSummary): {
  lifecycle?: Lifecycle;
  issues: string[];
  statusless: boolean;
} {
  const raw = summary.modelLifecycle;
  const rawStatus = rawStatusOf(summary);
  const deprecationDate = calendarDay(raw?.legacyTime);
  const known = rawStatus ? LIFECYCLE_STATUS[rawStatus] : undefined;
  const status = known ?? (rawStatus && deprecationDate ? 'legacy' : undefined);
  const lifecycle = status
    ? compact<Lifecycle>({ status, deprecationDate, retirementDate: calendarDay(raw?.endOfLifeTime) })
    : undefined;

  const issues: string[] = [];
  if (rawStatus && !known) {
    issues.push(
      `unrecognized Bedrock lifecycle status "${raw?.status}"; ${lifecycle ? 'treated as legacy' : 'no lifecycle claim'}`
    );
  }
  const checkDate = (field: string, value: Date | string | null | undefined) => {
    if (value != null && calendarDay(value) === undefined) {
      issues.push(`unparseable Bedrock ${field} ${JSON.stringify(value)}; date ignored`);
    }
  };
  checkDate('legacyTime', raw?.legacyTime);
  checkDate('endOfLifeTime', raw?.endOfLifeTime);
  return { lifecycle, issues, statusless: !rawStatus };
}

export interface BedrockFacts {
  summaries: readonly BedrockFoundationModelSummary[];
  /** Availability by model id; a model absent from the map simply was not asked about. */
  availability?: ReadonlyMap<string, BedrockAvailability>;
  /** Catalog ids; each region-prefixed profile id among them gets its foundation model's lifecycle. */
  catalogModelIds?: Iterable<string>;
}

/**
 * Bedrock lists some models (every Claude 4.x) under a bare id it will not serve on demand, only
 * through a region-prefixed inference profile or provisioned throughput; offering the bare id guarantees a dispatch failure.
 *
 * Keyed on the ABSENCE of ON_DEMAND rather than on a profile value: the SDK's InferenceType enum
 * names only ON_DEMAND and PROVISIONED, so the profile spelling is not a contract. An absent or
 * empty list is "did not say".
 */
const isNotOnDemand = (summary: BedrockFoundationModelSummary): boolean => {
  const types = summary.inferenceTypesSupported ?? [];
  return types.length > 0 && !types.includes('ON_DEMAND');
};

/**
 * Positive evidence on every clause this source disables for: listed ON_DEMAND, and an availability
 * answer that says yes to all three. Only this clears an earlier disable (planOne in catalogWrite.ts);
 * a missing field or a failed availability call is "did not say" and clears nothing.
 */
const isConfirmedInvocable = (
  summary: BedrockFoundationModelSummary,
  entitlement: BedrockAvailability | undefined
): boolean =>
  (summary.inferenceTypesSupported ?? []).includes('ON_DEMAND') &&
  entitlement?.authorizationStatus === 'AUTHORIZED' &&
  entitlement.entitlementAvailability === 'AVAILABLE' &&
  entitlement.regionAvailability === 'AVAILABLE';

export const normalizeBedrockModels = (facts: BedrockFacts): DiscoveredModel[] => readBedrock(facts).records;

export const bedrockLifecycleGaps = (facts: BedrockFacts): DroppedSourceRecord[] => readBedrock(facts).gaps;

/** One pass over the listing and the catalog ids: the records to write and the lifecycle data this source could not use. */
function readBedrock({ summaries, availability, catalogModelIds }: BedrockFacts): {
  records: DiscoveredModel[];
  gaps: DroppedSourceRecord[];
} {
  const records: DiscoveredModel[] = [];
  const gaps: DroppedSourceRecord[] = [];
  const gap = (modelId: string, reason: string) => gaps.push({ source: 'bedrock', modelId, reason });
  const listed = new Map<string, { lifecycle?: Lifecycle; statusless: boolean }>();

  for (const summary of summaries) {
    const id = text(summary?.modelId);
    if (!id) continue;

    const entitlement = availability?.get(id);
    const inputs = (summary.inputModalities ?? []).map(value => value.toUpperCase());
    // regionAvailability counts too: a model AUTHORIZED and entitled account-wide
    // but restricted in the deployment's region is offered by the catalog and
    // then fails at every dispatch. Only the explicit negative disables, same as
    // the other two clauses - an absent field is "did not say".
    const unauthorized =
      entitlement !== undefined &&
      (entitlement.authorizationStatus === 'NOT_AUTHORIZED' ||
        entitlement.entitlementAvailability === 'NOT_AVAILABLE' ||
        entitlement.regionAvailability === 'NOT_AVAILABLE');
    const notOnDemand = isNotOnDemand(summary);
    const { lifecycle, issues, statusless } = readLifecycle(summary);
    listed.set(id, { lifecycle, statusless });
    for (const reason of issues) gap(id, reason);

    records.push(
      compact<DiscoveredModel>({
        modelId: id,
        // A typed feed: modelLifecycle is published as data, which is what lets
        // it transition a model on the first run (sec 5.10 tier 1).
        lifecycleEvidence: lifecycle ? 'typed' : undefined,
        patch: compact<Partial<ModelRecord>>({
          id,
          vendor: text(summary?.providerName)?.toLowerCase() ?? id.split('.')[0],
          backend: ModelBackend.Bedrock,
          type: inferType(summary),
          name: text(summary?.modelName),
          // Bedrock publishes no context window; leaving it out lets the catalog
          // or an aggregator supply it instead of overwriting it with a zero.
          canStream:
            typeof summary?.responseStreamingSupported === 'boolean' ? summary.responseStreamingSupported : undefined,
          supportsVision: inputs.length > 0 ? inputs.includes('IMAGE') : undefined,
          lifecycle,
          // An unentitled or not-on-demand model is disabled with a reason. False only on
          // positive evidence for every clause (isConfirmedInvocable); a model we never
          // asked about, or one whose check failed, is left alone, because clearing this
          // flag on no evidence would re-enable a model the account cannot call.
          autoDisabled:
            unauthorized || notOnDemand ? true : isConfirmedInvocable(summary, entitlement) ? false : undefined,
          autoDisabledReason: unauthorized
            ? 'not entitled in this AWS account'
            : notOnDemand
              ? 'not invocable on demand; use its region-prefixed inference profile id'
              : undefined,
        }),
      })
    );
  }

  const missing = new Map<string, Set<string>>();
  for (const catalogId of catalogModelIds ?? []) {
    const foundationId = bedrockFoundationIdOf(catalogId);
    const baseId = foundationId ?? catalogId;
    const base = listed.get(baseId);
    if (!base) {
      gap(catalogId, `foundation model ${baseId} is not in the Bedrock listing; no lifecycle propagated`);
    } else if (base.lifecycle) {
      if (foundationId !== null) {
        records.push({ modelId: catalogId, lifecycleEvidence: 'typed', patch: { lifecycle: base.lifecycle } });
      }
    } else if (base.statusless) {
      missing.set(baseId, (missing.get(baseId) ?? new Set()).add(catalogId));
    }
  }
  for (const [baseId, dependents] of missing) {
    gap(baseId, `Bedrock listed no lifecycle for a model the catalog depends on (${[...dependents].join(', ')})`);
  }

  return { records: records.sort((a, b) => a.modelId.localeCompare(b.modelId)), gaps };
}

export interface BedrockSourceOptions {
  client: BedrockControlPlane | (() => BedrockControlPlane | Promise<BedrockControlPlane>);
  /**
   * Model ids the catalog already holds as 'active'. Availability is checked
   * only for what is NOT in here: re-asking about 250 already-active models is
   * the naive call pattern that alone can exceed the function timeout (sec 6.3).
   */
  activeModelIds?: () => ReadonlySet<string> | Promise<ReadonlySet<string>>;
  /** See BedrockFacts.catalogModelIds. */
  catalogModelIds?: () => Iterable<string> | Promise<Iterable<string>>;
}

export function createBedrockSource(options: BedrockSourceOptions): DiscoverySource {
  return {
    name: 'bedrock',
    kind: 'provider',
    // First run probes availability per model, ~300 calls at concurrency 4.
    deadlineMs: PAGINATED_SOURCE_DEADLINE_MS,
    // IAM-authenticated: hosted uses the role, self-host needs BEDROCK_AWS_*
    // (its AWS_* pair is the local MinIO credential).
    isConfigured: (creds: DiscoveryCredentials) => creds.bedrock,
    async fetch(ctx: DiscoveryFetchContext): Promise<SourceResult> {
      let client: BedrockControlPlane;
      try {
        client = typeof options.client === 'function' ? await options.client() : options.client;
      } catch (error) {
        return { ok: false, error: `bedrock control plane unavailable: ${describe(error)}` };
      }

      let summaries: BedrockFoundationModelSummary[];
      try {
        summaries = await client.listFoundationModels(ctx.signal);
      } catch (error) {
        return { ok: false, error: `ListFoundationModels failed: ${describe(error)}` };
      }
      if (summaries.length === 0) {
        return { ok: false, error: 'ListFoundationModels returned nothing' };
      }

      const availability = await checkAvailability(client, summaries, options, ctx);
      const catalogModelIds = await options.catalogModelIds?.();
      const catalogIds = [...(catalogModelIds ?? [])];
      if (catalogIds.length === 0) {
        ctx.logger.warn('[model-discovery] bedrock got no catalog ids; profile lifecycle propagation is off');
      }
      const { records, gaps } = readBedrock({ summaries, availability, catalogModelIds: catalogIds });
      if (gaps.length > 0) {
        const sample = gaps.slice(0, 3).map(gap => gap.modelId);
        ctx.logger.warn(`[model-discovery] bedrock ${gaps.length} lifecycle gaps, e.g. ${sample.join(', ')}`);
      }

      return { ok: true, records, authoritativeFor: [ModelBackend.Bedrock], dropped: gaps };
    },
  };
}

async function checkAvailability(
  client: BedrockControlPlane,
  summaries: readonly BedrockFoundationModelSummary[],
  options: BedrockSourceOptions,
  ctx: DiscoveryFetchContext
): Promise<Map<string, BedrockAvailability>> {
  const alreadyActive = (await options.activeModelIds?.()) ?? new Set<string>();
  // A model this listing already shows as not on demand is disabled whatever availability says, so the
  // call would buy nothing. The listing is re-read every run, so the model is asked the same run
  // ON_DEMAND appears, which is when isConfirmedInvocable needs the answer to lift the disable.
  const pending = summaries
    .filter(summary => !isNotOnDemand(summary))
    .map(summary => text(summary?.modelId))
    .filter((id): id is string => id !== undefined && !alreadyActive.has(id));

  const availability = new Map<string, BedrockAvailability>();
  const limit = limitConcurrency(BEDROCK_AVAILABILITY_CONCURRENCY);
  await Promise.all(
    pending.map(id =>
      limit(async () => {
        // Stop issuing calls once the deadline trips: the partial map is
        // "these are the models we got an answer about", which is exactly what
        // the normalizer treats it as.
        if (ctx.signal.aborted) return;
        try {
          const result = await client.getFoundationModelAvailability(id, ctx.signal);
          if (result) availability.set(id, result);
        } catch (error) {
          // No data for this model this run. Never unavailable (sec 6.3).
          ctx.logger.warn(`[model-discovery] bedrock availability for ${id} unavailable: ${describe(error)}`);
        }
      })
    )
  );
  return availability;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
