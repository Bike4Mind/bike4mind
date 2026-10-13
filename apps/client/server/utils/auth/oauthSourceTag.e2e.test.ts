import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';

const mockFindByClientId = vi.fn();
vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  oauthClientRepository: { findByClientId: (...a: unknown[]) => mockFindByClientId(...a) },
}));

import { User } from '@bike4mind/database';
import { stampOAuthSourceTag } from './oauthSourceTag';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await User.deleteMany({});
  mockFindByClientId.mockReset();
});

const CLIENT_ID = 'b4m_qa_sat_0123abcd';

async function makeUser(tags: string[] = []) {
  return User.create({ username: 'sso-user', name: 'SSO User', email: 'sso@example.com', tags });
}

async function tagsOf(id: string) {
  return (await User.findById(id).lean())?.tags ?? [];
}

describe('stampOAuthSourceTag', () => {
  it('adds the source tag for an active client, once, keeping existing tags', async () => {
    mockFindByClientId.mockResolvedValue({ clientId: CLIENT_ID, isActive: true });
    const user = await makeUser(['beta']);

    await stampOAuthSourceTag(user.id, CLIENT_ID);
    await stampOAuthSourceTag(user.id, CLIENT_ID);

    expect(await tagsOf(user.id)).toEqual(['beta', 'source:qa_sat']);
  });

  it('adds nothing for an inactive or unknown client, or no clientId', async () => {
    const user = await makeUser();
    mockFindByClientId.mockResolvedValueOnce({ clientId: CLIENT_ID, isActive: false });
    await stampOAuthSourceTag(user.id, CLIENT_ID);
    mockFindByClientId.mockResolvedValueOnce(null);
    await stampOAuthSourceTag(user.id, 'b4m_nope_0123abcd');
    await stampOAuthSourceTag(user.id, undefined);

    expect(await tagsOf(user.id)).toEqual([]);
  });

  it('logs and swallows a lookup failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFindByClientId.mockRejectedValue(new Error('db down'));
    const user = await makeUser();

    await expect(stampOAuthSourceTag(user.id, CLIENT_ID)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('oauthSourceTag'), CLIENT_ID, expect.any(Error));
    expect(await tagsOf(user.id)).toEqual([]);
    warn.mockRestore();
  });
});
