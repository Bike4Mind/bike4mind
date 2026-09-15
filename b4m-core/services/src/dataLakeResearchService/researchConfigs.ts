import type {
  IDataLakeResearchConfigDocument,
  IDataLakeResearchConfigRepository,
  ResearchRunTrigger,
} from '@bike4mind/common';
import { RESEARCH_CONFIG_NAME_MAX_CHARS } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { normalizeResearchLevers, type ResearchLeversDraft } from './researchLevers';

/**
 * CRUD for the saved run configuration (#1682). Thin on purpose: the caller has already gated the
 * lake (read gate then manage gate, the same pair the proposal routes use), so what is left here is
 * normalization and the one rule that is not a lever - v1 accepts only `on_demand`.
 */

export interface ResearchConfigAdapters {
  db: {
    dataLakeResearchConfigs: Pick<
      IDataLakeResearchConfigRepository,
      'createConfig' | 'listByLake' | 'findByIdInLake' | 'updateConfig' | 'deleteConfig'
    >;
  };
}

/** How many saved configs one lake may hold, so a config list stays a list a human reads. */
export const RESEARCH_CONFIGS_PER_LAKE_MAX = 20;

const normalizeName = (name: unknown): string => {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw new BadRequestError('A research configuration needs a name');
  return trimmed.slice(0, RESEARCH_CONFIG_NAME_MAX_CHARS);
};

/**
 * v1 is user-triggered, full stop. The other two triggers are storable so that v2 is a scheduling
 * change rather than a schema change, but accepting one now would save a config nothing will ever
 * run - a setting that silently does nothing, which is worse than a refusal.
 */
const assertSupportedTrigger = (trigger: ResearchRunTrigger | undefined): ResearchRunTrigger => {
  if (trigger && trigger !== 'on_demand') {
    throw new BadRequestError('Scheduled and periodic research runs are not available yet; use on-demand');
  }
  return 'on_demand';
};

export async function createResearchConfig(
  dataLakeId: string,
  actorUserId: string,
  input: { name: string; trigger?: ResearchRunTrigger } & ResearchLeversDraft,
  { db }: ResearchConfigAdapters
): Promise<IDataLakeResearchConfigDocument> {
  const existing = await db.dataLakeResearchConfigs.listByLake(dataLakeId);
  if (existing.length >= RESEARCH_CONFIGS_PER_LAKE_MAX) {
    throw new BadRequestError(
      `This data lake already has the maximum of ${RESEARCH_CONFIGS_PER_LAKE_MAX} research configurations`
    );
  }

  return db.dataLakeResearchConfigs.createConfig({
    dataLakeId,
    name: normalizeName(input.name),
    trigger: assertSupportedTrigger(input.trigger),
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
  input: { name?: string } & ResearchLeversDraft,
  { db }: ResearchConfigAdapters
): Promise<IDataLakeResearchConfigDocument> {
  const existing = await db.dataLakeResearchConfigs.findByIdInLake(configId, dataLakeId);
  if (!existing) throw new NotFoundError('Research configuration not found');

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
