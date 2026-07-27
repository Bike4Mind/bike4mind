import {
  FIELD_GROUP_OF,
  ModelRecordWrite,
  type FieldGroup,
  type ICatalogContributor,
  type IModelCatalogRowInput,
  type ModelRecord,
} from '@bike4mind/common';
import type { ResolvedCatalogRecord } from '@bike4mind/llm-adapters';
import isEqual from 'lodash/isEqual.js';
import omit from 'lodash/omit.js';
import { evaluatePromotion, isDispatchBlocked, type PromotionDecision } from './promotion';
import type {
  CatalogDiffEntry,
  DiscoveredPrice,
  DiscoveryAutoEnablePolicy,
  DiscoveryCredentials,
  DiscoverySourceKind,
  DispatchResolver,
  DroppedSourceRecord,
  SourceContribution,
} from './types';

/** Provenance marker for a group discovery derived rather than fetched. */
export const DISCOVERY_CONTRIBUTOR = 'discovery';

/**
 * Groups no feed may claim (sec 5.5 authority table). `dispatch` encodes how to
 * shape a request and `presentation` is editorial; a source that guesses either
 * mis-routes traffic or overwrites a human's copy, so contributions to them are
 * dropped rather than merged.
 */
const FEED_FORBIDDEN_GROUPS: readonly FieldGroup[] = ['dispatch', 'presentation'];

/** Two aggregators inside this band agree; beyond it neither is trusted (sec 8). */
export const PRICE_AGREEMENT_TOLERANCE = 0.1;

/** Provenance for a dispatch field the resolver derived rather than a feed reporting it. */
export const DISPATCH_SEED_CONTRIBUTOR = 'seed';

export interface CatalogWriteInput {
  /**
   * This run's successful sources, in registration order. Sorted here so
   * precedence is decided in one place: provider records outrank aggregator
   * records for every field, and within a kind the registration order decides
   * (which is how models.dev stays ahead of litellm without being named).
   */
  contributions: readonly SourceContribution[];
  resolveDispatch?: DispatchResolver;
  /** Belief per model from the NON-operator rows in force. */
  base: ReadonlyMap<string, ResolvedCatalogRecord>;
  operatorOwnedModelIds: ReadonlySet<string>;
  credentials: DiscoveryCredentials;
  policy: DiscoveryAutoEnablePolicy;
  knownPricedModelIds?: ReadonlySet<string>;
  runStartedAt: Date;
  runId?: string;
}

export interface CatalogWritePlan {
  /** One entry per model this run would change; the report is identical in both modes. */
  diff: CatalogDiffEntry[];
  /** Rows to append, index-aligned with `diff`. */
  rows: IModelCatalogRowInput[];
  dropped: DroppedSourceRecord[];
  /** Every model id a PROVIDER reported, for absence bookkeeping. */
  sightedModelIds: Set<string>;
}

interface Candidate {
  modelId: string;
  fields: Map<string, unknown>;
  /** Which source supplied each field, for contributors[]. */
  sourceOfField: Map<string, string>;
  sourceNames: string[];
  sawProvider: boolean;
  pricesByKind: Array<{ kind: DiscoverySourceKind; price: DiscoveredPrice }>;
}

/**
 * Turn this run's source records into the catalog rows it would append.
 *
 * Diff-based by construction: a row is produced only when the merged view of that
 * model would actually change, so a second run over identical source data appends
 * nothing. The plan is computed the same way in report and write mode - report
 * mode is the caller declining to persist it, never a different calculation.
 */
export function planCatalogWrites(input: CatalogWriteInput): CatalogWritePlan {
  const dropped: DroppedSourceRecord[] = [];
  const candidates = collectCandidates(input.contributions, dropped);

  const diff: CatalogDiffEntry[] = [];
  const rows: IModelCatalogRowInput[] = [];
  const sightedModelIds = new Set<string>();

  for (const candidate of candidates.values()) {
    // Only a provider listing is a sighting. litellm and models.dev keep retired
    // ids in their tables forever, so counting an aggregator record would reset
    // the absence streak of every provider-dropped model and the K-miss protocol
    // (sec 5.10) could never fire.
    if (candidate.sawProvider) sightedModelIds.add(candidate.modelId);
    const existing = input.base.get(candidate.modelId);

    // An aggregator alone can neither add nor retire a model: without a provider
    // sighting there is no evidence the model exists at a backend we can call.
    if (!existing && !candidate.sawProvider) {
      dropped.push({
        source: candidate.sourceNames.join('+'),
        modelId: candidate.modelId,
        reason: 'aggregator-only model with no catalog row',
      });
      continue;
    }

    const planned = planOne(candidate, existing, input);
    if ('reason' in planned) {
      dropped.push({ source: candidate.sourceNames.join('+'), modelId: candidate.modelId, reason: planned.reason });
      continue;
    }
    if ('unchanged' in planned) continue;

    diff.push(planned.entry);
    rows.push(planned.row);
  }

  return { diff, rows, dropped, sightedModelIds };
}

