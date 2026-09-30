import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { sessionAgentConfigRepository as repo } from './SessionAgentConfigModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const config = (agentId: string) => ({
  sessionId: 'session-1',
  agentId,
  userId: 'owner',
  proactiveMessaging: { enabled: false, activeHours: { startHour: 9, endHour: 17 }, systemPrompt: 'keep' },
});

beforeEach(async () => {
  await mongoose.connection.collection('sessionagentconfigs').deleteMany({});
  await repo.create(config('agent-a') as never);
  await repo.create(config('agent-b') as never);
});

const edit = {
  userId: 'sharee',
  proactiveMessaging: { enabled: true, activeHours: { startHour: 8, endHour: 18 }, systemPrompt: 'new' },
};

describe('sessionAgentConfigRepository.updateBySessionAndAgent', () => {
  it('re-stamps and rewrites only the matching pair', async () => {
    const updated = await repo.updateBySessionAndAgent('session-1', 'agent-a', edit);

    expect(updated).toMatchObject({ userId: 'sharee', proactiveMessaging: { enabled: true, systemPrompt: 'new' } });
    expect(await repo.findBySessionAndAgent('session-1', 'agent-b')).toMatchObject({
      userId: 'owner',
      proactiveMessaging: { enabled: false, systemPrompt: 'keep' },
    });
  });

  it('returns null and writes nothing when the pair does not exist', async () => {
    expect(await repo.updateBySessionAndAgent('session-2', 'agent-a', edit)).toBeNull();
    expect(await repo.findBySessionAndAgent('session-1', 'agent-a')).toMatchObject({ userId: 'owner' });
  });
});
