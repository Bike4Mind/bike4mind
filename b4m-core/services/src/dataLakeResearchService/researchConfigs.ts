import type {
  IDataLakeResearchConfigDocument,
  IDataLakeResearchConfigRepository,
  ResearchRunLevers,
  ResearchRunTrigger,
  ResearchScheduleCadence,
} from '@bike4mind/common';
import { RESEARCH_CONFIG_NAME_MAX_CHARS } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { researchConfigChange } from '../dataLakeService/diffLakeConfig';
import type { LakeGrant, ManageActor } from '../dataLakeService/manageRule';
import {
  recordLakeConfigChange,
  type LakeConfigAuditAdapters,
  type LakeConfigAuditLakeRef,
} from '../dataLakeService/recordLakeConfigChange';
import { normalizeResearchLevers, type ResearchLeversDraft } from './researchLevers';
import { firstResearchRunAt, normalizeReviewBacklogLimit } from './researchSchedule';

/**
 * CRUD for the saved run configuration (#1682). Thin on purpose: the caller has already gated the
 * lake (read gate then manage gate, the same pair the proposal routes use), so what is left here is
 * normalization and the schedule, which is not a lever.
 */

export interface ResearchConfigAdapters extends LakeConfigAuditAdapters {
  db: LakeConfigAuditAdapters['db'] & {
    dataLakeResearchConfigs: Pick<
      IDataLakeResearchConfigRepository,
      'createConfig' | 'listByLake' | 'findByIdInLake' | 'updateConfig' | 'deleteConfig'
    >;
    // REQUIRED, not optional: every caller of these writes is one of the two research-config
    // routes, so leaving it optional would let a create/edit/delete go unaudited silently.
    lakeConfigChangeEvents: NonNullable<LakeConfigAuditAdapters['db']['lakeConfigChangeEvents']>;
  };
  now?: () => Date;
}

/** The schedule half of a create or update request. */
export interface ResearchScheduleDraft {
  trigger?: ResearchRunTrigger;
  cadence?: ResearchScheduleCadence;
  reviewBacklogLimit?: number;
}

/** How many saved configs one lake may hold, so a config list stays a list a human reads. */
export const RESEARCH_CONFIGS_PER_LAKE_MAX = 20;

const normalizeName = (name: unknown): string => {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw new BadRequestError('A research configuration needs a name');
  return trimmed.slice(0, RESEARCH_CONFIG_NAME_MAX_CHARS);
};

const triggerFor = (cadence: ResearchScheduleCadence): ResearchRunTrigger =>
  cadence === 'off' ? 'on_demand' : 'periodic';

/**
 * The cadence is the schedule; `trigger` is derived from it. A caller may still send `trigger`, but
 * only one that agrees: a `periodic` config with no cadence, or a one-off `scheduled` run nothing
 * fires, would save a setting that silently does nothing - worse than a refusal.
 */
const resolveCadence = (
  { trigger, cadence }: ResearchScheduleDraft,
  current: ResearchScheduleCadence
): ResearchScheduleCadence => {
  if (trigger === 'scheduled') {
    throw new BadRequestError('One-off scheduled research runs are not supported; set a cadence instead');
  }
  const resolved = cadence ?? current;
  if (trigger && trigger !== triggerFor(resolved)) {
    throw new BadRequestError(
      resolved === 'off'
        ? 'A periodic research configuration needs a cadence'
        : 'An on-demand research configuration cannot have a cadence'
    );
  }
  return resolved;
};

export async function createResearchConfig(
  lake: LakeConfigAuditLakeRef,
  actor: ManageActor,
  grants: readonly LakeGrant[],
  input: { name: string } & ResearchScheduleDraft & ResearchLeversDraft,
  { db, logger, now = () => new Date() }: ResearchConfigAdapters
): Promise<IDataLakeResearchConfigDocument> {
  const existing = await db.dataLakeResearchConfigs.listByLake(lake.id);
  if (existing.length >= RESEARCH_CONFIGS_PER_LAKE_MAX) {
    throw new BadRequestError(
      `This data lake already has the maximum of ${RESEARCH_CONFIGS_PER_LAKE_MAX} research configurations`
    );
  }

  const name = normalizeName(input.name);
  const cadence = resolveCadence(input, 'off');
  const firstRunAt = firstResearchRunAt(cadence, now());
  const created = await db.dataLakeResearchConfigs.createConfig({
    dataLakeId: lake.id,
    name,
    trigger: triggerFor(cadence),
    cadence,
    reviewBacklogLimit: normalizeReviewBacklogLimit(input.reviewBacklogLimit),
    nextRunAt: firstRunAt,
    scheduleAnchorAt: firstRunAt,
    createdByUserId: actor.userId,
    ...normalizeResearchLevers(input),
  });

  // `grants` comes from the caller's own gate (assertLakeResearchManage), not re-fetched here -
  // the gate and the recorded manage rung must agree on the same grant set, the same reasoning
  // reviewDataLakeProposal's resolveReviewable applies to its own reused grants.
  await recordLakeConfigChange(
    { actor, lake, grants, action: 'create-research-config', changes: [researchConfigChange(name, 'created')] },
    { db, logger }
  );

  return created;
}

const sameValue = <T extends string | number | boolean>(a: T, b: T) => a === b;
// `recencyDays`/`model` are coerced to `null` on both sides, matching how each is stored on update.
const sameNullable = <T>(a: T | undefined, b: T | undefined) => (a ?? null) === (b ?? null);
// Set semantics: a reordered resubmit of the same domains/tags is not an edit.
const sameStringSet = (a: readonly string[], b: readonly string[]) => {
  const setA = new Set(a);
  const setB = new Set(b);
  return setA.size === setB.size && [...setA].every(value => setB.has(value));
};

