import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { OAuthClientModel } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';

vi.mock('./UserSeeder', () => ({ fetchSeederPassword: () => Promise.resolve('seeder-pw') }));

import {
  OAuthClientSeeder,
  PREVIEW_PUBLIC_CLIENT_ID,
  PREVIEW_CONFIDENTIAL_CLIENT_ID,
  PREVIEW_FEDERATED_CLIENT_ID,
} from './OAuthClientSeeder';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const APP_URL = 'https://pr-1.preview.example.com';
const priorIsPreview = process.env.IS_PREVIEW;
const priorAppUrl = process.env.APP_URL;
const logger = { info: vi.fn(), error: vi.fn() } as unknown as ConstructorParameters<typeof OAuthClientSeeder>[0];
let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await OAuthClientModel.init();
  process.env.IS_PREVIEW = 'true';
  process.env.APP_URL = APP_URL;
});

afterAll(async () => {
  if (priorIsPreview === undefined) delete process.env.IS_PREVIEW;
  else process.env.IS_PREVIEW = priorIsPreview;
  if (priorAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = priorAppUrl;
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await OAuthClientModel.deleteMany({});
});

// Real model, not mocks: seed() swallows errors into a log, so only the stored rows prove the
// federatedIdp validators accepted the seeded shape.
describe('OAuthClientSeeder (real DB)', () => {
  it('seeds three valid clients and stays at three on re-run', async () => {
    await new OAuthClientSeeder(logger).seed();
    await new OAuthClientSeeder(logger).seed();

    expect(logger.error).not.toHaveBeenCalled();
    expect(await OAuthClientModel.countDocuments()).toBe(3);
    const fed = await OAuthClientModel.findOne({ clientId: PREVIEW_FEDERATED_CLIENT_ID }).lean();
    expect(fed?.federatedIdp).toMatchObject({
      issuer: APP_URL,
      audience: PREVIEW_FEDERATED_CLIENT_ID,
      jwksUri: `${APP_URL}/api/oauth/jwks`,
      subjectSource: 'sub',
    });
  });

  it('keeps the public hash on re-run but re-sets the confidential secret', async () => {
    await new OAuthClientSeeder(logger).seed();
    await OAuthClientModel.updateOne({ clientId: PREVIEW_PUBLIC_CLIENT_ID }, { clientSecretHash: 'kept' });
    await OAuthClientModel.updateOne({ clientId: PREVIEW_CONFIDENTIAL_CLIENT_ID }, { clientSecretHash: 'stale' });

    await new OAuthClientSeeder(logger).seed();

    const pub = await OAuthClientModel.findOne({ clientId: PREVIEW_PUBLIC_CLIENT_ID }).lean();
    const conf = await OAuthClientModel.findOne({ clientId: PREVIEW_CONFIDENTIAL_CLIENT_ID }).lean();
    expect(pub?.clientSecretHash).toBe('kept');
    expect(await bcrypt.compare('seeder-pw', conf!.clientSecretHash)).toBe(true);
  });

  it('rejects a sub-federated client without jwksUri (the validator really runs)', async () => {
    const doc = new OAuthClientModel({
      clientId: 'no_jwks',
      clientSecretHash: 'x',
      name: 'No JWKS',
      redirectUris: ['https://example.com/cb'],
      allowedScopes: ['openid'],
      tokenEndpointAuthMethod: 'client_secret_post',
      clientType: 'relying-party',
      federatedIdp: { issuer: APP_URL, audience: 'no_jwks', subjectSource: 'sub' },
    });

    await expect(doc.validate()).rejects.toThrow(/jwksUri/);
  });

  it('restores seeded fields and removes federation from the ordinary clients on re-run', async () => {
    await new OAuthClientSeeder(logger).seed();
    await OAuthClientModel.updateMany(
      {},
      {
        name: 'Changed client',
        redirectUris: ['https://changed.example.com/cb'],
        allowedScopes: ['openid'],
        clientType: 'first-party',
        tokenEndpointAuthMethod: 'none',
        isActive: false,
        federatedIdp: {
          issuer: 'https://changed.example.com',
          audience: 'changed-audience',
          jwksUri: 'https://changed.example.com/jwks',
          subjectSource: 'sub',
        },
      }
    );

    await new OAuthClientSeeder(logger).seed();

    expect(logger.error).not.toHaveBeenCalled();
    expect(await OAuthClientModel.countDocuments()).toBe(3);
    for (const [clientId, name, tokenEndpointAuthMethod] of [
      [PREVIEW_PUBLIC_CLIENT_ID, 'Preview Public Client', 'none'],
      [PREVIEW_CONFIDENTIAL_CLIENT_ID, 'Preview Confidential Client', 'client_secret_post'],
      [PREVIEW_FEDERATED_CLIENT_ID, 'Preview Federated Client', 'client_secret_post'],
    ]) {
      const client = await OAuthClientModel.findOne({ clientId }).lean();
      expect(client).toMatchObject({
        clientId,
        name,
        tokenEndpointAuthMethod,
        redirectUris: ['https://example.com/cb'],
        clientType: 'relying-party',
        isActive: true,
        allowedScopes:
          clientId === PREVIEW_FEDERATED_CLIENT_ID
            ? ['openid', 'email', 'profile', 'ai:generate']
            : ['openid', 'email', 'profile'],
      });
      if (clientId === PREVIEW_FEDERATED_CLIENT_ID) {
        expect(client?.federatedIdp).toMatchObject({
          issuer: APP_URL,
          audience: PREVIEW_FEDERATED_CLIENT_ID,
          jwksUri: `${APP_URL}/api/oauth/jwks`,
          subjectSource: 'sub',
        });
      } else {
        expect(client?.federatedIdp).toBeUndefined();
      }
    }
  });
});
