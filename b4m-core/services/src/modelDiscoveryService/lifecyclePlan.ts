import {
  FIELD_GROUPS,
  ModelRecordWrite,
  groupsTouchedByPatch,
  normalizeAggregatorKey,
  type FieldGroup,
  type IModelCatalogRowInput,
  type IModelDiscoveryState,
  type ModelRecord,
} from '@bike4mind/common';
import type { ResolvedCatalogRecord } from '@bike4mind/llm-adapters';
import omit from 'lodash/omit.js';
import { DISCOVERY_CONTRIBUTOR, relativeGap, type CatalogWritePlan } from './catalogWrite';
import type { PerTokenRates } from './pricePlan';
import type {
  CatalogDiffEntry,
  DiscoveredModel,
  DiscoveryAutoRemapPolicy,
  DroppedSourceRecord,
  LifecycleDateChange,
  LifecycleEvidence,
  LifecycleSignalKind,
  LifecycleSuggestion,
  LifecycleTransition,
  SourceContribution,
} from './types';

/** K consecutive successful-run misses before absence alone deprecates a model (sec 5.10). */
export const ABSENCE_MISS_THRESHOLD = 3;

/**
 * ...and how old that streak has to be. Both clauses are required: three runs
 * inside one hour are three views of a single outage, not two days of absence.
 */
export const ABSENCE_MIN_STREAK_MS = 48 * 60 * 60_000;

/** Relative row-count move that reads as a page restructure rather than a model list changing. */
export const DOCS_PARSER_SHIFT_TOLERANCE = 0.2;

/** Note prefix on the row the absence protocol appends; mirrors catalogWrite's shape. */
export const ABSENCE_NOTE_PREFIX = 'discovery:absence@';

/** Suggestion `source` when a typed sunset's successor came from our own family heuristic. */
export const HEURISTIC_SOURCE = 'heuristic';

/** Suggestion `source` for everything the K-miss protocol raised, successor included. */
export const ABSENCE_SOURCE = 'absence';

/** Statuses a model is out of the pickers in. Entering one is what the report calls a transition. */
const SUNSET_STATUSES: ReadonlySet<string> = new Set(['deprecated', 'legacy', 'retired']);

/**
 * The end of the road. Three uses, all the same idea: a docs row may only
 * corroborate a typed signal into one of these, a model already in one is not
 * re-deprecated, and only a model entering one earns a computed successor.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['deprecated', 'retired']);

/** A version-ish id segment: '4', '4.5', 'v2', '20250219'. Never a family word. */
const VERSION_SEGMENT = /^v?\d[\d.]*$/;

export interface DocsLifecycleSignal {
  modelId: string;
  source: string;
  lifecycle: NonNullable<ModelRecord['lifecycle']>;
  /** True when a typed source sunset the same model this run, which is what lets docs be written. */
  corroborated: boolean;
}

export interface LifecycleSignalsInput {
  contributions: readonly SourceContribution[];
  /** Sources whose parser row count shifted: every docs-derived signal of theirs is dropped. */
  droppedDocsSources?: ReadonlySet<string>;
}

export interface LifecycleSignals {
  /**
   * The contributions the catalog planner may overlay. Every uncorroborated docs
   * lifecycle is removed, because writing `lifecycle.deprecationDate` IS hiding a
   * model - the runtime picker drops it once the date passes - and a parsed page
   * may never do that alone (sec 5.10 tier 2). `replacedBy` is removed even from
   * the corroborated ones: the auto-remap constraints own that field (sec 8).
   */
  contributions: SourceContribution[];
  /** Every docs lifecycle row this run, allowed through or not; the suggestion channel reads it. */
  docs: Map<string, DocsLifecycleSignal>;
}

/**
 * Apply the docs-parser policy to this run's source records.
 *
 * Pure and evidence-driven: a record is docs-tier unless it says otherwise, so a
 * source that forgets to declare a typed feed loses a transition rather than
 * hiding a model on a parse artifact.
 */
