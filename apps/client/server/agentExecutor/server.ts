import { randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { Message } from '@aws-sdk/client-sqs';
import type { Context, SQSEvent } from 'aws-lambda';
import {
  ContinuationSchema,
  StartExecutionSchema,
  TaggedQueueMessageSchema,
} from '../queueHandlers/agentExecutor.schemas';

export const VISIBILITY_SECONDS = 960;
export const EXECUTION_BUDGET_MS = 780_000;
type Handler = (event: Record<string, unknown> | SQSEvent, context: Context) => Promise<unknown>;

export function executionContext(): Context {
  const started = Date.now();
  return {
    awsRequestId: randomUUID(),
    functionName: 'selfhost_agent_executor',
    functionVersion: '$LATEST',
    callbackWaitsForEmptyEventLoop: false,
    getRemainingTimeInMillis: () => Math.max(0, EXECUTION_BUDGET_MS - (Date.now() - started)),
  } as Context;
}

function invocationPayload(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid execution payload');
  return 'query' in value ? StartExecutionSchema.parse(value) : ContinuationSchema.parse(value);
}

export function createExecutorApp(options: {
  secret: string;
  ready: () => boolean;
  enqueue: (payload: Record<string, unknown>) => Promise<void>;
  audit?: (event: { outcome: 'accepted' | 'denied'; remoteAddress?: string; executionId?: string }) => void;
}) {
  if (!options.secret.trim()) throw new Error('AGENT_EXECUTOR_INTERNAL_SECRET is required');
  const app = express();
  app.get('/health', (_req, res) => {
    const ready = options.ready();
    res.status(ready ? 200 : 503).json({ ready });
  });
  app.post(
    '/execute',
    (req, res, next) => {
      const provided = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${options.secret.trim()}`);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        options.audit?.({ outcome: 'denied', remoteAddress: req.socket.remoteAddress });
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (!options.ready()) {
        res.status(503).json({ error: 'Executor unavailable' });
        return;
      }
      next();
    },
    express.json({ limit: '240kb' }),
    async (req, res) => {
      let payload: Record<string, unknown>;
      try {
        payload = invocationPayload(req.body);
      } catch {
        res.status(400).json({ error: 'Invalid execution payload' });
        return;
      }
      try {
        await options.enqueue(payload);
        options.audit?.({
          outcome: 'accepted',
          executionId: String(payload.executionId),
          remoteAddress: req.socket.remoteAddress,
        });
        res.status(202).json({ accepted: true, executionId: payload.executionId });
      } catch {
        res.status(503).json({ error: 'Execution queue unavailable' });
      }
    }
  );
  return app;
}

export async function runQueueMessage(message: Message, handler: Handler): Promise<void> {
  const body: unknown = JSON.parse(message.Body ?? '');
  if (typeof body === 'object' && body !== null && 'kind' in body && body.kind === 'selfhost_invoke') {
    if (!('payload' in body)) throw new Error('Missing invocation payload');
    await handler(invocationPayload(body.payload), executionContext());
    return;
  }
  if (typeof body === 'object' && body !== null && 'kind' in body) TaggedQueueMessageSchema.parse(body);
  else ContinuationSchema.parse(body);
  const result = await handler(
    {
      Records: [
        {
          messageId: message.MessageId ?? '',
          receiptHandle: message.ReceiptHandle ?? '',
          body: message.Body ?? '',
          attributes: message.Attributes ?? {},
          messageAttributes: {},
          md5OfBody: message.MD5OfBody ?? '',
          eventSource: 'aws:sqs',
          eventSourceARN: '',
          awsRegion: process.env.AWS_REGION ?? 'us-east-1',
        },
      ],
    } as SQSEvent,
    executionContext()
  );
  if (
    typeof result !== 'object' ||
    result === null ||
    !('batchItemFailures' in result) ||
    !Array.isArray(result.batchItemFailures) ||
    result.batchItemFailures.length !== 0
  ) {
    throw new Error('Agent queue message failed');
  }
}
