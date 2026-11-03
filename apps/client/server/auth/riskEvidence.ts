import type { RiskEvidenceTrigger } from '@bike4mind/common';
import {
  agentExecutionRepository,
  authEventRepository,
  usageEventRepository,
  userApiKeyRepository,
  userAuthAuditLogRepository,
  userRepository,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { userService } from '@bike4mind/services';
import { sendToQueue } from '@bike4mind/server-utils/utils/sqs';
import { Resource } from 'sst';

/** The evidence sources and user writes, wired to the app's repositories. Lazy so importers' DB mocks stay partial. */
export const riskEvidenceDb = () => ({
  users: userRepository,
  authEvents: authEventRepository,
  authAuditLogs: userAuthAuditLogRepository,
  userApiKeys: userApiKeyRepository,
  usageEvents: usageEventRepository,
  agentExecutions: agentExecutionRepository,
});

/** ms. A stalled SQS endpoint must not hold up sign-in; a send that loses the race is released and retried later. */
const ENQUEUE_TIMEOUT_MS = 2_000;

async function sendWithTimeout(send: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('risk evidence enqueue timed out')), ENQUEUE_TIMEOUT_MS);
  });
  try {
    await Promise.race([send, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * userService.requestRiskEvidenceRefresh wired to riskEvidenceQueue. Called after signup, login,
 * email verification and API key creation; costs the request one conditional update and at most
 * one SQS send (bounded by ENQUEUE_TIMEOUT_MS), and never throws.
 */
export function requestRiskEvidenceRefresh(userId: string, trigger: RiskEvidenceTrigger, logger: Pick<Logger, 'warn'>) {
  return userService.requestRiskEvidenceRefresh(userId, trigger, {
    users: userRepository,
    enqueue: async (message, delaySeconds) => {
      await sendWithTimeout(sendToQueue(Resource.riskEvidenceQueue.url, message, delaySeconds));
    },
    logger,
  });
}
