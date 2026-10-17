import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { McpConnection, McpOAuthClientRegistration, McpOAuthPending, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235985_ensure-mcp-connection-indexes';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const MODELS = [
  {
    model: McpConnection,
    names: [
      'mcpconn_owner_slug',
      'mcpconn_user_enabled',
      'mcpconn_org_owner_type',
      'mcpconn_url_host',
      'mcpconn_definition',
    ],
  },
  { model: McpOAuthPending, names: ['stateHash_1', 'mcpoauthpending_ttl'] },
  { model: McpOAuthClientRegistration, names: ['mcpoauthclientreg_issuer_redirect'] },
] as const;

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Settle autoIndex before the hooks below drop indexes - see createMongoServer's autoIndex note.
  for (const { model } of MODELS) await model.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  for (const { model, names } of MODELS) {
    await mongoose.connection.db?.createCollection(model.collection.collectionName).catch(() => {});
    // autoIndex may have built them on connect; the migration's job is to build them where absent.
    for (const name of names) await safeDropIndex(model.collection, name);
  }
});

const indexByName = async (model: (typeof MODELS)[number]['model'], name: string) =>
  (await model.collection.indexes()).find(i => i.name === name);

describe('ensure-mcp-connection-indexes migration (real DB)', () => {
  it('builds the unique, TTL and query indexes on all three collections', async () => {
    expect(await indexByName(McpConnection, 'mcpconn_owner_slug')).toBeUndefined();

    await migration.up();

    for (const { model, names } of MODELS) {
      for (const name of names) expect(await indexByName(model, name)).toBeDefined();
    }
    expect(await indexByName(McpConnection, 'mcpconn_owner_slug')).toMatchObject({
      key: { ownerType: 1, ownerKey: 1, slug: 1 },
      unique: true,
    });
    expect(await indexByName(McpOAuthClientRegistration, 'mcpoauthclientreg_issuer_redirect')).toMatchObject({
      key: { issuer: 1, redirectUri: 1 },
      unique: true,
    });
    expect(await indexByName(McpOAuthPending, 'stateHash_1')).toMatchObject({ unique: true });
    expect(await indexByName(McpOAuthPending, 'mcpoauthpending_ttl')).toMatchObject({
      key: { createdAt: 1 },
      expireAfterSeconds: 600,
    });
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();
    expect(await indexByName(McpConnection, 'mcpconn_owner_slug')).toBeDefined();
  });
});