export function planLifecycleSignals({ contributions, droppedDocsSources }: LifecycleSignalsInput): LifecycleSignals {
  const ordered = providersFirst(contributions);

  const typedSunsets = new Set<string>();
  for (const contribution of ordered) {
    for (const record of contribution.records) {
      const status = record.patch?.lifecycle?.status;
      if (evidenceOf(record) === 'typed' && status && SUNSET_STATUSES.has(status)) typedSunsets.add(record.modelId);
    }
  }

  const docs = new Map<string, DocsLifecycleSignal>();
  const sanitized = ordered.map(contribution => ({
    ...contribution,
    records: contribution.records.map(record => {
      const lifecycle = record.patch?.lifecycle;
      if (!lifecycle || evidenceOf(record) === 'typed') return record;
      // A parser whose row count moved is not evidence of anything this run, not
      // even of a suggestion: the page it read is not the page it was written for.
      if (droppedDocsSources?.has(contribution.name)) return withoutLifecycle(record);
      // Dates with no status are an announcement, and a parsed page announcing
      // one is not a signal: only a stated status moves a model.
      if (lifecycle.status === undefined) return withoutLifecycle(record);
      const stated: NonNullable<ModelRecord['lifecycle']> = { ...lifecycle, status: lifecycle.status };

      const corroborated = typedSunsets.has(record.modelId) && TERMINAL_STATUSES.has(stated.status);
      // First writer wins, same precedence the field overlay uses.
      if (!docs.has(record.modelId)) {
        docs.set(record.modelId, {
          modelId: record.modelId,
          source: contribution.name,
          lifecycle: stated,
          corroborated,
        });
      }
      // Corroborated docs stay because they carry the precise dates a typed feed
      // rarely publishes; only replacedBy is withheld for the remap gate.
      return corroborated
        ? { ...record, patch: { ...record.patch, lifecycle: omit(stated, 'replacedBy') } }
        : withoutLifecycle(record);
    }),
  }));

  return { contributions: sanitized, docs };
}

export interface ParserRowShift {
  source: string;
  parser: string;
  previous: number;
  current: number;
}

/**
 * Parsers whose row count moved past the tolerance since that source's last
 * successful run. Measured with relativeGap, the same scale-invariant distance
 * the price band uses, so "20%" means one thing across this service. No previous
 * count is no comparison: a first run cannot alarm about a move it never saw.
 */
export function detectParserRowShifts(
  current: ReadonlyMap<string, Record<string, number>>,
  previous: ReadonlyMap<string, Record<string, number>>
): ParserRowShift[] {
  const shifts: ParserRowShift[] = [];
  for (const [source, counts] of current) {
    const before = previous.get(source);
    if (!before) continue;
    for (const [parser, count] of Object.entries(counts)) {
      const was = before[parser];
      if (typeof was !== 'number' || relativeGap(count, was) <= DOCS_PARSER_SHIFT_TOLERANCE) continue;
      shifts.push({ source, parser, previous: was, current: count });
    }
  }
  return shifts.sort((a, b) => a.source.localeCompare(b.source) || a.parser.localeCompare(b.parser));
}

/** Why a computed successor was not written. Each clause is verified on its own (sec 8). */
export type RemapBlocker =
  'unknown-model' | 'not-active' | 'different-backend' | 'cost-not-lower' | 'cost-unverifiable' | 'deprecating-too';

const BLOCKER_TEXT: Readonly<Record<RemapBlocker, string>> = {
  'unknown-model': 'the catalog holds no such model',
  'not-active': 'it is not active',
  'different-backend': 'it is served by another backend',
  'cost-not-lower': 'it costs more than the model it would replace',
  'cost-unverifiable': 'one of the two has no per-token price in force, so the cost clause cannot be verified',
  'deprecating-too': 'it is itself deprecated',
};

