import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';

import { OAuthClientModel, User } from '@bike4mind/database';
import { createUniqueOAuthUser } from './createOAuthUser';
import { resolveSignupClientId } from './signupClientId';

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
  await OAuthClientModel.deleteMany({});
});

const ACTIVE = 'b4m_active_0123abcd';
const INACTIVE = 'b4m_paused_0123abcd';
const authorize = (clientId: string) => `/oauth/authorize?client_id=${clientId}&response_type=code`;

async function seedClient(clientId: string, isActive: boolean) {
  await OAuthClientModel.create({
    clientId,
    clientSecretHash: 'unused',
    name: clientId,
    redirectUris: ['https://example.com/callback'],
    isActive,
  });
}

describe('signupClientId against a real database', () => {
  it('records only an active registered client, and never rewrites it', async () => {
    await seedClient(ACTIVE, true);
    await seedClient(INACTIVE, false);

    expect(await resolveSignupClientId(authorize(ACTIVE))).toBe(ACTIVE);
    expect(await resolveSignupClientId(authorize(INACTIVE))).toBeNull();
    expect(await resolveSignupClientId(authorize('b4m_unknown_0123abcd'))).toBeNull();

    const user = await createUniqueOAuthUser({
      name: 'Sat User',
      baseUsername: 'sat-user',
      email: 'sat@example.com',
      oauthCredentials: { strategy: 'google', id: 'sub-sat' },
      signupClientId: await resolveSignupClientId(authorize(ACTIVE)),
    });
    await User.updateOne({ _id: user._id }, { $set: { signupClientId: INACTIVE } });

    expect((await User.findById(user._id).lean())?.signupClientId).toBe(ACTIVE);
  });
});
