import type { Message } from '@aws-sdk/client-sqs';
import { handleQueueMessage, type QueueMessageDeps } from './queueMessage';

interface LifecycleOptions {
  receive: () => Promise<Message[]>;
  probe: () => Promise<void>;
  queueMessage: QueueMessageDeps;
  concurrency: number;
  drainTimeoutMs: number;
  closeAdmission: () => void;
  cleanup: () => Promise<void>;
  exit: (code: number) => void;
  timers?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'>;
}

export function createExecutorLifecycle(options: LifecycleOptions) {
  const timers = options.timers ?? globalThis;
  let running = true;
  let queueReady = false;
  let consumers: Promise<void>[] = [];
  let probe: ReturnType<typeof setInterval> | undefined;
  let stopped: Promise<void> | undefined;

  async function consume(): Promise<void> {
    while (running) {
      try {
        const messages = await options.receive();
        if (!running) break;
        for (const message of messages) await handleQueueMessage(message, options.queueMessage);
      } catch {
        queueReady = false;
        if (running) await new Promise<void>(resolve => timers.setTimeout(resolve, 1000));
      }
    }
  }

  async function start(): Promise<void> {
    await options.probe();
    if (!running) return;
    queueReady = true;
    consumers = Array.from({ length: options.concurrency }, () => consume());
    probe = timers.setInterval(() => {
      void options.probe().then(
        () => {
          queueReady = running;
        },
        () => {
          queueReady = false;
        }
      );
    }, 10_000);
  }

  function shutdown(): Promise<void> {
    if (stopped) return stopped;
    running = false;
    timers.clearInterval(probe);
    options.closeAdmission();
    let exited = false;
    const finish = (code: number) => {
      if (exited) return;
      exited = true;
      timers.clearTimeout(timeout);
      options.exit(code);
    };
    // The budget includes cleanup, which can hang while disconnecting the database.
    const timeout = timers.setTimeout(() => finish(1), options.drainTimeoutMs);
    stopped = Promise.allSettled(consumers).then(async () => {
      try {
        await options.cleanup();
        finish(0);
      } catch (error) {
        options.queueMessage.logger.error('Agent executor shutdown failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        finish(1);
      }
    });
    return stopped;
  }

  return { start, shutdown, isReady: () => running && queueReady };
}
