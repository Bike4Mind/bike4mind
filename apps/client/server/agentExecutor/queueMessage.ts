import type { Message } from '@aws-sdk/client-sqs';
import type { AgentExecutionStatus } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';

/**
 * ElasticMQ has no dead-letter queue, so the cap lives here: a message received more than this many
 * times is deleted instead of run again. Matches the hosted queue's redrive `retry: 3`
 * (infra/queues.ts) and the self-host worker's default (worker/selfHostWorker.ts).
 */
export const MAX_RECEIVE_COUNT = 3;

/** The execution a queue message would advance, and the statuses its claim would move it out of. */
export interface ExecutionTarget {
  executionId: string;
  claimableFrom: AgentExecutionStatus[];
}

// Must stay in sync with the claimExecution calls in processExecution and processSubagentDispatch
// (queueHandlers/agentExecutor.ts).
const START_STATUSES: AgentExecutionStatus[] = ['pending'];
const CONTINUATION_STATUSES: AgentExecutionStatus[] = ['continuing', 'awaiting_subagent', 'awaiting_dag_children'];
const OBJECT_ID = /^[a-f\d]{24}$/i;

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/** Lenient on purpose: the message being dropped is often the one that failed schema validation. */
export function executionTarget(body: string | undefined): ExecutionTarget | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? '');
  } catch {
    return undefined;
  }
  const kind = field(parsed, 'kind');
  let id: unknown;
  let claimableFrom: AgentExecutionStatus[];
  if (kind === 'selfhost_invoke') {
    const payload = field(parsed, 'payload');
    id = field(payload, 'executionId');
    claimableFrom = field(payload, 'query') === undefined ? CONTINUATION_STATUSES : START_STATUSES;
  } else if (kind === 'subagent_dispatch' || kind === 'dag_node_dispatch') {
    id = field(parsed, 'childExecutionId');
    claimableFrom = START_STATUSES;
  } else if (kind === 'continuation' || kind === undefined) {
    id = field(parsed, 'executionId');
    claimableFrom = CONTINUATION_STATUSES;
  } else {
    return undefined;
  }
  return typeof id === 'string' && OBJECT_ID.test(id) ? { executionId: id, claimableFrom } : undefined;
}

export interface QueueMessageDeps {
  run: (message: Message) => Promise<void>;
  deleteMessage: (message: Message) => Promise<void>;
  extendVisibility: (message: Message, seconds: number) => Promise<void>;
  /** Resolves true when the execution was failed and its quest settled, false when it had moved on. */
  settleDropped: (target: ExecutionTarget) => Promise<boolean>;
  logger: Pick<Logger, 'warn' | 'error'>;
  visibilitySeconds: number;
  maxReceiveCount?: number;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Runs one received message and never throws. While the run is in flight its visibility is extended
 * on a heartbeat, so ApproximateReceiveCount only climbs when an attempt failed or its consumer died:
 * a run that outlasts the visibility timeout is never redelivered and so never counted toward the cap.
 */
export async function handleQueueMessage(message: Message, deps: QueueMessageDeps): Promise<void> {
  const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
  const maxReceiveCount = deps.maxReceiveCount ?? MAX_RECEIVE_COUNT;
  if (receiveCount > maxReceiveCount) {
    await dropMessage(message, receiveCount, maxReceiveCount, deps);
    return;
  }

  // A third of the timeout leaves two missed extensions of slack before the message is exposed.
  const heartbeat = setInterval(
    () => {
      deps.extendVisibility(message, deps.visibilitySeconds).catch(error =>
        deps.logger.warn('Agent queue visibility extension failed', {
          messageId: message.MessageId,
          error: errorMessage(error),
        })
      );
    },
    (deps.visibilitySeconds * 1000) / 3
  );
  try {
    await deps.run(message);
  } catch (error) {
    deps.logger.warn('Agent queue delivery failed; retaining for redelivery', {
      messageId: message.MessageId,
      receiveCount,
      maxReceiveCount,
      error: errorMessage(error),
    });
    return;
  } finally {
    clearInterval(heartbeat);
  }
  try {
    await deps.deleteMessage(message);
  } catch (error) {
    // The run already happened; a redelivery finds the execution claimed and exits without rerunning it.
    deps.logger.warn('Agent queue delete failed after processing', {
      messageId: message.MessageId,
      error: errorMessage(error),
    });
  }
}

async function dropMessage(
  message: Message,
  receiveCount: number,
  maxReceiveCount: number,
  deps: QueueMessageDeps
): Promise<void> {
  const target = executionTarget(message.Body);
  let executionSettled = false;
  let settleError: string | undefined;
  if (target) {
    try {
      executionSettled = await deps.settleDropped(target);
    } catch (error) {
      settleError = errorMessage(error);
    }
  }
  deps.logger.error('Agent queue message dropped after repeated delivery failures', {
    messageId: message.MessageId,
    executionId: target?.executionId,
    receiveCount,
    maxReceiveCount,
    executionSettled,
    ...(settleError ? { settleError } : {}),
  });
  try {
    await deps.deleteMessage(message);
  } catch (error) {
    deps.logger.warn('Agent queue delete of a dropped message failed', {
      messageId: message.MessageId,
      error: errorMessage(error),
    });
  }
}
