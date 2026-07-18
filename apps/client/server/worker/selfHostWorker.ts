import { randomUUID } from 'crypto';
import type { Context, SQSEvent, SQSRecordAttributes } from 'aws-lambda';
import type { Message } from '@aws-sdk/client-sqs';
import { Logger } from '@bike4mind/observability';
import { deleteFromQueue, receiveFromQueue } from '@server/utils/sqs';

/**
 * Self-host background worker.
 *
 * Replaces the hosted SST queue consumers (infra/queues.ts) and cron
 * (infra/cron.ts), which don't exist in the plain-Docker self-host stack. Long-polls
 * one or more ElasticMQ queues and hands each message to the SAME dispatch function
 * the hosted Lambda uses (e.g. researchEngineQueue.dispatch), wrapped in a synthetic
 * EventBridge/SQS-shaped event, so there is one code path in every environment.
 *
 * ElasticMQ has no dead-letter queue, so this implements a poison-message guard in
 * software: a message whose handler keeps throwing is left for redelivery until
 * ApproximateReceiveCount exceeds maxReceiveCount, then deleted with an error log.
 */

/** The hosted Lambda handler shape (see dispatchWithLogger). */
type QueueDispatch = (event: SQSEvent, context: Context) => Promise<unknown>;

interface QueueHandlerRegistration {
  name: string;
  url: string;
  dispatch: QueueDispatch;
  visibilityTimeoutSec: number;
  maxReceiveCount: number;
}

interface ScheduledTaskRegistration {
  name: string;
  intervalMs: number;
  fn: () => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** SQS long-poll wait; also the effective poll interval when a queue is idle. */
const LONG_POLL_SECONDS = 20;
/** Max messages fetched per receive (SQS hard cap). */
const MAX_MESSAGES_PER_RECEIVE = 10;
/** Poller-loop restart backoff bounds after an unexpected iteration error. */
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

export class SelfHostWorker {
  private readonly queues: QueueHandlerRegistration[] = [];
  private readonly scheduled: ScheduledTaskRegistration[] = [];
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private pollers: Promise<void>[] = [];
  private running = false;
  private readonly logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? new Logger({ metadata: { service: 'selfHostWorker' } });
  }

  registerQueueHandler(
    name: string,
    url: string,
    dispatch: QueueDispatch,
    opts?: { visibilityTimeoutSec?: number; maxReceiveCount?: number }
  ): void {
    this.queues.push({
      name,
      url,
      dispatch,
      visibilityTimeoutSec: opts?.visibilityTimeoutSec ?? 30,
      maxReceiveCount: opts?.maxReceiveCount ?? 3,
    });
  }

  registerScheduledTask(name: string, intervalMs: number, fn: () => Promise<void>): void {
    this.scheduled.push({ name, intervalMs, fn });
  }

  /** Begin polling every registered queue and arm every scheduled task. Non-blocking. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollers = this.queues.map(q => this.runPoller(q));
    for (const t of this.scheduled) {
      this.timers.push(setInterval(() => void this.runScheduledTask(t), t.intervalMs));
    }
    this.logger.info(
      `[selfHostWorker] started: ${this.queues.length} queue(s), ${this.scheduled.length} scheduled task(s)`
    );
  }

  /**
   * Stop polling and disarm scheduled tasks. Sets running=false immediately, then waits up to
   * `graceMs` for each poller to finish its current iteration (in-flight message handling) so
   * shutdown doesn't cut a handler mid-run. A busy handler past the grace is abandoned by the
   * caller's process.exit; the message stays in-flight and is redelivered.
   */
  async stop(graceMs = 0): Promise<void> {
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    if (graceMs > 0 && this.pollers.length > 0) {
      await Promise.race([Promise.allSettled(this.pollers), sleep(graceMs)]);
    }
    this.pollers = [];
  }

  private async runScheduledTask(task: ScheduledTaskRegistration): Promise<void> {
    try {
      await task.fn();
    } catch (err) {
      this.logger.error(`[selfHostWorker] scheduled task "${task.name}" failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async runPoller(q: QueueHandlerRegistration): Promise<void> {
    let backoffMs = 0;
    while (this.running) {
      try {
        await this.pollOnce(q);
        backoffMs = 0;
      } catch (err) {
        // A single failed iteration (transient SQS/network error) must not kill the
        // consumer. Restart the loop with exponential backoff instead.
        backoffMs = backoffMs === 0 ? BACKOFF_MIN_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        this.logger.error(`[selfHostWorker] poller "${q.name}" iteration failed; retrying in ${backoffMs}ms`, {
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(backoffMs);
      }
    }
  }

  private async pollOnce(q: QueueHandlerRegistration): Promise<void> {
    const messages = await receiveFromQueue(q.url, MAX_MESSAGES_PER_RECEIVE, q.visibilityTimeoutSec, LONG_POLL_SECONDS);
    for (const message of messages) {
      // Sequential: one bad message must not abort processing of the rest of the batch,
      // and handleMessage never rethrows.
      await this.handleMessage(q, message);
    }
  }

  private async handleMessage(q: QueueHandlerRegistration, message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    try {
      await q.dispatch(this.toSqsEvent(message), this.fakeContext(q.name));
      if (message.ReceiptHandle) {
        await deleteFromQueue(q.url, message.ReceiptHandle);
      }
    } catch (err) {
      const detail = { error: err instanceof Error ? err.message : String(err), messageId: message.MessageId };
      if (receiveCount > q.maxReceiveCount) {
        // Poison guard: no DLQ in ElasticMQ, so drop after the cap and log loudly.
        this.logger.error(
          `[selfHostWorker] "${q.name}" message dropped after ${receiveCount} deliveries (> ${q.maxReceiveCount})`,
          detail
        );
        if (message.ReceiptHandle) {
          await deleteFromQueue(q.url, message.ReceiptHandle);
        }
      } else {
        // Leave the message: it becomes visible again after the visibility timeout and is redelivered.
        this.logger.warn(
          `[selfHostWorker] "${q.name}" handler threw (delivery ${receiveCount}); leaving for retry`,
          detail
        );
      }
    }
  }

  /** Wrap an SQS Message as the single-record SQSEvent the hosted dispatch expects. */
  private toSqsEvent(message: Message): SQSEvent {
    return {
      Records: [
        {
          messageId: message.MessageId ?? '',
          receiptHandle: message.ReceiptHandle ?? '',
          body: message.Body ?? '',
          attributes: (message.Attributes ?? {}) as SQSRecordAttributes,
          messageAttributes: {},
          md5OfBody: message.MD5OfBody ?? '',
          eventSource: 'aws:sqs',
          eventSourceARN: '',
          awsRegion: process.env.AWS_REGION ?? 'us-east-2',
        },
      ],
    };
  }

  /** Minimal Lambda Context - only the fields contextToLogs reads are populated. */
  private fakeContext(name: string): Context {
    return {
      awsRequestId: randomUUID(),
      functionName: `selfHostWorker:${name}`,
      functionVersion: '$LATEST',
    } as unknown as Context;
  }
}
