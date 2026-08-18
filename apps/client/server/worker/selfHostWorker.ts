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
  /** The current run, kept (not a boolean) so shutdown can await it. */
  inFlight?: Promise<void>;
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
      this.timers.push(setInterval(() => this.startScheduledTask(t), t.intervalMs));
    }
    this.logger.info(
      `[selfHostWorker] started: ${this.queues.length} queue(s), ${this.scheduled.length} scheduled task(s)`
    );
  }

  /**
   * Stop polling and disarm scheduled tasks. Sets running=false immediately, then waits up to
   * `graceMs` for each poller to finish its current iteration (in-flight message handling) and
   * for any scheduled task still running, so shutdown doesn't cut work mid-run. A scheduled task
   * is drained as well as a poller because abandoning one leaves state behind that no redelivery
   * repairs (e.g. a discovery run's Mongo lease, held until its TTL). Anything still busy past
   * the grace is abandoned by the caller's process.exit.
   */
  async stop(graceMs = 0): Promise<void> {
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    const inFlightTasks = this.scheduled.map(t => t.inFlight).filter((p): p is Promise<void> => p !== undefined);
    const pending = [...this.pollers, ...inFlightTasks];
    if (graceMs > 0 && pending.length > 0) {
      await Promise.race([Promise.allSettled(pending), sleep(graceMs)]);
    }
    this.pollers = [];
  }

  /** Start a tick's run and record it, so stop() can wait for it. */
  private startScheduledTask(task: ScheduledTaskRegistration): void {
    // Non-reentrant: setInterval fires on a fixed cadence regardless of run duration, so a run
    // that outlasts its interval would otherwise overlap the next tick and double-enqueue work.
    if (task.inFlight) {
      this.logger.warn(`[selfHostWorker] scheduled task "${task.name}" still running; skipping this tick`);
      return;
    }
    task.inFlight = this.runScheduledTask(task).finally(() => {
      task.inFlight = undefined;
    });
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
    // Mirror real SQS's redrive semantics: once a message's receive count exceeds
    // maxReceiveCount, AWS routes it straight to the DLQ WITHOUT another delivery - the handler
    // never sees a (maxReceiveCount+1)th attempt. Checking this BEFORE dispatch (rather than
    // dispatching unconditionally and only deciding redeliver-vs-drop in the catch) is what
    // keeps that guarantee true here too: a handler that gates its own final-attempt behavior
    // on receive count (e.g. isFinalDeliveryAttempt) needs the count it sees at its own last
    // invocation to line up with maxReceiveCount, exactly as it would on a real SQS-backed queue.
    if (receiveCount > q.maxReceiveCount) {
      // Poison guard: no DLQ in ElasticMQ, so drop after the cap and log loudly.
      this.logger.error(
        `[selfHostWorker] "${q.name}" message dropped after ${receiveCount} deliveries (> ${q.maxReceiveCount})`,
        { messageId: message.MessageId }
      );
      if (message.ReceiptHandle) {
        await deleteFromQueue(q.url, message.ReceiptHandle);
      }
      return;
    }
    try {
      await q.dispatch(this.toSqsEvent(message), this.fakeContext(q.name));
      if (message.ReceiptHandle) {
        await deleteFromQueue(q.url, message.ReceiptHandle);
      }
    } catch (err) {
      // Leave the message: it becomes visible again after the visibility timeout and is redelivered.
      this.logger.warn(`[selfHostWorker] "${q.name}" handler threw (delivery ${receiveCount}); leaving for retry`, {
        error: err instanceof Error ? err.message : String(err),
        messageId: message.MessageId,
      });
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
