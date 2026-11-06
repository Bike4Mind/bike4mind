import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { User, userRepository } from './UserModel';

// notionConnect.accessToken is select:false inside a nested schema; these pin that the
// token-reading path still returns it and that ordinary user writes never drop it.

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

const STORED_TOKEN = 'enc:v1:stored-ciphertext';

const seed = () =>
  User.create({
    username: 'notion-user',
    name: 'Notion User',
    email: 'notion-user@example.com',
    notionConnect: {
      accessToken: STORED_TOKEN,
      workspaceId: 'ws-1',
      workspaceName: 'Workspace',
      botId: 'bot-1',
      status: 'connected',
    },
  });

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

afterEach(async () => {
  await User.deleteMany({});
});

describe('notionConnect.accessToken persistence', () => {
  it('is hidden from a plain read and returned by findByIdWithNotionToken', async () => {
    const id = String((await seed())._id);

    const plain = await userRepository.findById(id);
    expect(plain?.notionConnect?.workspaceId).toBe('ws-1');
    expect(plain?.notionConnect?.accessToken).toBeUndefined();

    const withToken = await userRepository.findByIdWithNotionToken(id);
    expect(withToken?.notionConnect?.accessToken).toBe(STORED_TOKEN);
  });

  it('survives an unrelated user update and a dotted notionConnect settings update', async () => {
    const id = String((await seed())._id);

    await userRepository.update({ id, name: 'Renamed' });
    await userRepository.update({ id, 'notionConnect.writeEnabled': true } as Parameters<
      typeof userRepository.update
    >[0]);

    const after = await userRepository.findByIdWithNotionToken(id);
    expect(after?.notionConnect?.writeEnabled).toBe(true);
    expect(after?.notionConnect?.accessToken).toBe(STORED_TOKEN);
  });
});