function collectCandidates(
  contributions: readonly SourceContribution[],
  dropped: DroppedSourceRecord[]
): Map<string, Candidate> {
  const candidates = new Map<string, Candidate>();
  const ordered = [...contributions].sort((a, b) => (a.kind === 'provider' ? 0 : 1) - (b.kind === 'provider' ? 0 : 1));

  for (const contribution of ordered) {
    for (const record of contribution.records) {
      const modelId = typeof record?.modelId === 'string' ? record.modelId.trim() : '';
      if (!modelId) {
        dropped.push({ source: contribution.name, modelId: '<unknown>', reason: 'record has no modelId' });
        continue;
      }
      const patch = record.patch;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        dropped.push({ source: contribution.name, modelId, reason: 'record patch is not an object' });
        continue;
      }

      const usable = usableFields(patch, contribution.name, modelId, dropped);
      if (usable.length === 0 && !record.pricing) {
        dropped.push({ source: contribution.name, modelId, reason: 'record carries no usable fields' });
        continue;
      }

      const candidate = candidates.get(modelId) ?? {
        modelId,
        fields: new Map<string, unknown>(),
        sourceOfField: new Map<string, string>(),
        sourceNames: [],
        sawProvider: false,
        pricesByKind: [],
      };
      // Contributions arrive in precedence order, so the first writer of a field
      // is the most authoritative one and later sources only fill gaps.
      for (const [key, value] of usable) {
        if (candidate.fields.has(key)) continue;
        candidate.fields.set(key, value);
        candidate.sourceOfField.set(key, contribution.name);
      }
      if (!candidate.sourceNames.includes(contribution.name)) candidate.sourceNames.push(contribution.name);
      if (contribution.kind === 'provider') candidate.sawProvider = true;
      if (record.pricing) candidate.pricesByKind.push({ kind: contribution.kind, price: record.pricing });
      candidates.set(modelId, candidate);
    }
  }

  return candidates;
}

/** Fields this build knows and a feed is allowed to claim; everything else is dropped. */
function usableFields(
  patch: Record<string, unknown>,
  sourceName: string,
  modelId: string,
  dropped: DroppedSourceRecord[]
): Array<[string, unknown]> {
  const usable: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const group = FIELD_GROUP_OF[key as keyof ModelRecord];
    if (!group) {
      dropped.push({ source: sourceName, modelId, reason: `unknown field "${key}"` });
      continue;
    }
    if (FEED_FORBIDDEN_GROUPS.includes(group)) {
      dropped.push({ source: sourceName, modelId, reason: `field "${key}" is seed- or operator-owned` });
      continue;
    }
    usable.push([key, value]);
  }
  return usable;
}

type PlanOneResult = { entry: CatalogDiffEntry; row: IModelCatalogRowInput } | { unchanged: true } | { reason: string };

function planOne(
  candidate: Candidate,
  existing: ResolvedCatalogRecord | undefined,
  input: CatalogWriteInput
): PlanOneResult {
  const base = existing?.record ?? {};
  const draft: Record<string, unknown> = { ...base };
  for (const [key, value] of candidate.fields) draft[key] = value;

  const ownedGroups = new Set<FieldGroup>();
  for (const key of candidate.fields.keys()) {
    const group = FIELD_GROUP_OF[key as keyof ModelRecord];
    if (group) ownedGroups.add(group);
  }

  const parsed = ModelRecordWrite.safeParse(draft);
  if (!parsed.success) {
    return { reason: `record failed the append schema: ${parsed.error.issues.map(issue => issue.message).join('; ')}` };
  }

  // Discovery only decides for records it introduced and has not promoted yet.
  // Every other transition is lifecycle automation (Phase 4), and re-deciding an
  // already-active model here would let a missing deployment credential
  // auto-disable a model the seed ships as invocable.
  const decides = !existing || statusOf(base) === 'discovered';
  let record = parsed.data;
  let decision: PromotionDecision | null = null;

  if (decides && (!record.adapterFamily || !record.dispatchProfile)) {
    const derived = input.resolveDispatch?.(record);
    if (derived?.adapterFamily && !record.adapterFamily) {
      record = { ...record, adapterFamily: derived.adapterFamily };
      ownedGroups.add('dispatch');
    }
    if (derived?.dispatchProfile && !record.dispatchProfile) {
      record = { ...record, dispatchProfile: derived.dispatchProfile };
      ownedGroups.add('dispatch');
    }
  }

  if (decides) {
    decision = evaluatePromotion({
      record,
      policy: input.policy,
      credentials: input.credentials,
      hasTrustedPrice: hasTrustedPrice(candidate, input.knownPricedModelIds),
    });
    // autoDisabledReason is omitted rather than set to undefined so a promotion
    // reads as a removed key in the diff instead of a key that is still there.
    const withoutReason = omit(record, 'autoDisabledReason');
    record = decision.promote
      ? { ...withoutReason, lifecycle: { ...record.lifecycle, status: 'active' }, autoDisabled: false }
      : {
          ...withoutReason,
          lifecycle: { ...record.lifecycle, status: 'discovered' },
          autoDisabled: true,
          autoDisabledReason: decision.autoDisabledReason,
        };
    ownedGroups.add('lifecycle');
    ownedGroups.add('availability');
  }

  if (ownedGroups.size === 0) return { unchanged: true };

  const owned = [...ownedGroups];
  const changedKeys = changedWithinGroups(base, record, owned);
  if (existing && changedKeys.length === 0) return { unchanged: true };

  const lifecycleStatus = record.lifecycle?.status ?? 'discovered';
  const entry: CatalogDiffEntry = {
    modelId: candidate.modelId,
    kind: existing ? 'updated' : 'added',
    ownedGroups: owned,
    changedKeys,
    lifecycleStatus,
    promoted: decision?.promote === true,
    blockedBy: decision?.blockedBy ?? [],
    operatorOwned: input.operatorOwnedModelIds.has(candidate.modelId),
  };

  const row: IModelCatalogRowInput = {
    modelId: candidate.modelId,
    source: 'discovery',
    patch: record,
    ownedGroups: owned,
    effectiveFrom: input.runStartedAt,
    contributors: contributorsFor(candidate, owned),
    note: `discovery:${candidate.sourceNames.join('+')}@${input.runStartedAt.toISOString()}`,
    runId: input.runId,
  };

  return { entry, row };
}

