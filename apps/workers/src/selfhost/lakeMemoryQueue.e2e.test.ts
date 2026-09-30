import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, SQSEvent } from 'aws-lambda';
import type { Logger } from '@bike4mind/observability';
import mongoose from 'mongoose';
import {
  DataLakeModel,
  FabFile,
  FabFileChunk,
  dataLakeRepository,
  adminSettingsRepository,
  memoryLedgerRepository,
  memoryPrincipalKeyRepository,
} from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { createLedgerMemoryStore } from '@server/memory/ledgerMemoryStore';
import { createKeyProvider } from '@server/memory/factCipher';

const { evaluate, send, receive, remove } = vi.hoisted(() => ({
  evaluate: vi.fn(),
  send: vi.fn(),
  receive: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('@bike4mind/services', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services')>()),
  apiKeyService: { getEffectiveLLMApiKeys: async () => ({}) },
}));
vi.mock('@bike4mind/services/llm', () => ({
  LakeMemoryExtractionService: class {
    evaluate = evaluate;
  },
}));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: send, receiveFromQueue: receive, deleteFromQueue: remove }));
vi.mock('sst', () => ({ Resource: { lakeMemoryQueue: { url: 'http://sqs/lake-memory' } } }));
vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger:
    (handler: (event: SQSEvent, context: Context, logger: Logger) => Promise<unknown>) =>
    (event: SQSEvent, context: Context) =>
      handler(event, context, {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        updateMetadata: vi.fn(),
      } as unknown as Logger),
}));

import { registerLakeMemoryQueue } from './lakeMemoryQueue';
import { SelfHostWorker } from './selfHostWorker';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
let lakeId: string;
let ids: string[];
const owner = 'local-owner';
const tag = 'datalake:local-fixture';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const message = (body: unknown, count = 1) => ({
  MessageId: 'local-message',
  ReceiptHandle: `receipt-${count}`,
  Body: JSON.stringify(body),
  Attributes: { ApproximateReceiveCount: String(count) },
});
const payload = () => ({ batchId: 'local-batch', dataLakeId: lakeId, userId: owner });
async function deliver(body: unknown = payload(), count = 1) {
  const worker = new SelfHostWorker(logger);
  registerLakeMemoryQueue(worker, 'http://sqs/lake-memory', logger);
  receive
    .mockImplementationOnce(async () => [message(body, count)])
    .mockImplementationOnce(async () => {
      worker.stop();
      return [];
    });
  worker.start();
  await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2), { timeout: 20_000 });
  await worker.stop();
  receive.mockReset();
}
async function beliefs() {
  const profile = await createLedgerMemoryStore({
    ledger: memoryLedgerRepository,
    keys: createKeyProvider(memoryPrincipalKeyRepository),
    ownerUserId: owner,
  }).readProfile({ kind: 'lake', id: tag });
  return (
    profile?.beliefs
      .map(b => ({ fact: b.fact, sources: b.sources }))
      .sort((a, b) => String(a.fact).localeCompare(String(b.fact))) ?? []
  );
}

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  vi.spyOn(adminSettingsRepository, 'getSettingsValue').mockResolvedValue(true);
  send.mockResolvedValue('continuation');
  remove.mockResolvedValue(undefined);
  const lake = await DataLakeModel.create({
    name: 'Local fixture',
    slug: 'local-fixture',
    datalakeTag: tag,
    fileTagPrefix: 'local:',
    createdByUserId: owner,
    status: 'active',
    lakeMemoryEnabled: true,
  });
  lakeId = String(lake._id);
  ids = [];
  for (const text of ['The amber engine produces 12 watts.', 'The violet engine produces 27 watts.']) {
    const id = new mongoose.Types.ObjectId();
    ids.push(String(id));
    await FabFile.collection.insertOne({
      _id: id,
      userId: owner,
      fileName: text,
      tags: [{ name: tag }],
      deletedAt: null,
      archivedAt: null,
    });
    await FabFileChunk.collection.insertOne({ fabFileId: String(id), text });
  }
  evaluate.mockImplementation(async ({ docText }: { docText: string }) => [{ fact: docText }]);
});
afterEach(() => vi.restoreAllMocks());