export interface LifecyclePlanInput {
  /** This run's catalog plan. Its rows come back with any applied remap folded in. */
  catalogPlan: CatalogWritePlan;
  /** Belief per model from the NON-operator rows in force, as planCatalogWrites took it. */
  base: ReadonlyMap<string, ResolvedCatalogRecord>;
  /**
   * Belief per model from EVERY row in force, operator rows included. The remap
   * constraints and the docs-redundancy check read THIS view: an operator who
   * deprecated a model has ruled it out as a successor, and a lifecycle an
   * operator already recorded is not a queue item. Absent means the base view,
   * which is what it resolves to on a deployment with no operator rows.
   */
  resolvedInForce?: ReadonlyMap<string, ResolvedCatalogRecord>;
  /** Docs signals from planLifecycleSignals, keyed by model. */
  docs: ReadonlyMap<string, DocsLifecycleSignal>;
  /** planAbsence's missed ids: the only models the absence protocol can graduate. */
  missed: readonly string[];
  /**
   * Absence bookkeeping as it stood BEFORE this run's miss was applied. THE
   * ORDERING INVARIANT: this planner adds this run's miss itself, so the caller
   * must read the counters before applyAbsence increments them. That is what
   * makes report mode (which never applies a miss) and write mode decide the
   * same thing on the same evidence.
   */
  statesBeforeRun: ReadonlyMap<string, IModelDiscoveryState>;
  /** Per-token rates in force, the comparable cost the remap constraint reads. */
  ratesInForce: ReadonlyMap<string, PerTokenRates>;
  /**
   * Groups the discovery row in force claims, per model. A graduation row
   * SUPERSEDES that row - rowsInForce keeps one non-operator row per (modelId,
   * source) - so it re-claims what it replaces. Claiming only {lifecycle} would
   * leave the model's identity with no row behind it and drop it from the merge.
   * Absent for a model whose only row is the seed, which keeps backing it.
   */
  priorDiscoveryGroups?: ReadonlyMap<string, readonly FieldGroup[]>;
  autoRemap: DiscoveryAutoRemapPolicy;
  operatorOwnedModelIds: ReadonlySet<string>;
  runStartedAt: Date;
  runId?: string;
}

export interface LifecyclePlan {
  /** The run's final append list: the catalog plan's rows plus the absence graduations. */
  rows: IModelCatalogRowInput[];
  /** Index-aligned with `rows`, same contract as CatalogWritePlan. */
  diff: CatalogDiffEntry[];
  dropped: DroppedSourceRecord[];
  transitions: LifecycleTransition[];
  /** Date moves with no status transition behind them; see LifecycleDateChange. */
  dateChanges: LifecycleDateChange[];
  suggestions: LifecycleSuggestion[];
  /** Models the absence protocol graduated; in report mode, the ones it would have. */
  wouldDeprecate: string[];
}

/** LifecyclePlanInput with the operator-inclusive view resolved, as the helpers read it. */
type PlanContext = LifecyclePlanInput & { resolvedInForce: ReadonlyMap<string, ResolvedCatalogRecord> };

/** One model's lifecycle move before the remap decision has been made about it. */
interface PendingTransition {
  modelId: string;
  from?: string;
  to: string;
  signal: LifecycleSignalKind;
  lifecycle: NonNullable<ModelRecord['lifecycle']>;
  /** Set for an absence graduation: the whole record its row would carry. */
  record?: ModelRecord;
}

/**
 * The lifecycle half of a run: which models sunset, which successor each one
 * gets, and everything discovery believes but is not allowed to write.
 *
 * Computed identically in both modes - report mode is the caller declining to
 * persist it. Diff-based like the planners it composes: a model already settled
 * as deprecated produces no second row, so a permanently missing model costs one
 * append and then nothing.
 */