/** lifecycle.status off an unvalidated base record, or undefined when absent. */
function statusOf(base: Record<string, unknown>): string | undefined {
  const lifecycle = base.lifecycle;
  if (!lifecycle || typeof lifecycle !== 'object') return undefined;
  const status = (lifecycle as { status?: unknown }).status;
  return typeof status === 'string' ? status : undefined;
}

/** Keys inside the claimed groups whose value the appended row would change. */
function changedWithinGroups(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
  owned: readonly FieldGroup[]
): string[] {
  const inScope = (key: string): boolean => {
    const group = FIELD_GROUP_OF[key as keyof ModelRecord];
    return group !== undefined && owned.includes(group);
  };
  const keys = new Set([...Object.keys(base), ...Object.keys(next)].filter(inScope));
  return [...keys].filter(key => !isEqual(base[key], next[key])).sort();
}

function contributorsFor(candidate: Candidate, owned: readonly FieldGroup[]): ICatalogContributor[] {
  const bySource = new Map<FieldGroup, string>();
  for (const [key, source] of candidate.sourceOfField) {
    const group = FIELD_GROUP_OF[key as keyof ModelRecord];
    // First writer of a group's first field is the source that group is credited to.
    if (group && !bySource.has(group)) bySource.set(group, source);
  }
  return owned.map(group => ({
    group,
    source: bySource.get(group) ?? (group === 'dispatch' ? DISPATCH_SEED_CONTRIBUTOR : DISCOVERY_CONTRIBUTOR),
  }));
}

/**
 * Trusted per sec 5.9: a provider's own API, two aggregators inside the
 * agreement band, or a price the catalog already holds. A lone aggregator is a
 * flag, not a price.
 */
export function hasTrustedPrice(
  candidate: Pick<Candidate, 'modelId' | 'pricesByKind'>,
  knownPricedModelIds?: ReadonlySet<string>
): boolean {
  if (knownPricedModelIds?.has(candidate.modelId)) return true;
  if (candidate.pricesByKind.some(entry => entry.kind === 'provider')) return true;

  const aggregated = candidate.pricesByKind.filter(entry => entry.kind === 'aggregator').map(entry => entry.price);
  if (aggregated.length < 2) return false;
  return aggregated.every(price => withinTolerance(price, aggregated[0]));
}

function withinTolerance(a: DiscoveredPrice, b: DiscoveredPrice): boolean {
  return (
    relativeGap(a.inputPerMTok, b.inputPerMTok) <= PRICE_AGREEMENT_TOLERANCE &&
    relativeGap(a.outputPerMTok, b.outputPerMTok) <= PRICE_AGREEMENT_TOLERANCE
  );
}

/**
 * Fractional distance between two rates against the LARGER magnitude, so a
 * $3 -> $6 move and a $6 -> $3 move both read as one move of the same size.
 * Scale-invariant, so it is the same number in $/MTok and in $/token.
 */
export function relativeGap(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? 0 : Math.abs(a - b) / scale;
}

/** Metric inputs the run report and the drivers both read off one plan. */
export function summarizeDiff(diff: readonly CatalogDiffEntry[]): {
  added: string[];
  promoted: string[];
  blockedByDispatch: string[];
  operatorConflicts: string[];
} {
  return {
    added: diff.filter(entry => entry.kind === 'added').map(entry => entry.modelId),
    promoted: diff.filter(entry => entry.promoted).map(entry => entry.modelId),
    blockedByDispatch: diff.filter(entry => isDispatchBlocked(entry.blockedBy)).map(entry => entry.modelId),
    operatorConflicts: diff.filter(entry => entry.operatorOwned).map(entry => entry.modelId),
  };
}
