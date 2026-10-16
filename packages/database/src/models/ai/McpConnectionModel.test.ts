import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { MCP_CONNECTION_SECRET_PATHS, toMcpConnectionPublic, type IMcpConnectionDocument } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { McpConnection, mcpConnectionRepository } from './McpConnectionModel';

type CreateInput = Omit<IMcpConnectionDocument, 'id' | 'createdAt' | 'updatedAt'>;

const baseConnection = (overrides: Partial<CreateInput> = {}): CreateInput => ({
  ownerType: 'user',
  ownerKey: 'user-1',
  userId: 'user-1',
  slug: 'linear',
  displayName: 'Linear',
  url: 'https://mcp.linear.app/mcp',
  urlHost: 'mcp.linear.app',
  transport: 'auto',
  auth: {
    kind: 'oauth',
    oauth: {
      resource: 'https://mcp.linear.app/mcp',
      issuer: 'https://linear.app',
      authorizationServerUrl: 'https://linear.app',
      scopes: ['read'],
      clientMode: 'dcr',
      accessTokenEnc: 'enc:access',
      refreshTokenEnc: 'enc:refresh',
      manualClientIdEnc: 'enc:client-id',
      manualClientSecretEnc: 'enc:client-secret',
    },
  },
  status: 'connected',
  tools: [],
  enabled: true,
  ...overrides,
});

const apiKeyConnection = (overrides: Partial<CreateInput> = {}): CreateInput =>
  baseConnection({
    slug: 'airtable',
    url: 'https://mcp.airtable.com/mcp',
    urlHost: 'mcp.airtable.com',
    auth: {
      kind: 'api_key',
      apiKey: { headerName: 'Authorization', scheme: 'Bearer', valueEnc: 'enc:key', last4: 'abcd' },
    },
    ...overrides,
  });

function secretValues(doc: unknown): unknown[] {
  return MCP_CONNECTION_SECRET_PATHS.map(path =>
    path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], doc)
  ).filter(v => v !== undefined);
}