export function planLifecycle(plannerInput: LifecyclePlanInput): LifecyclePlan {
  const input: PlanContext = { ...plannerInput, resolvedInForce: plannerInput.resolvedInForce ?? plannerInput.base };
  const dropped: DroppedSourceRecord[] = [];
  const typed = typedSignals(input.catalogPlan, input.base);
  const graduated = absenceGraduations(input, dropped);
  const pending = [...typed.transitions, ...graduated];

  // Nothing this run is retiring may be proposed as somebody else's successor.
  const sunsetting = new Set(pending.map(entry => entry.modelId));

  const transitions: LifecycleTransition[] = [];
  const suggestions: LifecycleSuggestion[] = [];
  const applied = new Map<string, string>();

  for (const entry of pending) {
    const remap = TERMINAL_STATUSES.has(entry.to) ? planRemap(entry, input, sunsetting) : undefined;
    const autoApplied = remap !== undefined && remap.blockers.length === 0 && input.autoRemap === 'apply';
    if (remap && autoApplied) applied.set(entry.modelId, remap.candidate);
    else if (remap) {
      suggestions.push({
        modelId: entry.modelId,
        replacedBy: remap.candidate,
        source: suggestionSource(entry, remap, input),
        detail: describeRemap(remap, entry.modelId, input.autoRemap),
      });
    }

    transitions.push({
      modelId: entry.modelId,
      from: entry.from,
      to: entry.to,
      signal: entry.signal,
      deprecationDate: entry.lifecycle.deprecationDate,
      retirementDate: entry.lifecycle.retirementDate,
      replacedBy: autoApplied ? remap?.candidate : undefined,
      autoApplied,
    });
  }

  for (const signal of docsSuggestions(input, sunsetting)) suggestions.push(signal);

  const rows = input.catalogPlan.rows.map(row => {
    const replacedBy = applied.get(row.modelId);
    return replacedBy && row.source === 'discovery' && row.patch.lifecycle
      ? { ...row, patch: { ...row.patch, lifecycle: { ...row.patch.lifecycle, replacedBy } } }
      : row;
  });
  const diff = [...input.catalogPlan.diff];

  for (const entry of graduated) {
    if (!entry.record) continue;
    const replacedBy = applied.get(entry.modelId);
    const lifecycle = replacedBy ? { ...entry.lifecycle, replacedBy } : entry.lifecycle;
    const record = { ...entry.record, lifecycle };
    const ownedGroups = groupsFor(record, input.priorDiscoveryGroups?.get(entry.modelId));
    rows.push({
      modelId: entry.modelId,
      source: 'discovery',
      patch: record,
      ownedGroups,
      effectiveFrom: input.runStartedAt,
      contributors: ownedGroups.map(group => ({ group, source: DISCOVERY_CONTRIBUTOR })),
      note: `${ABSENCE_NOTE_PREFIX}${input.runStartedAt.toISOString()}`,
      runId: input.runId,
    });
    diff.push({
      modelId: entry.modelId,
      kind: 'updated',
      ownedGroups,
      // The other groups are restated, not changed: this row exists to move one key.
      changedKeys: ['lifecycle'],
      lifecycleStatus: lifecycle.status,
      promoted: false,
      blockedBy: [],
      operatorOwned: input.operatorOwnedModelIds.has(entry.modelId),
    });
  }

  return {
    rows,
    diff,
    dropped,
    transitions,
    dateChanges: typed.dateChanges,
    suggestions,
    wouldDeprecate: graduated.map(entry => entry.modelId),
  };
}

/**
 * What the queue credits for raising the item. A graduation belongs to the
 * absence protocol whoever named the successor - the operator is being asked
 * about a model that vanished - and the detail line says how it was picked.
 */
function suggestionSource(entry: PendingTransition, remap: RemapDecision, input: PlanContext): string {
  if (entry.signal === 'absence') return ABSENCE_SOURCE;
  return remap.origin === 'declared' ? (input.docs.get(entry.modelId)?.source ?? HEURISTIC_SOURCE) : HEURISTIC_SOURCE;
}

/**
 * Lifecycle moves the catalog plan already carries. Read off the planned rows
 * rather than recomputed from the sources, so the report can never name a change
 * the run would not actually append.
 */
