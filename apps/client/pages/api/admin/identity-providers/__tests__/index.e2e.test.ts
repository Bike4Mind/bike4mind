import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
// createMongoReplSet is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { identityProviderRepository } from '@bike4mind/database';
import { configureSecretsAtRest, generateEncryptionKey } from '@bike4mind/utils/security';

/**
 * Drives the REAL repository, model and encryption against createMongoReplSet, so the response
 * schema is exercised over documents that actually hold stored credentials. The unit tests feed
 * the routes hand-built objects; only this one proves a stored credential is reported as present
 * without its value ever reaching a response, and survives an edit that omits it.
 */

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain: Record<string, unknown> = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) middleware(req, res, () => undefined);
        return h[(req as { method?: string }).method ?? 'GET']?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (middlewares.push(fn), chain),
        get: (fn: (req: unknown, res: unknown) => unknown) => ((h.GET = fn), chain),
        post: (fn: (req: unknown, res: unknown) => unknown) => ((h.POST = fn), chain),
        put: (fn: (req: unknown, res: unknown) => unknown) => ((h.PUT = fn), chain),
        delete: (fn: (req: unknown, res: unknown) => unknown) => ((h.DELETE = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/auth/oktaOidcClient', () => ({ clearConfigurationCache: vi.fn() }));

import listHandler from '../index';
import itemHandler from '../[id]';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: Awaited<ReturnType<typeof createMongoReplSet>> | undefined;

beforeAll(async () => {
  configureSecretsAtRest(generateEncryptionKey());
  // A replica set, because create and update write the admin audit entry in a transaction.
  mongoServer = await createMongoReplSet();
  await mongoose.connect(mongoServer.getUri());
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

type Handler = (req: unknown, res: unknown) => Promise<void>;

const call = async (handler: unknown, method: string, { body, id }: { body?: object; id?: string } = {}) => {
  const { req, res } = createMocks({ method: method as 'GET', body, query: id ? { id } : {} });
  (req as unknown as Record<string, unknown>).user = {
    id: 'admin1',
    username: 'admin',
    email: 'admin@example.com',
    isAdmin: true,
  };
  await (handler as Handler)(req, res);
  return res;
};

const SECRET_VALUES = /SP-DECRYPTION-KEY|SP-SIGNING-KEY/;

const createProvider = async () => {
  const res = await call(listHandler, 'POST', {
    body: {
      name: 'Acme SAML',
      emailDomain: 'acme.test',
      type: 'saml',
      samlConfig: {
        entryPoint: 'https://idp.acme.test/sso',
        issuer: 'acme',
        cert: 'PUBLIC-IDP-CERT',
        decryptionPvk: 'SP-DECRYPTION-KEY',
        privateCert: 'SP-SIGNING-KEY',
      },
    },
  });
  return res;
};

describe('admin identity providers with stored credentials (real database)', () => {
  it('create returns 201 without the submitted credentials', async () => {
    const res = await createProvider();
    expect(res._getStatusCode()).toBe(201);

    const body = res._getJSONData();
    expect(JSON.stringify(body)).not.toMatch(SECRET_VALUES);
    expect(body.samlConfig).not.toHaveProperty('decryptionPvk');
    expect(body.samlConfig).not.toHaveProperty('privateCert');
    expect(body.samlConfig.cert).toBe('PUBLIC-IDP-CERT');
    expect(body).not.toHaveProperty('__v');

    // The credentials really were stored - the response withheld them, it did not lose them.
    const stored = await identityProviderRepository.findByIdWithSecrets(body.id);
    expect(stored?.samlConfig?.decryptionPvk).toBe('SP-DECRYPTION-KEY');
    expect(stored?.samlConfig?.privateCert).toBe('SP-SIGNING-KEY');
  });

  it('list reports stored credentials as present flags and never returns their values', async () => {
    await createProvider();

    const res = await call(listHandler, 'GET');
    expect(res._getStatusCode()).toBe(200);

    const [row] = res._getJSONData();
    expect(JSON.stringify(row)).not.toMatch(SECRET_VALUES);
    expect(row.hasSecrets).toEqual({ decryptionPvk: true, privateCert: true, clientSecret: false });
    expect(row.samlConfig).not.toHaveProperty('decryptionPvk');
    expect(row.samlConfig).not.toHaveProperty('privateCert');
  });

  it('keeps stored credentials when an edit omits them, and the update response withholds them', async () => {
    const { id } = (await createProvider())._getJSONData();

    const update = await call(itemHandler, 'PUT', {
      id,
      body: {
        name: 'Acme SAML renamed',
        samlConfig: { entryPoint: 'https://idp.acme.test/sso', issuer: 'acme', cert: 'PUBLIC-IDP-CERT' },
      },
    });
    expect(update._getStatusCode()).toBe(200);
    expect(update._getJSONData().name).toBe('Acme SAML renamed');
    expect(JSON.stringify(update._getJSONData())).not.toMatch(SECRET_VALUES);

    const list = await call(listHandler, 'GET');
    expect(list._getJSONData()[0].hasSecrets).toEqual({ decryptionPvk: true, privateCert: true, clientSecret: false });

    const stored = await identityProviderRepository.findByIdWithSecrets(id);
    expect(stored?.samlConfig?.decryptionPvk).toBe('SP-DECRYPTION-KEY');
    expect(stored?.samlConfig?.privateCert).toBe('SP-SIGNING-KEY');
  });

  it('get-by-id withholds credentials too', async () => {
    const { id } = (await createProvider())._getJSONData();

    const res = await call(itemHandler, 'GET', { id });
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.stringify(res._getJSONData())).not.toMatch(SECRET_VALUES);
    expect(res._getJSONData().samlConfig.cert).toBe('PUBLIC-IDP-CERT');
  });
});
