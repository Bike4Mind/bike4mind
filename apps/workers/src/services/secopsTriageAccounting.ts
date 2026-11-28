import { createHash } from 'node:crypto';
import type { SQSRecord } from 'aws-lambda';
import { platformAttemptRepository, usageEventRepository } from '@bike4mind/database';
import {
  PlatformAccounting,
  createPlatformAttribution,
  PlatformCompletionAccountingError,
  isPlatformCompletionAccountingError,
  type PlatformCompletionAccountingContext,
} from '@bike4mind/services';

export function createSecopsTriageAccounting(
  record: Pick<SQSRecord, 'messageId' | 'eventSourceARN'>,
  deadlineAt: number,
  stage: string
): PlatformCompletionAccountingContext {
  if (!record.messageId || !record.eventSourceARN || !stage || !Number.isFinite(deadlineAt)) {
    throw new PlatformCompletionAccountingError('missing_queue_identity');
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
      { environment, operation: 'secops_triage' },
      { logicalJobId: `secops-job-${identity}`, executionId: `secops-execution-${identity}` }
    ),
    deadlineAt,
  };
}

export async function recoverSecopsTriageAccounting(
  context: PlatformCompletionAccountingContext,
  allowUnresolved = false
): Promise<void> {
  const executionId = context.attribution.executionId;
  let afterProviderCallId: string | undefined;
  let failed = false;
  try {
    for (let page = 0; page < 20; page++) {
      if (Date.now() >= context.deadlineAt - (context.persistenceReserveMs ?? 15_000)) {
        throw new PlatformCompletionAccountingError('recovery_deadline');
      }
      const recovered = await context.accounting.recover({
        now: new Date(),
        limit: 100,
        executionId,
        afterProviderCallId,
      });
      failed ||= recovered.failed.length > 0 || (!allowUnresolved && recovered.unresolved > 0);
      if (!recovered.nextCursor) {
        const diagnostics = await context.accounting.diagnostics({ limit: 1, executionId });
        const permitted = diagnostics.byState.registered + (allowUnresolved ? diagnostics.byState.unresolved : 0);
        if (failed || diagnostics.total > permitted) {
          throw new PlatformCompletionAccountingError('recovery_pending');
        }
        return;
      }
      if (recovered.nextCursor === afterProviderCallId) throw new PlatformCompletionAccountingError('recovery_cursor');
      afterProviderCallId = recovered.nextCursor;
    }
    throw new PlatformCompletionAccountingError('recovery_page_limit');
  } catch (error) {
    if (isPlatformCompletionAccountingError(error)) throw error;
    throw new PlatformCompletionAccountingError('recovery_failed', undefined, { cause: error });
  }
}
