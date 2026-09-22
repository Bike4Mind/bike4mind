import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { connectDB, mongoose } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { handler } from '@server/queueHandlers/agentExecutor';
import { createExecutorApp, runQueueMessage, VISIBILITY_SECONDS, EXECUTION_BUDGET_MS } from './server';

const logger = new Logger({ metadata: { service: 'agentExecutor' } });
const sqs = new SQSClient({});
const queueUrl = process.env.AGENT_CONTINUATION_QUEUE?.trim();
const secret = process.env.AGENT_EXECUTOR_INTERNAL_SECRET?.trim();
if (!queueUrl || !secret) throw new Error('AGENT_CONTINUATION_QUEUE and AGENT_EXECUTOR_INTERNAL_SECRET are required');
const configuredQueueUrl: string = queueUrl;
const concurrency = Number(process.env.AGENT_EXECUTOR_CONCURRENCY ?? 8);
if (!Number.isInteger(concurrency) || concurrency < 2 || concurrency > 64)
  throw new Error('AGENT_EXECUTOR_CONCURRENCY must be between 2 and 64');
let running = true;
let queueReady = false;
const app = createExecutorApp({
  secret,
  audit: event => logger.info('Agent executor admission', event),
  ready: () => running && queueReady && mongoose.connection.readyState === 1,
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

async function consume(): Promise<void> {
  while (running) {
    try {
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
      if (!running) break;
      for (const message of response.Messages ?? []) {
        try {
          await runQueueMessage(message, handler);
          await sqs.send(
            new DeleteMessageCommand({ QueueUrl: configuredQueueUrl, ReceiptHandle: message.ReceiptHandle })
          );
        } catch {
          logger.warn('Agent queue delivery failed; retaining for redelivery', { messageId: message.MessageId });
        }
      }
    } catch {
      queueReady = false;
      if (running) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function main() {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);
  await sqs.send(new GetQueueAttributesCommand({ QueueUrl: configuredQueueUrl, AttributeNames: ['QueueArn'] }));
  queueReady = true;
  const consumers = Array.from({ length: concurrency }, () => consume());
  const probe = setInterval(() => {
    void sqs
      .send(new GetQueueAttributesCommand({ QueueUrl: configuredQueueUrl, AttributeNames: ['QueueArn'] }))
      .then(() => {
        queueReady = true;
      })
      .catch(() => {
        queueReady = false;
      });
  }, 10_000);
  const shutdown = () => {
    if (!running) return;
    running = false;
    clearInterval(probe);
    server.close();
    const timeout = setTimeout(() => process.exit(1), EXECUTION_BUDGET_MS + 30_000);
    void Promise.allSettled(consumers).then(async () => {
      clearTimeout(timeout);
      sqs.destroy();
      await mongoose.disconnect();
      process.exit(0);
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
void main().catch(() => {
  logger.error('Agent executor startup failed');
  process.exit(1);
});
