import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
  await CallableFunctionCall.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('CallableFunctionCall', () => {
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