// Derived from ResearchRunLevers so a new lever without a comparer is a compile error, not a
// silently-ignored edit that records no History event.
const LEVER_EQUALITY: {
  [K in keyof ResearchRunLevers]-?: (a: ResearchRunLevers[K], b: ResearchRunLevers[K]) => boolean;
} = {
  query: sameValue,
  model: sameNullable,
  maxResults: sameValue,
  maxProposals: sameValue,
  recencyDays: sameNullable,
  allowedDomains: sameStringSet,
  blockedDomains: sameStringSet,
  minRelevance: sameValue,
  costCeilingMicroUsd: sameValue,
  proposedTags: sameStringSet,
};

const leversMoved = (next: ResearchRunLevers, current: ResearchRunLevers) =>
  (Object.keys(LEVER_EQUALITY) as (keyof ResearchRunLevers)[]).some(
    // The union of per-key comparers cannot be called with a union key; each pair is type-matched by the map above.
    key => !(LEVER_EQUALITY[key] as (a: unknown, b: unknown) => boolean)(next[key], current[key])
  );

export function listResearchConfigs(
  dataLakeId: string,
  { db }: ResearchConfigAdapters
): Promise<IDataLakeResearchConfigDocument[]> {
  return db.dataLakeResearchConfigs.listByLake(dataLakeId);
}

export async function updateResearchConfig(
  configId: string,
  lake: LakeConfigAuditLakeRef,
  actor: ManageActor,
  grants: readonly LakeGrant[],
  input: { name?: string } & ResearchScheduleDraft & ResearchLeversDraft,
  { db, logger, now = () => new Date() }: ResearchConfigAdapters
): Promise<IDataLakeResearchConfigDocument> {
  const existing = await db.dataLakeResearchConfigs.findByIdInLake(configId, lake.id);
  if (!existing) throw new NotFoundError('Research configuration not found');

  // A config saved before scheduling existed has no stored cadence; it reads as `off`.
  const currentCadence = existing.cadence ?? 'off';
  const cadence = resolveCadence(input, currentCadence);
  // The next slot is only reset when the cadence CHANGES, so editing a query does not push a
  // config's upcoming run a whole period out. The last outcome belonged to the old schedule.
  const firstRunAt = firstResearchRunAt(cadence, now());
  const schedule =
    cadence !== currentCadence
      ? {
          cadence,
          trigger: triggerFor(cadence),
          nextRunAt: firstRunAt,
          scheduleAnchorAt: firstRunAt,
          lastScheduledOutcome: null,
        }
      : {};

  // Normalized over the MERGE of stored and incoming, not over the patch alone: normalization needs
  // the whole lever set (an absent `query` in a patch is "unchanged", but to the normalizer an
  // absent query is a refusal), and re-normalizing the merge is also what re-clamps a stored value
  // that a tightened bound has since put out of range.
  const merged = normalizeResearchLevers({ ...existing, ...input });
  // Compared per lever via LEVER_EQUALITY, not a JSON.stringify of two object literals:
  // `normalizeResearchLevers` omits `model`/`recencyDays` when unset, so key order differs between
  // `merged` and a hand-built object and a byte-identical default-config resubmit would read as changed.
  const nextName = input.name !== undefined ? normalizeName(input.name) : existing.name;
  const nothingMoved = nextName === existing.name && !leversMoved(merged, existing);

  const updated = await db.dataLakeResearchConfigs.updateConfig(configId, lake.id, {
    ...merged,
    // Explicitly cleared rather than left off: `normalizeResearchLevers` OMITS `recencyDays` and
    // `model` when they are unset, and `$set` of a partial would leave the previous value in place -
    // so a user clearing either field would watch it come straight back.
    recencyDays: merged.recencyDays ?? null,
    model: merged.model ?? null,
    ...(input.name !== undefined ? { name: nextName } : {}),
    ...schedule,
    ...(input.reviewBacklogLimit !== undefined
      ? { reviewBacklogLimit: normalizeReviewBacklogLimit(input.reviewBacklogLimit) }
      : {}),
    lastUpdatedByUserId: actor.userId,
  });

  if (!updated) throw new NotFoundError('Research configuration not found');

  // An idempotent PUT (the submitted body matches what is already stored) genuinely changed
  // nothing, so it earns no `researchConfig: updated: <name>` row - a resubmit-without-edits is not
  // an event a History reader needs to see.
  if (!nothingMoved) {
    await recordLakeConfigChange(
      {
        actor,
        lake,
        grants,
        action: 'update-research-config',
        // The UPDATED document's own name, not the input: an edit that never touched `name` still
        // reads by its current name here rather than by whatever this caller happened to submit.
        changes: [researchConfigChange(updated.name, 'updated')],
      },
      { db, logger }
    );
  }

  return updated;
}

export async function deleteResearchConfig(
  configId: string,
  lake: LakeConfigAuditLakeRef,
  actor: ManageActor,
  grants: readonly LakeGrant[],
  { db, logger }: ResearchConfigAdapters
): Promise<void> {
  const existing = await db.dataLakeResearchConfigs.findByIdInLake(configId, lake.id);
  if (!existing) throw new NotFoundError('Research configuration not found');

  const deleted = await db.dataLakeResearchConfigs.deleteConfig(configId, lake.id);
  if (!deleted) throw new NotFoundError('Research configuration not found');
  // Run history is deliberately NOT swept with the config: a row is what a proposal's `runId`
  // points at, and those proposals outlive the config that produced them.

  await recordLakeConfigChange(
    {
      actor,
      lake,
      grants,
      action: 'delete-research-config',
      changes: [researchConfigChange(existing.name, 'deleted')],
    },
    { db, logger }
  );
}
