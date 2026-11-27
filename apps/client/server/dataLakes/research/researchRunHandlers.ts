import { dataLakeResearchService } from '@bike4mind/services';
import {
  dataLakeRepository,
  dataLakeResearchConfigRepository,
  dataLakeResearchRunRepository,
  organizationRepository,
  spendFreezeRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import type { AccessContext, IDataLakeResearchRunDocument, ResearchKeysetPage } from '@bike4mind/common';
import { InternalServerError, NotFoundError } from '@bike4mind/utils';
import type { Request } from 'express';
import { Resource } from 'sst';
import { assertLakeResearchManage } from '@server/dataLakes/assertLakeResearchManage';
import { lakeConfigAuditDb } from '@bike4mind/server-utils/dataLakes/lakeConfigAuditDb';
import { queueResearchRun } from '@bike4mind/server-utils/dataLakes/queueResearchRun';
import { admitRequestCompletion } from '@bike4mind/server-utils/utils/untrustedCompletionQuota';

/*
 * Run handler bodies shared by the SPA routes and the public v1 routes. Inputs arrive as thunks so
 * they are parsed after the manage gate, as in the config handlers.
 */

export async function listLakeResearchRuns(
  req: Request,
  lakeId: string,
  ctx: AccessContext,
  parsePage: () => ResearchKeysetPage
): Promise<IDataLakeResearchRunDocument[]> {
  // Gated before the query is parsed, matching the POST and the config routes: a caller who may not
  // manage this lake should not be able to probe the request schema.
  const { lake } = await assertLakeResearchManage(req, lakeId, ctx);
  return dataLakeResearchRunRepository.listByLake(lake.id, parsePage());
}

export async function getLakeResearchRun(
  req: Request,
  lakeId: string,
  runId: string,
  ctx: AccessContext
): Promise<IDataLakeResearchRunDocument> {
  const { lake } = await assertLakeResearchManage(req, lakeId, ctx);
  const run = await dataLakeResearchRunRepository.findByIdInLake(runId, lake.id);
  if (!run) throw new NotFoundError('Research run not found');
  return run;
}

export async function startLakeResearchRun(
  req: Request,
  lakeId: string,
  ctx: AccessContext,
  parseInput: () => { configId: string }
): Promise<IDataLakeResearchRunDocument> {
  // The manage gate runs inside the transaction so a grant revoke committing mid-request collides
  // on the lake doc and the retry re-reads live grants. Only the run row is written in it: the
  // enqueue below is an external side effect, and the callback re-runs on retry.
  const { run, lake, queueUrl } = await withTransaction(async () => {
    const { lake, actor, grants } = await assertLakeResearchManage(req, lakeId, ctx);
    const { configId } = parseInput();

    // Checked BEFORE the row is written, and after the gate and the parse so a refused or malformed
    // request never learns about deployment config. Without the queue there is no executor, so a
    // run started here would sit `queued` forever and block every later run behind the
    // one-at-a-time guard. A pure config read, so safe to re-run on retry.
    const queueUrl = Resource.dataLakeResearchQueue?.url;
    if (!queueUrl) {
      throw new InternalServerError('Research runs are not available on this deployment');
    }

    await admitRequestCompletion(req, { holdSlot: false });

    const started = await dataLakeResearchService.startResearchRun(
      configId,
      lake,
      { trigger: 'on_demand', actor, grants },
      {
        db: {
          dataLakeResearchConfigs: dataLakeResearchConfigRepository,
          dataLakeResearchRuns: dataLakeResearchRunRepository,
          users: userRepository,
          organizations: organizationRepository,
          spendFreezes: spendFreezeRepository,
          ...lakeConfigAuditDb,
        },
        logger: req.logger,
      }
    );
    // Serializes this write against a concurrent grant revoke - see WRITE-TIME RESIDUAL on `canManageLake`.
    await dataLakeRepository.touchIfStable(lake.id);
    return { run: started, lake, queueUrl };
  });

  await queueResearchRun(run, lake, queueUrl, req.logger);
  return run;
}
