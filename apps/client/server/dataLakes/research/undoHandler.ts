import { dataLakeResearchService, dataLakeService } from '@bike4mind/services';
import {
  withTransaction,
  dataLakeProposalRepository,
  dataLakeResearchConfigRepository,
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  lakeConfigChangeEventRepository,
  lakeConfigSnapshotRepository,
  lakeConfigUndoClaimRepository,
  lakeMembershipChangeEventRepository,
  lakeMembershipRemovalRepository,
  scopedSettingsRepository,
} from '@bike4mind/database';
import type { AccessContext, LakeConfigUndoResult } from '@bike4mind/common';
import type { Request } from 'express';
import { assertLakeResearchManage } from '@server/dataLakes/assertLakeResearchManage';
import { lakeConfigAuditDb } from '@bike4mind/server-utils/dataLakes/lakeConfigAuditDb';
import { lakeMembershipAuditDb } from '@bike4mind/server-utils/dataLakes/lakeMembershipAuditDb';
import { storageOwnerTransferDb } from '@bike4mind/server-utils/files/storageOwnerTransferDb';

const researchDb = {
  dataLakeResearchConfigs: dataLakeResearchConfigRepository,
  lakeConfigSnapshots: lakeConfigSnapshotRepository,
  ...lakeConfigAuditDb,
};

const proposalDb = {
  dataLakeProposals: dataLakeProposalRepository,
  dataLakes: dataLakeRepository,
  dataLakeAccessGrants: dataLakeAccessGrantRepository,
  ...lakeConfigAuditDb,
};

const membershipDb = {
  ...storageOwnerTransferDb,
  dataLakes: dataLakeRepository,
  dataLakeAccessGrants: dataLakeAccessGrantRepository,
  fabFiles: fabFileRepository,
  lakeMembershipRemovals: lakeMembershipRemovalRepository,
  scopedSettings: scopedSettingsRepository,
  ...lakeConfigAuditDb,
  ...lakeMembershipAuditDb,
};

/**
 * One Undo, shared by the SPA route and the public v1 route. The manage gate and the
 * whole undo run in one transaction, so a grant revoke committing mid-request collides on the lake
 * doc and the retry re-reads live grants, and a refused undo leaves no claim behind.
 *
 * Each inverse action is the ordinary service for that change, so its own manage check, validation
 * and History write apply. The row that records the undo is the action's own.
 */
export async function undoLakeConfigChangeHandler(
  req: Request,
  lakeId: string,
  eventId: string,
  ctx: AccessContext
): Promise<LakeConfigUndoResult> {
  return withTransaction(async () => {
    const { lake, actor, grants } = await assertLakeResearchManage(req, lakeId, ctx);
    const logger = req.logger;
    const research = (audit: dataLakeService.UndoAudit) => ({ db: researchDb, logger, audit });
    const proposals = (audit: dataLakeService.UndoAudit) => ({ db: proposalDb, logger, audit });
    const membership = { db: membershipDb, logger };

    const result = await dataLakeService.undoLakeConfigChange(eventId, lake, {
      db: {
        lakeConfigChangeEvents: lakeConfigChangeEventRepository,
        lakeMembershipChangeEvents: lakeMembershipChangeEventRepository,
        lakeConfigUndoClaims: lakeConfigUndoClaimRepository,
        lakeConfigSnapshots: lakeConfigSnapshotRepository,
        lakeMembershipRemovals: lakeMembershipRemovalRepository,
        dataLakeResearchConfigs: dataLakeResearchConfigRepository,
        dataLakeProposals: dataLakeProposalRepository,
        fabFiles: fabFileRepository,
      },
      actions: {
        updateResearchConfig: (configId, input, audit) =>
          dataLakeResearchService.updateResearchConfig(configId, lake, actor, grants, input, research(audit)),
        setSchedulePaused: (configId, paused, audit) =>
          dataLakeResearchService.setResearchSchedulePaused(configId, lake, paused, actor, grants, research(audit)),
        createResearchConfig: (input, audit) =>
          dataLakeResearchService.createResearchConfig(lake, actor, grants, input, research(audit)),
        deleteResearchConfig: (configId, audit) =>
          dataLakeResearchService.deleteResearchConfig(configId, lake, actor, grants, research(audit)),
        declineProposal: (proposalId, audit) =>
          dataLakeService.declineDataLakeProposal(proposalId, actor, {}, proposals(audit)),
        restoreProposal: (proposalId, audit) =>
          dataLakeService.restoreDataLakeProposal(proposalId, actor, proposals(audit)),
        unapproveProposal: (proposalId, audit, admittedFabFileId) =>
          dataLakeService.unapproveDataLakeProposal(
            proposalId,
            actor,
            {
              ...proposals(audit),
              removeAdmittedFile: async (removeActor, removeLakeId, fabFileId, links) => {
                await dataLakeService.removeFileFromDataLake(removeActor, removeLakeId, fabFileId, membership, links);
              },
            },
            { admittedFabFileId }
          ),
        removeFile: (fabFileId, audit) =>
          dataLakeService.removeFileFromDataLake(actor, lake.id, fabFileId, membership, audit),
        addFile: (fabFileId, audit) => dataLakeService.addFileToDataLake(actor, lake.id, fabFileId, membership, audit),
      },
    });

    // Serializes this write against a concurrent grant revoke - see WRITE-TIME RESIDUAL on `canManageLake`.
    await dataLakeRepository.touchIfStable(lake.id);
    return result;
  });
}