describe('local lake-memory registered consumer', () => {
  it('persists exact beliefs, acknowledges and coalesces repeated delivery', async () => {
    await deliver();
    expect(await beliefs()).toEqual([
      { fact: 'The amber engine produces 12 watts.', sources: [ids[0]] },
      { fact: 'The violet engine produces 27 watts.', sources: [ids[1]] },
    ]);
    expect(remove).toHaveBeenCalledWith('http://sqs/lake-memory', 'receipt-1');
    expect((await dataLakeRepository.findById(lakeId))?.lakeMemoryExtractionAt).toBeNull();
    await deliver(payload(), 2);
    expect(await beliefs()).toHaveLength(2);
    expect(remove).toHaveBeenCalledWith('http://sqs/lake-memory', 'receipt-2');
  });

  it('allows only one concurrent lease owner and does not extract under the winning lease', async () => {
    const at = new Date();
    const claims = await Promise.all([
      dataLakeRepository.claimLakeMemoryExtraction(lakeId, at, new Date(at.getTime() - 900_000)),
      dataLakeRepository.claimLakeMemoryExtraction(lakeId, at, new Date(at.getTime() - 900_000)),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await deliver();
    expect(evaluate).not.toHaveBeenCalled();
    expect(await beliefs()).toEqual([]);
    await dataLakeRepository.releaseLakeMemoryExtraction(lakeId, at);
    await deliver(payload(), 2);
    expect(await beliefs()).toHaveLength(2);
  });

  it('honors both opt-in gates without writing beliefs', async () => {
    vi.mocked(adminSettingsRepository.getSettingsValue).mockResolvedValueOnce(false);
    await deliver();
    await DataLakeModel.updateOne({ _id: lakeId }, { $set: { lakeMemoryEnabled: false } });
    await deliver();
    expect(evaluate).not.toHaveBeenCalled();
    expect(await beliefs()).toEqual([]);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('cannot recover a crashed lease at twelve minutes, but reclaims it at sixteen', async () => {
    const now = Date.now();
    await DataLakeModel.updateOne({ _id: lakeId }, { $set: { lakeMemoryExtractionAt: new Date(now - 12 * 60_000) } });
    await deliver(payload(), 2);
    expect(evaluate).not.toHaveBeenCalled();
    expect(await beliefs()).toEqual([]);
    expect(remove).toHaveBeenCalledWith('http://sqs/lake-memory', 'receipt-2');
    await DataLakeModel.updateOne({ _id: lakeId }, { $set: { lakeMemoryExtractionAt: new Date(now - 16 * 60_000) } });
    await deliver(payload(), 2);
    expect(await beliefs()).toHaveLength(2);
    expect((await dataLakeRepository.findById(lakeId))?.lakeMemoryExtractionAt).toBeNull();
  });

  it('recovers a crash after ninety seconds of pre-claim work with the configured visibility', async () => {
    const registration = { registerQueueHandler: vi.fn() };
    registerLakeMemoryQueue(registration, 'http://sqs/lake-memory', logger);
    const { visibilityTimeoutSec } = registration.registerQueueHandler.mock.calls[0][3];
    const claimDelaySec = 90;
    const receiveAt = Date.now();
    await DataLakeModel.updateOne(
      { _id: lakeId },
      { $set: { lakeMemoryExtractionAt: new Date(receiveAt - (960 - claimDelaySec) * 1000) } }
    );
    await deliver(payload(), 2);
    expect(await beliefs()).toEqual([]);
    expect(remove).toHaveBeenCalledWith('http://sqs/lake-memory', 'receipt-2');
    await DataLakeModel.updateOne(
      { _id: lakeId },
      { $set: { lakeMemoryExtractionAt: new Date(receiveAt - (visibilityTimeoutSec - claimDelaySec) * 1000) } }
    );
    await deliver(payload(), 2);
    expect(await beliefs()).toHaveLength(2);
    expect((await dataLakeRepository.findById(lakeId))?.lakeMemoryExtractionAt).toBeNull();
  });

  it('yields at the decreasing deadline and resumes the persisted cursor after a failed continuation send', async () => {
    const realNow = Date.now.bind(Date);
    let elapsed = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + elapsed);
    evaluate.mockImplementation(async ({ docText }: { docText: string }) => {
      elapsed = 540_000;
      return [{ fact: docText }];
    });
    send.mockRejectedValueOnce(new Error('broker unavailable'));
    await deliver();
    expect(remove).not.toHaveBeenCalled();
    expect(await beliefs()).toEqual([{ fact: 'The amber engine produces 12 watts.', sources: [ids[0]] }]);
    expect((await dataLakeRepository.findById(lakeId))?.lakeMemoryCursor).toBe(ids[0]);
    expect(send).toHaveBeenCalledWith('http://sqs/lake-memory', { ...payload(), slice: 1 });
    elapsed = 0;
    evaluate.mockImplementation(async ({ docText }: { docText: string }) => [{ fact: docText }]);
    await deliver(payload(), 2);
    expect(await beliefs()).toHaveLength(2);
    expect((await dataLakeRepository.findById(lakeId))?.lakeMemoryCursor).toBeNull();
    expect(remove).toHaveBeenCalledWith('http://sqs/lake-memory', 'receipt-2');
  });

  it('finishes both slices through the actual continuation payload', async () => {
    const realNow = Date.now.bind(Date);
    let elapsed = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + elapsed);
    evaluate.mockImplementation(async ({ docText }: { docText: string }) => {
      elapsed = 540_000;
      return [{ fact: docText }];
    });
    await deliver();
    expect(await beliefs()).toHaveLength(1);
    const continuation = send.mock.calls[0][1];
    expect(continuation).toEqual({ ...payload(), slice: 1 });
    elapsed = 0;
    evaluate.mockImplementation(async ({ docText }: { docText: string }) => [{ fact: docText }]);
    await deliver(continuation);
    expect(await beliefs()).toEqual([
      { fact: 'The amber engine produces 12 watts.', sources: [ids[0]] },
      { fact: 'The violet engine produces 27 watts.', sources: [ids[1]] },
    ]);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect((await dataLakeRepository.findById(lakeId))?.lakeMemoryCursor).toBeNull();
  });

  it('retains a transient lookup failure then produces beliefs on redelivery', async () => {
    vi.mocked(adminSettingsRepository.getSettingsValue).mockRejectedValueOnce(new Error('temporary database failure'));
    await deliver();
    expect(remove).not.toHaveBeenCalled();
    expect(await beliefs()).toEqual([]);
    await deliver(payload(), 2);
    expect(await beliefs()).toHaveLength(2);
    expect(remove).toHaveBeenCalledWith('http://sqs/lake-memory', 'receipt-2');
  });
});