function typedSignals(
  plan: CatalogWritePlan,
  base: ReadonlyMap<string, ResolvedCatalogRecord>
): { transitions: PendingTransition[]; dateChanges: LifecycleDateChange[] } {
  const transitions: PendingTransition[] = [];
  const dateChanges: LifecycleDateChange[] = [];

  for (const row of plan.rows) {
    if (row.source !== 'discovery') continue;
    const lifecycle = row.patch.lifecycle;
    if (!lifecycle) continue;
    const held = lifecycleOf(base.get(row.modelId));
    const from = held?.status;

    if (SUNSET_STATUSES.has(lifecycle.status) && from !== lifecycle.status) {
      transitions.push({ modelId: row.modelId, from, to: lifecycle.status, signal: 'typed', lifecycle });
      continue;
    }
    // No transition, but a date the catalog did not carry IS a delayed hide: the
    // picker drops the model the day it passes, so it has to reach the report.
    if (sameDates(held, lifecycle)) continue;
    dateChanges.push({
      modelId: row.modelId,
      status: lifecycle.status,
      signal: 'typed',
      previousDeprecationDate: held?.deprecationDate,
      deprecationDate: lifecycle.deprecationDate,
      previousRetirementDate: held?.retirementDate,
      retirementDate: lifecycle.retirementDate,
    });
  }

  return { transitions, dateChanges };
}

const sameDates = (held: HeldLifecycle | undefined, next: NonNullable<ModelRecord['lifecycle']>): boolean =>
  (held?.deprecationDate ?? null) === (next.deprecationDate ?? null) &&
  (held?.retirementDate ?? null) === (next.retirementDate ?? null);

function absenceGraduations(input: PlanContext, dropped: DroppedSourceRecord[]): PendingTransition[] {
  const graduated: PendingTransition[] = [];
  const deprecationDate = input.runStartedAt.toISOString().slice(0, 10);

  for (const modelId of input.missed) {
    const existing = input.base.get(modelId);
    if (!existing) continue;
    const from = statusOf(existing);
    if (from && TERMINAL_STATUSES.has(from)) continue;

    const state = input.statesBeforeRun.get(modelId);
    // This run's miss is the +1 the caller has not applied yet, and with no state
    // row at all it is also the miss that starts the streak.
    const misses = (state?.missCount ?? 0) + 1;
    const streakFrom = state?.firstMissAt ?? input.runStartedAt;
    if (misses < ABSENCE_MISS_THRESHOLD) continue;
    if (input.runStartedAt.getTime() - streakFrom.getTime() < ABSENCE_MIN_STREAK_MS) continue;

    const lifecycle = { status: 'deprecated' as const, deprecationDate };
    const parsed = ModelRecordWrite.safeParse({ ...existing.record, lifecycle });
    if (!parsed.success) {
      dropped.push({
        source: ABSENCE_SOURCE,
        modelId,
        reason: `absence graduation failed the append schema: ${parsed.error.issues.map(issue => issue.message).join('; ')}`,
      });
      continue;
    }
    graduated.push({ modelId, from, to: 'deprecated', signal: 'absence', lifecycle, record: parsed.data });
  }

  return graduated;
}

interface RemapDecision {
  candidate: string;
  origin: 'declared' | 'heuristic';
  blockers: RemapBlocker[];
}

/**
 * The successor for a model this run retires: the provider's own advice when
 * there is any, else the family heuristic. Even an uncorroborated docs page may
 * name one - suggesting a replacement is exactly what a docs signal is allowed
 * to do; the constraints below decide whether it may be written.
 */
function planRemap(
  entry: PendingTransition,
  input: PlanContext,
  sunsetting: ReadonlySet<string>
): RemapDecision | undefined {
  const declared = input.docs.get(entry.modelId)?.lifecycle.replacedBy;
  const candidate = declared ?? heuristicSuccessor(entry.modelId, input, sunsetting);
  if (!candidate) return undefined;
  return {
    candidate,
    origin: declared ? 'declared' : 'heuristic',
    blockers: verifyReplacement(candidate, entry.modelId, input, sunsetting),
  };
}

/**
 * The sec 8 auto-remap constraints, each checked independently so the failure
 * report names every clause the candidate missed rather than the first one.
 */
