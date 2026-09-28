import type {
  IDataLakeResearchConfigDocument,
  IDataLakeResearchConfigRepository,
  ResearchRunTrigger,
  ResearchScheduleCadence,
} from '@bike4mind/common';
import { RESEARCH_CONFIG_NAME_MAX_CHARS } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { normalizeResearchLevers, type ResearchLeversDraft } from './researchLevers';
import { firstResearchRunAt, normalizeReviewBacklogLimit } from './researchSchedule';

/**
 * CRUD for the saved run configuration (#1682). Thin on purpose: the caller has already gated the
 * lake (read gate then manage gate, the same pair the proposal routes use), so what is left here is
 * normalization and the schedule, which is not a lever.
 */

export interface ResearchConfigAdapters {
  db: {
    dataLakeResearchConfigs: Pick<
      IDataLakeResearchConfigRepository,
      'createConfig' | 'listByLake' | 'findByIdInLake' | 'updateConfig' | 'deleteConfig'
    >;
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
  dataLakeId: string,
  actorUserId: string,
  input: { name: string } & ResearchScheduleDraft & ResearchLeversDraft,
  { db, now = () => new Date() }: ResearchConfigAdapters
): Promise<IDataLakeResearchConfigDocument> {
  const existing = await db.dataLakeResearchConfigs.listByLake(dataLakeId);
  if (existing.length >= RESEARCH_CONFIGS_PER_LAKE_MAX) {
    throw new BadRequestError(
      `This data lake already has the maximum of ${RESEARCH_CONFIGS_PER_LAKE_MAX} research configurations`
    );
  }

  const cadence = resolveCadence(input, 'off');
  return db.dataLakeResearchConfigs.createConfig({
    dataLakeId,
    name: normalizeName(input.name),
    trigger: triggerFor(cadence),
    cadence,
    reviewBacklogLimit: normalizeReviewBacklogLimit(input.reviewBacklogLimit),
    nextRunAt: firstResearchRunAt(cadence, now()),
    createdByUserId: actorUserId,
    ...normalizeResearchLevers(input),
  });
}

export function listResearchConfigs(
  dataLakeId: string,
  { db }: ResearchConfigAdapters
): Promise<IDataLakeResearchConfigDocument[]> {
  return db.dataLakeResearchConfigs.listByLake(dataLakeId);
}

export async function updateResearchConfig(
  configId: string,
  dataLakeId: string,
  actorUserId: string,
  input: { name?: string } & ResearchScheduleDraft & ResearchLeversDraft,
  { db, now = () => new Date() }: ResearchConfigAdapters
): Promise<IDataLakeResearchConfigDocument> {
  const existing = await db.dataLakeResearchConfigs.findByIdInLake(configId, dataLakeId);
  if (!existing) throw new NotFoundError('Research configuration not found');

  // A config saved before scheduling existed has no stored cadence; it reads as `off`.
  const currentCadence = existing.cadence ?? 'off';
  const cadence = resolveCadence(input, currentCadence);
  // The next slot is only reset when the cadence CHANGES, so editing a query does not push a
  // config's upcoming run a whole period out. The last outcome belonged to the old schedule.
  const schedule =
    cadence !== currentCadence
      ? {
          cadence,
          trigger: triggerFor(cadence),
          nextRunAt: firstResearchRunAt(cadence, now()),
          lastScheduledOutcome: null,
        }
      : {};

  // Normalized over the MERGE of stored and incoming, not over the patch alone: normalization needs
  // the whole lever set (an absent `query` in a patch is "unchanged", but to the normalizer an
  // absent query is a refusal), and re-normalizing the merge is also what re-clamps a stored value
  // that a tightened bound has since put out of range.
  const merged = normalizeResearchLevers({ ...existing, ...input });

  const updated = await db.dataLakeResearchConfigs.updateConfig(configId, dataLakeId, {
    ...merged,
    // Explicitly cleared rather than left off: `normalizeResearchLevers` OMITS `recencyDays` and
    // `model` when they are unset, and `$set` of a partial would leave the previous value in place -
    // so a user clearing either field would watch it come straight back.
    recencyDays: merged.recencyDays ?? null,
    model: merged.model ?? null,
    ...(input.name !== undefined ? { name: normalizeName(input.name) } : {}),
    ...schedule,
    ...(input.reviewBacklogLimit !== undefined
      ? { reviewBacklogLimit: normalizeReviewBacklogLimit(input.reviewBacklogLimit) }
      : {}),
    lastUpdatedByUserId: actorUserId,
  });

  if (!updated) throw new NotFoundError('Research configuration not found');
  return updated;
}

export async function deleteResearchConfig(
  configId: string,
  dataLakeId: string,
  { db }: ResearchConfigAdapters
): Promise<void> {
  const deleted = await db.dataLakeResearchConfigs.deleteConfig(configId, dataLakeId);
  if (!deleted) throw new NotFoundError('Research configuration not found');
  // Run history is deliberately NOT swept with the config: a run row is what a proposal's
  // `runId` points at, and those proposals outlive the config that produced them.
}
