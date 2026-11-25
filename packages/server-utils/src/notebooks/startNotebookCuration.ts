import type { Logger } from '@bike4mind/observability';
import { sessionRepository } from '@bike4mind/database';
import { NotebookCurationEvents } from '../utils/eventBus';
import { assertRequestCanAfford, type MeteredRequest } from '../billing/meterPlatformCompletion';
import { admitRequestCompletion } from '../utils/untrustedCompletionQuota';
import { resolveRequestBillingOrgId } from '../billing/resolveRequestBillingOrgId';
import { resolveRequestUsageSource } from '../utils/resolveRequestUsageSource';

type StartDetail = Parameters<typeof NotebookCurationEvents.Start.publish>[0];

/** The already-validated request body; apps/client/pages/api/notebooks/curate.ts pins its schema to this. */
export interface NotebookCurationInput {
  sessionIds: string[];
  curationType: NonNullable<StartDetail['curationType']>;
  artifactTypes?: StartDetail['artifactTypes'];
  exportFormat: NonNullable<StartDetail['exportFormat']>;
  customNotebookName?: string;
}

/** Structural slice of the authenticated Express request (augmented in apps/client/global.d.ts). */
export type NotebookCurationRequest = Parameters<typeof admitRequestCompletion>[0] &
  MeteredRequest & {
    logger: Pick<Logger, 'info' | 'error'>;
  };

export interface NotebookCurationResult {
  status: 202 | 403 | 404 | 500;
  body: { success: boolean; message: string; data?: unknown };
}

/**
 * Admits, ownership-checks and publishes one curation start event per session for the
 * authenticated `userId`. Returns the HTTP answer for the caller to send; admission and
 * affordability refusals are thrown (typed 4xx errors) for the route's asyncHandler to map.
 * The route at apps/client/pages/api/notebooks/curate.ts keeps auth and body validation.
 */
export async function startNotebookCuration(
  req: NotebookCurationRequest,
  userId: string,
  input: NotebookCurationInput
): Promise<NotebookCurationResult> {
  const { sessionIds, curationType, artifactTypes, exportFormat, customNotebookName } = input;
  // Only the executive summary calls an LLM (billed per call in the worker); refuse before enqueueing.
  if (curationType === 'executive_summary') {
    await admitRequestCompletion(req, { holdSlot: false });
    await assertRequestCanAfford(req);
  }

  try {
    const batchJobId = crypto.randomUUID();
    const batchTotal = sessionIds.length;

    req.logger.info('Triggering batch notebook curation', {
      sessionIds,
      userId,
      batchJobId,
      batchTotal,
      curationType,
      artifactTypes: artifactTypes || 'all',
      exportFormat,
    });

    const sessions = await Promise.all(sessionIds.map(sessionId => sessionRepository.findById(sessionId)));

    const invalidSessions: string[] = [];
    const unauthorizedSessions: string[] = [];

    sessions.forEach((session, index) => {
      const sessionId = sessionIds[index];
      if (!session) {
        invalidSessions.push(sessionId);
      } else if (session.userId !== userId) {
        unauthorizedSessions.push(sessionId);
      }
    });

    if (invalidSessions.length > 0) {
      return {
        status: 404,
        body: {
          success: false,
          message: `Session(s) not found: ${invalidSessions.join(', ')}`,
        },
      };
    }

    if (unauthorizedSessions.length > 0) {
      return {
        status: 403,
        body: {
          success: false,
          message: `You do not have permission to curate session(s): ${unauthorizedSessions.join(', ')}`,
        },
      };
    }

    const curationJobs = sessionIds.map((sessionId, index) => ({
      sessionId,
      curationJobId: crypto.randomUUID(),
      batchIndex: index,
    }));

    await Promise.all(
      curationJobs.map(({ sessionId, curationJobId, batchIndex }) =>
        NotebookCurationEvents.Start.publish(
          {
            sessionId,
            userId,
            curationJobId,
            batchJobId,
            batchIndex,
            batchTotal,
            curationType,
            artifactTypes,
            exportFormat,
            customNotebookName,
            billing: {
              organizationId: resolveRequestBillingOrgId(req) ?? null,
              apiKeyId: req.apiKeyInfo?.keyId,
              source: req.apiKeyInfo ? resolveRequestUsageSource(req) : undefined,
            },
          },
          { requireAcceptance: true }
        )
      )
    );

    return {
      status: 202,
      body: {
        success: true,
        message: `Batch curation started for ${batchTotal} session(s). Listen for progress updates via WebSocket.`,
        data: {
          batchJobId,
          sessionIds,
          curationJobs: curationJobs.map(job => ({
            sessionId: job.sessionId,
            curationJobId: job.curationJobId,
            status: 'pending',
          })),
          batchTotal,
        },
      },
    };
  } catch (error) {
    req.logger.error('Failed to trigger batch notebook curation', { sessionIds, userId, error });

    return {
      status: 500,
      body: {
        success: false,
        message: 'Failed to start curation. Please try again later.',
      },
    };
  }
}
