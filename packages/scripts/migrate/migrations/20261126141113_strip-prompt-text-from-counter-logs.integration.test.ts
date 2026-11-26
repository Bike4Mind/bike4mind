import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { CounterLog } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import migration from './20261126141113_strip-prompt-text-from-counter-logs';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('strip prompt text from counter logs', () => {
  it('replaces stored prompt text with its length and leaves other rows alone, idempotently', async () => {
    await CounterLog.collection.insertMany([
      { counterName: 'Prompt Heard', metadata: { sessionId: 's1', promptMessage: 'private prompt' } },
      { counterName: 'Session Created', metadata: { sessionId: 's2' } },
    ]);

    await migration.up();
    await migration.up();

    const heard = await CounterLog.collection.findOne({ counterName: 'Prompt Heard' });
    expect(heard?.metadata).toEqual({ sessionId: 's1', promptLength: 'private prompt'.length });
    const other = await CounterLog.collection.findOne({ counterName: 'Session Created' });
    expect(other?.metadata).toEqual({ sessionId: 's2' });
  });
});
