import { dataLakeResearchService } from '@bike4mind/services';
import {
  withTransaction,
  dataLakeProposalRepository,
  dataLakeResearchConfigRepository,
  dataLakeRepository,
  lakeConfigSnapshotRepository,
} from '@bike4mind/database';
import {
  RESEARCH_RUN_TRIGGERS,
  type AccessContext,
  type IDataLakeResearchConfigDocument,
  type ResearchKeysetPage,
} from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import type { Request } from 'express';
import { z } from 'zod';
import { assertLakeResearchManage } from '@server/dataLakes/assertLakeResearchManage';
import { ResearchLeversInput, ResearchScheduleInput } from '@server/dataLakes/researchConfigInput';
import { lakeConfigAuditDb } from '@bike4mind/server-utils/dataLakes/lakeConfigAuditDb';

/*
 * Config handler bodies shared by the SPA routes and the public v1 routes. The caller resolves the
 * access context (admin bypass for the SPA, none for v1) and, for writes, hands the input as a thunk
 * so it is still parsed AFTER the manage gate: a caller who may not manage the lake must not be able
 * to probe the request schema by reading which field it complains about.
 */

export const CreateResearchConfigInput = ResearchLeversInput.merge(ResearchScheduleInput).extend({
  name: z.string(),
  // Accepted so a client can be explicit; the service refuses one that disagrees with the cadence
  // rather than silently saving a config whose trigger field means nothing.
  trigger: z.enum(RESEARCH_RUN_TRIGGERS).optional(),
});

export const UpdateResearchConfigInput = ResearchLeversInput.merge(ResearchScheduleInput).extend({
  name: z.string().optional(),
});

const db = {
  dataLakeResearchConfigs: dataLakeResearchConfigRepository,
  lakeConfigSnapshots: lakeConfigSnapshotRepository,
  ...lakeConfigAuditDb,
};

export async function listLakeResearchConfigs(
  req: Request,
  lakeId: string,
  ctx: AccessContext,
  parsePage: () => ResearchKeysetPage = () => ({})
): Promise<{ configs: IDataLakeResearchConfigDocument[]; pendingProposals: number }> {
  const { lake } = await assertLakeResearchManage(req, lakeId, ctx);
  const page = parsePage();
  const [configs, pendingByLake] = await Promise.all([
    dataLakeResearchService.listResearchConfigs(lake.id, { db }, page),
    dataLakeProposalRepository.countPendingByLakes([lake.id]),
  ]);
  return { configs, pendingProposals: pendingByLake[lake.id] ?? 0 };
}

export async function getLakeResearchConfig(
  req: Request,
  lakeId: string,
  configId: string,
  ctx: AccessContext
): Promise<IDataLakeResearchConfigDocument> {
  const { lake } = await assertLakeResearchManage(req, lakeId, ctx);
  const found = await dataLakeResearchConfigRepository.findByIdInLake(configId, lake.id);
  if (!found) throw new NotFoundError('Research configuration not found');
  return found;
}

export async function createLakeResearchConfig(
  req: Request,
  lakeId: string,
  ctx: AccessContext,
  parseInput: () => z.infer<typeof CreateResearchConfigInput>
): Promise<IDataLakeResearchConfigDocument> {
  // The manage gate runs inside the transaction so a grant revoke committing mid-request collides
  // on the lake doc and the retry re-reads live grants.
  return withTransaction(async () => {
    const { lake, actor, grants } = await assertLakeResearchManage(req, lakeId, ctx);
    const input = parseInput();

    const created = await dataLakeResearchService.createResearchConfig(lake, actor, grants, input, {
      db,
      logger: req.logger,
    });
    // Serializes this write against a concurrent grant revoke - see WRITE-TIME RESIDUAL on `canManageLake`.
    await dataLakeRepository.touchIfStable(lake.id);
    return created;
  });
}

export async function updateLakeResearchConfig(
  req: Request,
  lakeId: string,
  configId: string,
  ctx: AccessContext,
  parseInput: () => z.infer<typeof UpdateResearchConfigInput>
): Promise<IDataLakeResearchConfigDocument> {
  return withTransaction(async () => {
    const { lake, actor, grants } = await assertLakeResearchManage(req, lakeId, ctx);
    const input = parseInput();

    // Only a pause-only body skips the lever validation, so a config saved before a limit
    // tightened can still be stopped. A mixed body is a full edit.
    const definedKeys = Object.keys(input).filter(key => input[key as keyof typeof input] !== undefined);
    const pauseOnly = definedKeys.length === 1 && input.schedulePaused !== undefined;
    const adapters = { db, logger: req.logger };
    const result = pauseOnly
      ? await dataLakeResearchService.setResearchSchedulePaused(
          configId,
          lake,
          input.schedulePaused === true,
          actor,
          grants,
          adapters
        )
      : await dataLakeResearchService.updateResearchConfig(configId, lake, actor, grants, input, adapters);
    // Serializes this write against a concurrent grant revoke - see WRITE-TIME RESIDUAL on `canManageLake`.
    await dataLakeRepository.touchIfStable(lake.id);
    return result;
  });
}

export async function deleteLakeResearchConfig(
  req: Request,
  lakeId: string,
  configId: string,
  ctx: AccessContext
): Promise<void> {
  await withTransaction(async () => {
    const { lake, actor, grants } = await assertLakeResearchManage(req, lakeId, ctx);

    await dataLakeResearchService.deleteResearchConfig(configId, lake, actor, grants, { db, logger: req.logger });
    await dataLakeRepository.touchIfStable(lake.id);
  });
}
