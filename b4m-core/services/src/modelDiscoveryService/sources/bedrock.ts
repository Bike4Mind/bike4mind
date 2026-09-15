import { ModelBackend, type ModelRecord } from '@bike4mind/common';
import { limitConcurrency } from '../concurrency';
import type {
  DiscoveredModel,
  DiscoveryCredentials,
  DiscoveryFetchContext,
  DiscoverySource,
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
  startOfLifeTime?: Date | string;
  legacyTime?: Date | string;
  publicExtendedAccessTime?: Date | string;
  endOfLifeTime?: Date | string;
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

const calendarDay = (value: Date | string | undefined): string | undefined => {
  if (value === undefined) return undefined;
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

/**
 * The lifecycle block, or undefined when Bedrock says nothing. `legacyTime` is
 * the deprecation date and `endOfLifeTime` the retirement date - the mapping is
 * one-to-one, which is what makes a Bedrock model transition on the first run
 * rather than after the K-miss absence wait.
 */
function lifecycleOf(summary: BedrockFoundationModelSummary): ModelRecord['lifecycle'] | undefined {
  const raw = summary.modelLifecycle;
  const status = LIFECYCLE_STATUS[(raw?.status ?? '').toUpperCase()];
  if (!status) return undefined;
  return compact<NonNullable<ModelRecord['lifecycle']>>({
    status,
    deprecationDate: calendarDay(raw?.legacyTime),
    retirementDate: calendarDay(raw?.endOfLifeTime),
  });
}

export interface BedrockFacts {
  summaries: readonly BedrockFoundationModelSummary[];
  /** Availability by model id; a model absent from the map simply was not asked about. */
  availability?: ReadonlyMap<string, BedrockAvailability>;
}

export function normalizeBedrockModels({ summaries, availability }: BedrockFacts): DiscoveredModel[] {
  const records: DiscoveredModel[] = [];

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
    const lifecycle = lifecycleOf(summary);

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
          // Only ever set true. An unentitled model is disabled with a reason; a
          // model we never asked about, or one whose check failed, is left alone,
          // because clearing this flag on no evidence would re-enable a model the
          // account cannot call.
          autoDisabled: unauthorized ? true : undefined,
          autoDisabledReason: unauthorized ? 'not entitled in this AWS account' : undefined,
        }),
      })
    );
  }

  return records.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

export interface BedrockSourceOptions {
  client: BedrockControlPlane | (() => BedrockControlPlane | Promise<BedrockControlPlane>);
  /**
   * Model ids the catalog already holds as 'active'. Availability is checked
   * only for what is NOT in here: re-asking about 250 already-active models is
   * the naive call pattern that alone can exceed the function timeout (sec 6.3).
   */
  activeModelIds?: () => ReadonlySet<string> | Promise<ReadonlySet<string>>;
}

export function createBedrockSource(options: BedrockSourceOptions): DiscoverySource {
  return {
    name: 'bedrock',
    kind: 'provider',
    // First run probes availability per model, ~300 calls at concurrency 4.
    deadlineMs: PAGINATED_SOURCE_DEADLINE_MS,
    // Bedrock is IAM-authenticated, so there is no key to check - but under
    // B4M_SELF_HOST the AWS credentials are the local MinIO ones, and listing
    // Bedrock models there offers choices that can only fail.
    isConfigured: (creds: DiscoveryCredentials) => creds.awsIam,
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

      return {
        ok: true,
        records: normalizeBedrockModels({ summaries, availability }),
        authoritativeFor: [ModelBackend.Bedrock],
      };
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
  const pending = summaries
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
