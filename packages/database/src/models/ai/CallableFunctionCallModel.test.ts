import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import type { ICallableFunctionCall } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { CallableFunctionCall, callableFunctionCallRepository } from './CallableFunctionCallModel';

const HASH = 'a'.repeat(64);

const row = (overrides: Partial<ICallableFunctionCall> = {}): ICallableFunctionCall => ({
  op: 'call',
  functionId: new mongoose.Types.ObjectId().toHexString(),
  ownerUserId: 'owner-1',
  callerUserId: 'owner-1',
  surface: 'test',
  codeHash: HASH,
  inputHash: HASH,
  dataHashes: [],
  runtime: { kind: 'pyodide-server', version: '0.25.1', lockHash: HASH },
  startedAt: new Date(),
  durationMs: 12,
  inputBytes: 20,
  outputBytes: 18,
  outcome: 'ok',
  ...overrides,
});

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await CallableFunctionCall.init();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await CallableFunctionCall.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('CallableFunctionCall', () => {
  it('recovers the same immutable call after a persisted write loses its acknowledgement', async () => {
    const callId = new mongoose.Types.ObjectId().toHexString();
    const input = row();
    const create = callableFunctionCallRepository.create.bind(callableFunctionCallRepository);
    const acknowledgementError = new Error('acknowledgement lost');
    vi.spyOn(callableFunctionCallRepository, 'create').mockImplementationOnce(async data => {
      await create(data);
      throw acknowledgementError;
    });
    await expect(callableFunctionCallRepository.record(input, callId)).rejects.toBe(acknowledgementError);
    const original = await CallableFunctionCall.collection.findOne({ functionId: input.functionId });
    expect(original?._id.toHexString()).toBe(callId);
    const recovered = await callableFunctionCallRepository.record({ ...input, outcome: 'error' }, callId);
    expect(recovered.id).toBe(callId);
    expect(await CallableFunctionCall.collection.findOne({ _id: new mongoose.Types.ObjectId(callId) })).toEqual(
      original
    );
    expect(await CallableFunctionCall.countDocuments()).toBe(1);
  });

  it('keeps distinct invocations with identical inputs and propagates nonduplicate failures', async () => {
    const input = row();
    const firstId = new mongoose.Types.ObjectId().toHexString();
    const secondId = new mongoose.Types.ObjectId().toHexString();
    expect((await callableFunctionCallRepository.record(input, firstId)).id).toBe(firstId);
    expect((await callableFunctionCallRepository.record(input, secondId)).id).toBe(secondId);
    expect(await CallableFunctionCall.countDocuments()).toBe(2);
    const error = new Error('storage unavailable');
    vi.spyOn(callableFunctionCallRepository, 'create').mockRejectedValueOnce(error);
    await expect(callableFunctionCallRepository.record(input, firstId)).rejects.toBe(error);
  });

  it('stores a call in callablefunctioncalls', async () => {
    const created = await callableFunctionCallRepository.record(row());
    expect(CallableFunctionCall.collection.collectionName).toBe('callablefunctioncalls');
    const stored = await CallableFunctionCall.findById(created.id).lean();
    expect(stored).toMatchObject({ outcome: 'ok', surface: 'test', inputHash: HASH, dataHashes: [] });
  });

  it('drops inputs, outputs, and any other field outside the schema', async () => {
    const leaky = { ...row(), inputs: { span: 5 }, outputs: { deflection: 0.25 }, params: { span: 5 } };
    const created = await callableFunctionCallRepository.record(leaky);
    const stored = await CallableFunctionCall.collection.findOne({ _id: new mongoose.Types.ObjectId(created.id) });
    expect(stored).not.toHaveProperty('inputs');
    expect(stored).not.toHaveProperty('outputs');
    expect(stored).not.toHaveProperty('params');
  });

  it('refuses an unknown outcome or surface, a reason that is not a fixed code, and a malformed hash', async () => {
    await expect(callableFunctionCallRepository.record(row({ outcome: 'crashed' as never }))).rejects.toThrow(
      /outcome/
    );
    await expect(callableFunctionCallRepository.record(row({ surface: 'slack' as never }))).rejects.toThrow(/surface/);
    await expect(callableFunctionCallRepository.record(row({ op: 'invoke' as never }))).rejects.toThrow(/op/);
    await expect(callableFunctionCallRepository.record(row({ op: undefined as never }))).rejects.toThrow(/op/);
    await expect(
      callableFunctionCallRepository.record(row({ outcome: 'error', reason: 'Traceback (most recent call last)' }))
    ).rejects.toThrow(/reason/);
    await expect(callableFunctionCallRepository.record(row({ inputHash: 'not-a-hash' }))).rejects.toThrow(/inputHash/);
  });

  it('declares the two lookups and a 90-day expiry on startedAt', async () => {
    const indexes = await CallableFunctionCall.collection.indexes();
    const byName = new Map(indexes.map(index => [index.name, index]));
    expect(byName.get('callablefncall_function_started')?.key).toEqual({ functionId: 1, startedAt: -1 });
    expect(byName.get('callablefncall_caller_started')?.key).toEqual({ callerUserId: 1, startedAt: -1 });
    expect(byName.get('callablefncall_ttl')).toMatchObject({ key: { startedAt: 1 }, expireAfterSeconds: 7776000 });
  });
});