function verifyReplacement(
  candidateId: string,
  modelId: string,
  input: PlanContext,
  sunsetting: ReadonlySet<string>
): RemapBlocker[] {
  if (candidateId === modelId) return ['deprecating-too'];
  const candidate = input.resolvedInForce.get(candidateId);
  // Nothing else can be read off a model the catalog does not hold, and an
  // unverifiable clause is a failed clause.
  if (!candidate) return ['unknown-model'];

  const blockers: RemapBlocker[] = [];
  if (statusOf(candidate) !== 'active') blockers.push('not-active');
  if (backendOf(candidate) !== backendOf(input.resolvedInForce.get(modelId))) blockers.push('different-backend');
  if (sunsetting.has(candidateId)) blockers.push('deprecating-too');
  const cost = costClause(candidateId, modelId, input.ratesInForce);
  if (cost) blockers.push(cost);
  return blockers;
}

/**
 * The cost clause: the replacement may not raise the bill. A missing row on
 * either side fails it too - unverifiable is not verified - and is reported
 * separately, because "we cannot tell" is a different work item from "it is
 * more expensive".
 */
function costClause(
  candidateId: string,
  modelId: string,
  ratesInForce: ReadonlyMap<string, PerTokenRates>
): RemapBlocker | null {
  const replacement = ratesInForce.get(candidateId);
  const current = ratesInForce.get(modelId);
  if (!replacement || !current) return 'cost-unverifiable';
  return replacement.input <= current.input && replacement.output <= current.output ? null : 'cost-not-lower';
}

/**
 * Same backend, same model type, active, and sharing the leading family words of
 * the deprecated id once versions and dates come off - which is what makes
 * `claude-3-opus` and `claude-opus-4-5` both read as claude/opus. Longest shared
 * family wins, then the nearest rank, then the id, so a run is reproducible.
 */
function heuristicSuccessor(modelId: string, input: PlanContext, sunsetting: ReadonlySet<string>): string | undefined {
  const target = input.resolvedInForce.get(modelId);
  if (!target) return undefined;
  const segments = familySegments(modelId);
  const backend = backendOf(target);
  const type = target.record.type;
  const rank = numberOf(target.record.rank);

  let best: { id: string; shared: number; distance: number } | undefined;
  for (const [candidateId, candidate] of input.resolvedInForce) {
    if (candidateId === modelId || sunsetting.has(candidateId)) continue;
    if (statusOf(candidate) !== 'active') continue;
    if (backendOf(candidate) !== backend || candidate.record.type !== type) continue;

    const shared = sharedSegments(segments, familySegments(candidateId));
    if (shared === 0) continue;
    const candidateRank = numberOf(candidate.record.rank);
    const distance =
      rank !== undefined && candidateRank !== undefined ? Math.abs(candidateRank - rank) : Number.POSITIVE_INFINITY;

    const better =
      !best ||
      shared > best.shared ||
      (shared === best.shared && (distance < best.distance || (distance === best.distance && candidateId < best.id)));
    if (better) best = { id: candidateId, shared, distance };
  }

  return best?.id;
}

/**
 * Docs signals nothing acted on. They are the queue item sec 5.10 asks for: the
 * page says a model is going away, no typed feed agrees, so an operator decides.
 */
function docsSuggestions(input: PlanContext, sunsetting: ReadonlySet<string>): LifecycleSuggestion[] {
  const suggestions: LifecycleSuggestion[] = [];
  for (const signal of input.docs.values()) {
    if (signal.corroborated || sunsetting.has(signal.modelId)) continue;
    // Every sunset status, 'legacy' included: a docs row nothing corroborates is
    // a queue item, and a legacy one that raised nothing simply vanished.
    if (!SUNSET_STATUSES.has(signal.lifecycle.status)) continue;
    const existing = input.resolvedInForce.get(signal.modelId);
    // A model the catalog does not hold has no lifecycle to move, and one the
    // catalog already agrees with would re-queue the same item every run.
    if (!existing || agreesWith(existing, signal.lifecycle)) continue;

    suggestions.push({
      modelId: signal.modelId,
      status: signal.lifecycle.status,
      deprecationDate: signal.lifecycle.deprecationDate,
      retirementDate: signal.lifecycle.retirementDate,
      replacedBy: signal.lifecycle.replacedBy,
      source: signal.source,
      detail:
        `${signal.source} documents this model as ${signal.lifecycle.status}` +
        `${signal.lifecycle.retirementDate ? ` (retirement ${signal.lifecycle.retirementDate})` : ''}; ` +
        'no typed feed corroborates it, so a parsed page alone may not hide the model',
    });
  }
  return suggestions;
}

