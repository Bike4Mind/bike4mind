import { afterAll, beforeAll, expect, it, describe, vi } from 'vitest';
import mongoose from 'mongoose';
import { S3Client, CreateBucketCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  SQSClient,
  SendMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { User, Session, Quest, FabFile, NotebookCurationJob, CreditTransaction } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
const { notify } = vi.hoisted(() => ({ notify: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: notify }));
vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ post: (fn: unknown) => fn }) }));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/utils/config', () => ({
  Config: {
    get MONGODB_URI() {
      return process.env.NOTEBOOK_MONGO_URI;
    },
    STAGE: 'test',
  },
}));
vi.mock('sst', () => ({
  Resource: {
    App: { stage: 'test', name: 'notebook-proof' },
    fabFileBucket: {
      get name() {
        return process.env.NOTEBOOK_PROOF_BUCKET ?? 'notebook-proof';
      },
    },
    notebookCurationQueue: {
      get url() {
        return process.env.NOTEBOOK_QUEUE_URL;
      },
    },
    websocket: { managementEndpoint: 'http://unused.invalid' },
  },
}));
// Cross-process integration proof starts at the backend API route; no UI is imported.
// eslint-disable-next-line no-restricted-imports
import curate from '@pages/api/notebooks/curate';
import * as storage from '@server/utils/storage';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { SelfHostWorker } from './selfHostWorker';
import { dispatchSelfHostEvent } from './eventDispatch';
import { registerNotebookCurationQueue } from './notebookCurationQueue';
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const logger = new Logger();
const enabled = process.env.NOTEBOOK_LIVE_PROOF === 'true';
describe.skipIf(!enabled)('notebook live broker and object storage proof', () => {
  let mongo: Awaited<ReturnType<typeof createMongoReplSet>>;
  const sqs = new SQSClient({ region: 'us-east-2' });
  const s3 = new S3Client({ region: 'us-east-2', endpoint: process.env.AWS_ENDPOINT_URL_S3, forcePathStyle: true });
  const eventUrl = process.env.SELF_HOST_EVENT_QUEUE!;
  const jobUrl = process.env.NOTEBOOK_QUEUE_URL!;
  beforeAll(async () => {
    mongo = await createMongoReplSet();
    process.env.NOTEBOOK_MONGO_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri());
    await Promise.all([NotebookCurationJob.init(), FabFile.init(), CreditTransaction.init()]);
    try {
      await s3.send(new CreateBucketCommand({ Bucket: 'notebook-proof' }));
    } catch (error) {
      if (!(error instanceof Error && error.name === 'BucketAlreadyOwnedByYou')) throw error;
    }
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });
  function worker() {
    const instance = new SelfHostWorker(logger);
    instance.registerQueueHandler(
      'events',
      eventUrl,
      async event => {
        const { detailType, detail } = JSON.parse(event.Records[0].body);
        await dispatchSelfHostEvent(detailType, detail, logger);
      },
      { batchSize: 1 }
    );
    registerNotebookCurationQueue(instance, jobUrl, logger);
    // Drive exactly one real receive/dispatch/delete iteration without leaving background long polls.
    const control = instance as unknown as {
      queues: unknown[];
      handleMessage: (queue: unknown, message: unknown) => Promise<void>;
      pollOnce: (queue: unknown) => Promise<void>;
    };
    return {
      events: () => control.pollOnce(control.queues[0]),
      handleEvent: (message: unknown) => control.handleMessage(control.queues[0], message),
      handleJob: (message: unknown) => control.handleMessage(control.queues[1], message),
      jobs: () => control.pollOnce(control.queues[1]),
    };
  }
  it('persists a default transcript from API through both queues and preserves it on replay after restart', async () => {
    const userId = String(new mongoose.Types.ObjectId());
    const sessionId = String(new mongoose.Types.ObjectId());
    await User.collection.insertOne({
      _id: new mongoose.Types.ObjectId(userId),
      username: userId,
      email: userId + '@example.invalid',
      currentCredits: 1000,
      storageLimit: 100000,
      currentStorageSize: 0,
    });
    await Session.collection.insertOne({
      _id: new mongoose.Types.ObjectId(sessionId),
      userId,
      name: 'Notebook live proof',
    });
    await Quest.collection.insertOne({
      _id: new mongoose.Types.ObjectId(),
      userId,
      sessionId,
      prompt: 'What survived?',
      reply: 'Persisted through both local queues.',
      timestamp: new Date(),
    });
    const req = { method: 'POST', body: { sessionIds: [sessionId] } };
    let statusCode = 200;
    let response: unknown;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(body: unknown) {
        response = body;
        return this;
      },
    };
    Object.assign(req, { user: { id: userId }, logger });
    await (curate as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
    expect(statusCode).toBe(202);
    const jobId = (response as { data: { curationJobs: { curationJobId: string }[] } }).data.curationJobs[0]
      .curationJobId;
    const first = worker();
    await first.events();
    // Fail only the post-commit completion notification, not progress callbacks.
    notify.mockImplementation(async (_user, _endpoint, message) => {
      if (message.status === 'completed') throw new Error('completion notification unavailable');
    });
    await first.jobs();
    const receipt = await NotebookCurationJob.findOne({ curationJobId: jobId }).lean();
    expect(receipt?.status).toBe('completed');
    const file = await FabFile.findById(receipt?.result?.curatedFileId).lean();
    expect((await Session.findById(sessionId).lean())?.curatedNotebookFileId).toBe(String(file!._id));
    const object = await s3.send(new GetObjectCommand({ Bucket: 'notebook-proof', Key: file!.filePath! }));
    expect(await object.Body!.transformToString()).toContain('Persisted through both local queues.');
    expect((await User.findById(userId).lean())?.currentCredits).toBe(900);
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: jobUrl,
        MessageBody: JSON.stringify({ sessionId, userId, curationJobId: jobId }),
      })
    );
    const restarted = worker();
    await restarted.jobs();
    expect(await FabFile.countDocuments({ userId })).toBe(1);
    expect(await CreditTransaction.countDocuments({ ownerId: userId })).toBe(1);
    expect((await User.findById(userId).lean())?.currentCredits).toBe(900);
    const state = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: jobUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      })
    );
    expect(state.Attributes).toMatchObject({
      ApproximateNumberOfMessages: '0',
      ApproximateNumberOfMessagesNotVisible: '0',
    });
  });
  it('retains repeated second-hop failures in native DLQ and replays the same job', async () => {
    const prior = await NotebookCurationJob.findOne({}).lean();
    expect(prior).not.toBeNull();
    const detail = { sessionId: prior!.sessionId, userId: prior!.userId, curationJobId: 'second-hop-replay' };
    const sent = await sqs.send(
      new SendMessageCommand({
        QueueUrl: eventUrl,
        MessageBody: JSON.stringify({ detailType: 'notebook.curation.start', detail }),
      })
    );
    process.env.NOTEBOOK_QUEUE_URL = `${jobUrl}-missing`;
    const runner = worker();
    let attempted = 0;
    const dlqUrl = eventUrl.replace('notebookEvents', 'notebookEventsDLQ');
    let retained: import('@aws-sdk/client-sqs').Message | undefined;
    try {
      for (let i = 0; i < 15 && !retained; i++) {
        const received = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: eventUrl,
            WaitTimeSeconds: 0,
            VisibilityTimeout: 1,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          })
        );
        for (const message of received.Messages ?? []) {
          await runner.handleEvent(message);
          if (message.MessageId === sent.MessageId) {
            attempted++;
            await sqs.send(
              new ChangeMessageVisibilityCommand({
                QueueUrl: eventUrl,
                ReceiptHandle: message.ReceiptHandle,
                VisibilityTimeout: 0,
              })
            );
          }
        }
        retained = (await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, WaitTimeSeconds: 0 }))).Messages?.[0];
      }
      expect(attempted).toBe(3);
      expect(retained?.MessageId).toBe(sent.MessageId);
      expect(JSON.parse(retained!.Body!).detail).toEqual(detail);
      expect(await NotebookCurationJob.findOne({ curationJobId: detail.curationJobId })).toBeNull();
    } finally {
      process.env.NOTEBOOK_QUEUE_URL = jobUrl;
    }
    const notifications = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: eventUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 })
    );
    for (const message of notifications.Messages ?? []) await runner.handleEvent(message);
    await sqs.send(new SendMessageCommand({ QueueUrl: eventUrl, MessageBody: retained!.Body }));
    await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: retained!.ReceiptHandle }));
    await runner.events();
    await runner.jobs();
    expect((await NotebookCurationJob.findOne({ curationJobId: detail.curationJobId }).lean())?.status).toBe(
      'completed'
    );
  });

  it('retains failed storage work in the native curation DLQ and completes the same job after repair', async () => {
    const userId = String(new mongoose.Types.ObjectId());
    const sessionId = String(new mongoose.Types.ObjectId());
    await User.collection.insertOne({
      _id: new mongoose.Types.ObjectId(userId),
      username: userId,
      email: userId + '@example.invalid',
      currentCredits: 1000,
      storageLimit: 100000,
      currentStorageSize: 0,
    });
    await Session.collection.insertOne({
      _id: new mongoose.Types.ObjectId(sessionId),
      userId,
      name: 'Storage recovery',
    });
    await Quest.collection.insertOne({
      _id: new mongoose.Types.ObjectId(),
      userId,
      sessionId,
      prompt: 'Recovered?',
      reply: 'Storage is available again.',
      timestamp: new Date(),
    });
    const detail = { userId, sessionId, curationJobId: 'storage-recovery' };
    const sent = await sqs.send(new SendMessageCommand({ QueueUrl: jobUrl, MessageBody: JSON.stringify(detail) }));
    const runner = worker();
    const dlqUrl = jobUrl + 'DLQ';
    let retained: import('@aws-sdk/client-sqs').Message | undefined;
    const brokenStorage = vi
      .spyOn(storage, 'getFilesStorage')
      .mockReturnValue(new S3Storage('notebook-missing-bucket'));
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const received = await sqs.send(
          new ReceiveMessageCommand({ QueueUrl: jobUrl, VisibilityTimeout: 1, WaitTimeSeconds: 1 })
        );
        const message = received.Messages![0];
        expect(message.MessageId).toBe(sent.MessageId);
        await runner.handleJob(message);
        expect(await NotebookCurationJob.findOne({ curationJobId: detail.curationJobId })).toBeNull();
        expect(await FabFile.countDocuments({ userId })).toBe(0);
        expect(await CreditTransaction.countDocuments({ ownerId: userId })).toBe(0);
        expect((await User.findById(userId).lean())?.currentCredits).toBe(1000);
        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: jobUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: 0,
          })
        );
      }
      await sqs.send(new ReceiveMessageCommand({ QueueUrl: jobUrl, WaitTimeSeconds: 1 }));
      retained = (await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, WaitTimeSeconds: 1 }))).Messages?.[0];
      expect(retained?.MessageId).toBe(sent.MessageId);
      expect(JSON.parse(retained!.Body!)).toEqual(detail);
    } finally {
      brokenStorage.mockRestore();
    }
    await sqs.send(new SendMessageCommand({ QueueUrl: jobUrl, MessageBody: retained!.Body }));
    await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: retained!.ReceiptHandle }));
    await runner.jobs();
    const receipt = await NotebookCurationJob.findOne({ curationJobId: detail.curationJobId }).lean();
    expect(receipt?.status).toBe('completed');
    expect((await User.findById(userId).lean())?.currentCredits).toBe(900);
    expect(await CreditTransaction.countDocuments({ ownerId: userId })).toBe(1);
    const file = await FabFile.findById(receipt!.result!.curatedFileId).lean();
    const stored = await s3.send(new GetObjectCommand({ Bucket: 'notebook-proof', Key: file!.filePath! }));
    expect(await stored.Body!.transformToString()).toContain('Storage is available again.');
  });
});