describe('McpConnectionModel', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await McpConnection.init();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  afterEach(async () => {
    await McpConnection.deleteMany({});
  });

  describe('indexes', () => {
    it('declares the design indexes by name', async () => {
      const indexes = await McpConnection.collection.indexes();
      const byName = new Map(indexes.map(i => [i.name, i]));
      expect(byName.get('mcpconn_owner_slug')).toMatchObject({
        key: { ownerType: 1, ownerKey: 1, slug: 1 },
        unique: true,
      });
      expect(byName.get('mcpconn_user_enabled')?.key).toEqual({ userId: 1, enabled: 1 });
      expect(byName.get('mcpconn_org_owner_type')?.key).toEqual({ organizationId: 1, ownerType: 1 });
      expect(byName.get('mcpconn_url_host')?.key).toEqual({ urlHost: 1 });
      expect(byName.get('mcpconn_definition')).toMatchObject({ key: { definitionId: 1 }, sparse: true });
    });

    it('rejects a duplicate slug for the same owner', async () => {
      await mcpConnectionRepository.create(baseConnection());
      await expect(mcpConnectionRepository.create(baseConnection({ displayName: 'Again' }))).rejects.toThrow(/E11000/);
    });

    it('allows the same slug for a different owner or owner type', async () => {
      await mcpConnectionRepository.create(baseConnection());
      await mcpConnectionRepository.create(baseConnection({ ownerKey: 'user-2', userId: 'user-2' }));
      await mcpConnectionRepository.create(
        baseConnection({ ownerType: 'org', ownerKey: 'user-1', organizationId: 'user-1', auth: { kind: 'none' } })
      );
      expect(await McpConnection.countDocuments({ slug: 'linear' })).toBe(3);
    });
  });

  describe('secret handling', () => {
    it('stores the ciphertext but leaves it out of every default read', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      const createdKey = await mcpConnectionRepository.create(apiKeyConnection());

      expect(secretValues(created)).toEqual([]);
      expect(secretValues(createdKey)).toEqual([]);
      expect(createdKey.auth.apiKey?.last4).toBe('abcd');

      const reads = [
        await mcpConnectionRepository.findById(created.id),
        await mcpConnectionRepository.findByIdForOwner(created.id, { ownerType: 'user', ownerKey: 'user-1' }),
        ...(await mcpConnectionRepository.listForUser('user-1')),
        ...(await mcpConnectionRepository.listAllForUser('user-1')),
        ...(await mcpConnectionRepository.findByUrlHost('mcp.linear.app')),
        await mcpConnectionRepository.setStatus(created.id, 'error', { code: 'timeout', message: 'slow' }),
        await mcpConnectionRepository.updateTools(created.id, [], 'fp'),
      ];
      for (const doc of reads) {
        expect(doc).not.toBeNull();
        expect(secretValues(doc)).toEqual([]);
      }
    });

    it('returns every secret from the credential read', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      const withCreds = await mcpConnectionRepository.findByIdWithCredentials(created.id);
      expect(withCreds?.auth.oauth).toMatchObject({
        accessTokenEnc: 'enc:access',
        refreshTokenEnc: 'enc:refresh',
        manualClientIdEnc: 'enc:client-id',
        manualClientSecretEnc: 'enc:client-secret',
      });

      const key = await mcpConnectionRepository.create(apiKeyConnection());
      expect((await mcpConnectionRepository.findByIdWithCredentials(key.id))?.auth.apiKey?.valueEnc).toBe('enc:key');
    });

    it('the public projection carries no ciphertext even from a credential read', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      const withCreds = await mcpConnectionRepository.findByIdWithCredentials(created.id);
      const view = toMcpConnectionPublic(withCreds!);

      expect(JSON.stringify(view)).not.toMatch(/enc:/);
      expect(view.auth.oauth).toMatchObject({ hasAccessToken: true, hasRefreshToken: true });
      expect(view).not.toHaveProperty('refreshLease');
    });
  });

  describe('queries', () => {
    it('listForUser returns only enabled, connected, user-owned connections', async () => {
      await mcpConnectionRepository.create(baseConnection({ slug: 'ok' }));
      await mcpConnectionRepository.create(baseConnection({ slug: 'off', enabled: false }));
      await mcpConnectionRepository.create(baseConnection({ slug: 'stale', status: 'needs_reconnect' }));
      await mcpConnectionRepository.create(
        baseConnection({ slug: 'orgdef', ownerType: 'org', ownerKey: 'org-1', organizationId: 'org-1' })
      );

      const hot = await mcpConnectionRepository.listForUser('user-1');
      expect(hot.map(c => c.slug)).toEqual(['ok']);
      expect((await mcpConnectionRepository.listAllForUser('user-1')).map(c => c.slug).sort()).toEqual([
        'off',
        'ok',
        'stale',
      ]);
      expect(await mcpConnectionRepository.countForUser('user-1')).toBe(3);
      expect((await mcpConnectionRepository.listForOrg('org-1')).map(c => c.slug)).toEqual(['orgdef']);
    });

    it('findByIdForOwner and deleteForOwner refuse another owner', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      const stranger = { ownerType: 'user' as const, ownerKey: 'user-2' };

      expect(await mcpConnectionRepository.findByIdForOwner(created.id, stranger)).toBeNull();
      expect(await mcpConnectionRepository.deleteForOwner(created.id, stranger)).toBe(false);
      expect(await mcpConnectionRepository.findByIdForOwner('not-an-id', stranger)).toBeNull();

      expect(await mcpConnectionRepository.deleteForOwner(created.id, { ownerType: 'user', ownerKey: 'user-1' })).toBe(
        true
      );
      expect(await McpConnection.countDocuments({})).toBe(0);
    });

    it('updateTools stores the tools, fingerprint and fetch time', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      const updated = await mcpConnectionRepository.updateTools(
        created.id,
        [
          {
            name: 'create_issue',
            description: 'Create an issue',
            descriptionRawHash: 'h1',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: false },
            enabled: false,
            approval: 'default',
            state: 'pending_review',
            firstSeenAt: new Date(),
          },
        ],
        'fp-1'
      );
      expect(updated?.toolsFingerprint).toBe('fp-1');
      expect(updated?.toolsFetchedAt).toBeInstanceOf(Date);
      expect(updated?.tools[0]).toMatchObject({ name: 'create_issue', state: 'pending_review', enabled: false });
    });

    it('setStatus records lastError and clears it on connected', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      const failed = await mcpConnectionRepository.setStatus(created.id, 'needs_reconnect', {
        code: 'auth_failed',
        message: 'invalid_grant',
      });
      expect(failed?.lastError).toMatchObject({ code: 'auth_failed', message: 'invalid_grant' });

      const healed = await mcpConnectionRepository.setStatus(created.id, 'connected');
      expect(healed?.status).toBe('connected');
      expect(healed?.lastError).toBeUndefined();
    });

    it('updateOAuthTokens keeps the stored refresh token when none is given', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      await mcpConnectionRepository.updateOAuthTokens(created.id, { accessTokenEnc: 'enc:access-2' });
      const withCreds = await mcpConnectionRepository.findByIdWithCredentials(created.id);
      expect(withCreds?.auth.oauth).toMatchObject({ accessTokenEnc: 'enc:access-2', refreshTokenEnc: 'enc:refresh' });
    });
  });

  describe('refresh lease', () => {
    it('exactly one of N concurrent acquirers wins', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => mcpConnectionRepository.acquireRefreshLease(created.id, `holder-${i}`))
      );
      const winners = results.filter(r => r !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.auth.oauth?.refreshTokenEnc).toBe('enc:refresh');
    });

    it('an expired lease can be taken over', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      await McpConnection.updateOne(
        { _id: created.id },
        { $set: { refreshLease: { holder: 'crashed', until: new Date(Date.now() - 1000) } } }
      );

      const taken = await mcpConnectionRepository.acquireRefreshLease(created.id, 'next');
      expect(taken?.refreshLease?.holder).toBe('next');
    });

    it('only the holder can release, and release frees the lease', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      await mcpConnectionRepository.acquireRefreshLease(created.id, 'a');

      expect(await mcpConnectionRepository.acquireRefreshLease(created.id, 'b')).toBeNull();
      expect(await mcpConnectionRepository.releaseRefreshLease(created.id, 'b')).toBe(false);
      expect(await mcpConnectionRepository.releaseRefreshLease(created.id, 'a')).toBe(true);
      expect(await mcpConnectionRepository.acquireRefreshLease(created.id, 'b')).not.toBeNull();
    });
  });
});