function describeRemap(remap: RemapDecision, modelId: string, autoRemap: DiscoveryAutoRemapPolicy): string {
  const origin = remap.origin === 'declared' ? 'the provider names' : 'the family heuristic picks';
  if (remap.blockers.length > 0) {
    return `${origin} ${remap.candidate} to replace ${modelId}, but ${remap.blockers.map(blocker => BLOCKER_TEXT[blocker]).join('; ')}`;
  }
  return `${origin} ${remap.candidate} to replace ${modelId} and it passes every constraint; modelDiscoveryAutoRemap is '${autoRemap}', so applying it is an admin decision`;
}

/**
 * What a graduation row claims: lifecycle plus whatever the discovery row it
 * supersedes claimed, intersected with the groups its record actually supplies
 * so the append schema's "no overclaiming" rule always holds.
 */
function groupsFor(record: ModelRecord, prior: readonly FieldGroup[] | undefined): FieldGroup[] {
  const supplied = new Set(groupsTouchedByPatch(record as unknown as Record<string, unknown>));
  const claimed = new Set<FieldGroup>(['lifecycle']);
  for (const group of prior ?? []) if (supplied.has(group)) claimed.add(group);
  return FIELD_GROUPS.filter(group => claimed.has(group));
}

const evidenceOf = (record: DiscoveredModel): LifecycleEvidence =>
  record.lifecycleEvidence === 'typed' ? 'typed' : 'docs';

const withoutLifecycle = (record: DiscoveredModel): DiscoveredModel => ({
  ...record,
  patch: omit(record.patch, 'lifecycle'),
});

/** Providers ahead of aggregators, registration order within a kind (catalogWrite's rule). */
const providersFirst = (contributions: readonly SourceContribution[]): SourceContribution[] =>
  [...contributions].sort((a, b) => (a.kind === 'provider' ? 0 : 1) - (b.kind === 'provider' ? 0 : 1));

/**
 * The family words of an id. Normalized through the aggregator normalizer (sec
 * 5.6) so region prefixes, trailing dates and -vN suffixes come off in exactly
 * one place in this repo; our own ids carry no aggregator namespace, so for them
 * that normalizer reduces to precisely the stripping a family key wants.
 */
const familySegments = (modelId: string): string[] =>
  normalizeAggregatorKey(modelId, 'modelsDev')
    .split(/[.\-_:/]+/)
    .filter(segment => segment.length > 0 && !VERSION_SEGMENT.test(segment));

function sharedSegments(a: readonly string[], b: readonly string[]): number {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  return shared;
}

function agreesWith(resolved: ResolvedCatalogRecord, lifecycle: NonNullable<ModelRecord['lifecycle']>): boolean {
  const held = lifecycleOf(resolved);
  return (
    held?.status === lifecycle.status &&
    (held?.deprecationDate ?? null) === (lifecycle.deprecationDate ?? null) &&
    (held?.retirementDate ?? null) === (lifecycle.retirementDate ?? null)
  );
}

interface HeldLifecycle {
  status?: string;
  deprecationDate?: string;
  retirementDate?: string;
}

/** lifecycle off a resolved record, which is unnarrowed by construction. */
function lifecycleOf(resolved: ResolvedCatalogRecord | undefined): HeldLifecycle | undefined {
  const lifecycle = resolved?.record.lifecycle;
  if (!lifecycle || typeof lifecycle !== 'object') return undefined;
  const held = lifecycle as Record<string, unknown>;
  return {
    status: stringOf(held.status),
    deprecationDate: stringOf(held.deprecationDate),
    retirementDate: stringOf(held.retirementDate),
  };
}

const statusOf = (resolved: ResolvedCatalogRecord | undefined): string | undefined => lifecycleOf(resolved)?.status;

const backendOf = (resolved: ResolvedCatalogRecord | undefined): string | undefined =>
  stringOf(resolved?.record.backend);

const stringOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const numberOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
