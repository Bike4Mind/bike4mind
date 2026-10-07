import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { connectDB, mongoose } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { handler } from '@server/queueHandlers/agentExecutor';
import { createExecutorApp, runQueueMessage, VISIBILITY_SECONDS, EXECUTION_BUDGET_MS } from './server';
import type { QueueMessageDeps } from './queueMessage';
import { createExecutorLifecycle } from './lifecycle';
import { settleDroppedExecution } from './droppedExecution';

const logger = new Logger({ metadata: { service: 'agentExecutor' } });
const sqs = new SQSClient({});

// Validation, app setup, and server startup all happen inside main() so a config error
// becomes a logged failure through the .catch() below instead of an uncaught exception
// at import time (tsx runs this file directly, with no wrapper to catch a module-scope throw).
async function main() {
  const queueUrl = process.env.AGENT_CONTINUATION_QUEUE?.trim();
  const secret = process.env.AGENT_EXECUTOR_INTERNAL_SECRET?.trim();
  if (!queueUrl || !secret) throw new Error('AGENT_CONTINUATION_QUEUE and AGENT_EXECUTOR_INTERNAL_SECRET are required');
  const configuredQueueUrl: string = queueUrl;
  const concurrency = Number(process.env.AGENT_EXECUTOR_CONCURRENCY ?? 8);
  if (!Number.isInteger(concurrency) || concurrency < 2 || concurrency > 64)
    throw new Error('AGENT_EXECUTOR_CONCURRENCY must be between 2 and 64');

  const queueMessageDeps: QueueMessageDeps = {
    run: message => runQueueMessage(message, handler),
    deleteMessage: async message => {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: configuredQueueUrl, ReceiptHandle: message.ReceiptHandle }));
    },
    extendVisibility: async (message, seconds) => {
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: configuredQueueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: seconds,
        })
      );
    },
    settleDropped: target => settleDroppedExecution(target, logger),
    logger,
    visibilitySeconds: VISIBILITY_SECONDS,
  };

  const lifecycle = createExecutorLifecycle({
    concurrency,
    drainTimeoutMs: EXECUTION_BUDGET_MS + 30_000,
    queueMessage: queueMessageDeps,
    receive: async () => {
      // One message per slot keeps visibility from expiring behind a long batch member.
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: configuredQueueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 20,
          VisibilityTimeout: VISIBILITY_SECONDS,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        })
      );
      return response.Messages ?? [];
    },
    probe: async () => {
      await sqs.send(new GetQueueAttributesCommand({ QueueUrl: configuredQueueUrl, AttributeNames: ['QueueArn'] }));
    },
    closeAdmission: () => {
      server.close();
    },
    cleanup: async () => {
      sqs.destroy();
      await mongoose.disconnect();
    },
    exit: code => {
      process.exit(code);
    },
  });
  const app = createExecutorApp({
    secret,
    audit: event => logger.info('Agent executor admission', event),
    ready: () => lifecycle.isReady() && mongoose.connection.readyState === 1,
    enqueue: async payload => {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: configuredQueueUrl,
          MessageBody: JSON.stringify({ kind: 'selfhost_invoke', payload }),
        })
      );
    },
  });
  const server = app.listen(Number(process.env.PORT ?? 8080));

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);
  await lifecycle.start();
  process.once('SIGTERM', () => {
    void lifecycle.shutdown();
  });
  process.once('SIGINT', () => {
    void lifecycle.shutdown();
  });
}
void main().catch(error => {
  logger.error('Agent executor startup failed', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
