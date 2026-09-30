import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import { Session, NotebookCurationJob } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-sqs', async importOriginal => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-sqs')>()),
  SQSClient: class {
    async send(command: { input: { QueueUrl?: string; MessageBody?: string } }) {
      return { MessageId: await send(command.input.QueueUrl, JSON.parse(command.input.MessageBody!)) };
    }
  },
}));
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: class {
    constructor() {
      throw new Error('Unexpected hosted publisher');
    }
  },
  PutEventsCommand: class {},
}));
vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ post: (fn: unknown) => fn }) }));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
import handler from '../curate';
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
let server: Awaited<ReturnType<typeof createMongoServer>>;
async function session() {
  const _id = new mongoose.Types.ObjectId();
  await Session.collection.insertOne({ _id, userId: 'owner', name: 'local transcript' });
  return String(_id);
}
function request(ids: string[]) {
  const { req, res } = createMocks({ method: 'POST', body: { sessionIds: ids, curationType: 'transcript' } });
  Object.assign(req, { user: { id: 'owner' }, logger });
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
}
beforeAll(async () => {
  server = await createMongoServer({ instance: { launchTimeout: MONGO_TEST_TIMEOUT_MS } });
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('B4M_SELF_HOST', 'true');
  vi.stubEnv('SELF_HOST_EVENT_QUEUE', 'http://local.invalid/events');
  send.mockReset().mockResolvedValue('accepted');
  await Session.collection.deleteMany({});
  await NotebookCurationJob.collection.deleteMany({});
});
afterEach(() => vi.unstubAllEnvs());
describe('notebook submission acceptance', () => {
  it('returns an error on broker rejection, creates no pending row, and permits a later accepted request', async () => {
    const id = await session();
    send.mockRejectedValueOnce(new Error('broker rejected'));
    const failed = request([id]);
    await failed.promise;
    expect(failed.res._getStatusCode()).toBe(500);
    expect(failed.res._getJSONData()).toMatchObject({ success: false });
    expect(await NotebookCurationJob.countDocuments({})).toBe(0);
    const retried = request([id]);
    await retried.promise;
    expect(retried.res._getStatusCode()).toBe(202);
    expect(send.mock.calls[0]![1].detail.curationJobId).not.toBe(send.mock.calls[1]![1].detail.curationJobId);
    expect(await NotebookCurationJob.countDocuments({})).toBe(0);
    expect(await Session.collection.findOne({ _id: new mongoose.Types.ObjectId(id) })).toMatchObject({
      name: 'local transcript',
    });
  });
  it('does not answer 202 until the broker accepts the event', async () => {
    const id = await session();
    let accept!: (value: string) => void;
    let submitted!: () => void;
    const started = new Promise<void>(resolve => {
      submitted = resolve;
    });
    send.mockImplementationOnce(() => {
      submitted();
      return new Promise<string>(resolve => {
        accept = resolve;
      });
    });
    const pending = request([id]);
    await started;
    expect(pending.res._isEndCalled()).toBe(false);
    accept('accepted');
    await pending.promise;
    expect(pending.res._getStatusCode()).toBe(202);
    expect(send).toHaveBeenCalledWith(
      'http://local.invalid/events',
      expect.objectContaining({ detailType: 'notebook.curation.start' })
    );
  });
  it('reports mixed-batch failure without claiming to undo the accepted event', async () => {
    const ids = [await session(), await session()];
    const accepted: unknown[] = [];
    send.mockImplementation(async (_queue, event) => {
      if (event.detail.sessionId === ids[1]) throw new Error('second rejected');
      accepted.push(event);
      return 'accepted-first';
    });
    const mixed = request(ids);
    await mixed.promise;
    expect(mixed.res._getStatusCode()).toBe(500);
    expect(accepted).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await NotebookCurationJob.countDocuments({})).toBe(0);
  });
  it('returns an error for missing queue configuration without sending', async () => {
    vi.stubEnv('SELF_HOST_EVENT_QUEUE', '');
    const failed = request([await session()]);
    await failed.promise;
    expect(failed.res._getStatusCode()).toBe(500);
    expect(send).not.toHaveBeenCalled();
    expect(await NotebookCurationJob.countDocuments({})).toBe(0);
  });
});
