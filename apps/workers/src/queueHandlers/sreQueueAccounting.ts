import { createHash } from 'node:crypto';
import type { SQSRecord } from 'aws-lambda';
import { platformAttemptRepository, usageEventRepository } from '@bike4mind/database';
import { PlatformAccounting, createPlatformAttribution } from '@bike4mind/services';
import {
  SreAccountingError,
  isSreAccountingError,
  type SreAccountingContext,
} from '@bike4mind/services/sreAgentService';

export function createSreQueueAccounting(
  record: Pick<SQSRecord, 'messageId' | 'eventSourceARN'>,
  deadlineAt: number,
  stage: string
): SreAccountingContext {
  if (!record.messageId || !record.eventSourceARN || !stage || !Number.isFinite(deadlineAt)) {
    throw new SreAccountingError('missing_queue_identity');
  }
  const identity = createHash('sha256')
    .update(JSON.stringify([record.eventSourceARN, record.messageId]))
    .digest('hex');
  const environment =
    stage === 'production' || stage === 'prod'
      ? 'production'
      : stage === 'staging'
        ? 'staging'
        : stage === 'test'
          ? 'test'
          : 'development';
  return {
    accounting: new PlatformAccounting(platformAttemptRepository, usageEventRepository),
    attribution: createPlatformAttribution(
      { environment },
      {
        logicalJobId: `sre-job-${identity}`,
        executionId: `sre-execution-${identity}`,
      }
    ),
    deadlineAt,
  };
}

export async function recoverSreQueueAccounting(context: SreAccountingContext): Promise<void> {
  if (!context) throw new SreAccountingError('missing_accounting_context');
  const executionId = context.attribution.executionId;
  let afterProviderCallId: string | undefined;
  let failed = false;
  try {
    for (let page = 0; page < 20; page++) {
      if (Date.now() >= context.deadlineAt - (context.persistenceReserveMs ?? 5000)) {
        throw new SreAccountingError('recovery_deadline');
      }
      const recovered = await context.accounting.recover({
        now: new Date(),
        limit: 100,
        executionId,
        afterProviderCallId,
      });
      failed ||= recovered.failed.length > 0 || recovered.unresolved > 0;
      if (!recovered.nextCursor) {
        const diagnostics = await context.accounting.diagnostics({ limit: 1, executionId });
        if (failed || diagnostics.total > diagnostics.byState.registered)
          throw new SreAccountingError('recovery_pending');
        return;
      }
      if (recovered.nextCursor === afterProviderCallId) throw new SreAccountingError('recovery_cursor');
      afterProviderCallId = recovered.nextCursor;
    }
    throw new SreAccountingError('recovery_page_limit');
  } catch (error) {
    if (isSreAccountingError(error)) throw error;
    throw new SreAccountingError('recovery_failed', undefined, { cause: error });
  }
}
