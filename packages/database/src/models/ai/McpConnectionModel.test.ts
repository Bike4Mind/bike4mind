import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  MCP_CONNECTION_SECRET_PATHS,
  McpConnectionProtectedFieldError,
  toMcpConnectionPublic,
  type IMcpConnectionDocument,
  type IMcpConnectionTool,
} from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { McpConnection, mcpConnectionRepository } from './McpConnectionModel';

type CreateInput = Omit<IMcpConnectionDocument, 'id' | 'createdAt' | 'updatedAt'>;

const baseConnection = (overrides: Partial<CreateInput> = {}): CreateInput => ({
  ownerType: 'user',
  ownerKey: 'user-1',
  userId: 'user-1',
  slug: 'linear',
  displayName: 'Linear',
  urlEnc: 'enc:url',
  displayUrl: 'https://mcp.linear.app/mcp',
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
    urlEnc: 'enc:url-airtable',
    displayUrl: 'https://mcp.airtable.com/mcp',
    urlHost: 'mcp.airtable.com',
    auth: {
      kind: 'api_key',
      apiKey: { headerName: 'Authorization', scheme: 'Bearer', valueEnc: 'enc:key', last4: 'abcd' },
    },
    ...overrides,
  });

/** An org-published definition: owned by the org, created by an admin, carrying no credentials. */
const orgDefinition = (overrides: Partial<CreateInput> = {}): CreateInput =>
  baseConnection({
    ownerType: 'org',
    ownerKey: 'org-1',
    organizationId: 'org-1',
    userId: 'admin-1',
    auth: {
      kind: 'oauth',
      oauth: {
        resource: 'https://mcp.linear.app/mcp',
        issuer: 'https://linear.app',
        authorizationServerUrl: 'https://linear.app',
        scopes: ['read'],
        clientMode: 'dcr',
      },
    },
    status: 'pending_auth',
    ...overrides,
  });

const tool = (name: string, overrides: Partial<IMcpConnectionTool> = {}): IMcpConnectionTool => ({
  name,
  description: `${name} tool`,
  descriptionRawHash: `h-${name}`,
  inputSchema: { type: 'object' },
  enabled: false,
  approval: 'default',
  state: 'pending_review',
  firstSeenAt: new Date(),
  ...overrides,
});

const OWNER = { ownerType: 'user' as const, ownerKey: 'user-1' };

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

    it('refuses a slug outside the grammar at the schema level', async () => {
      await expect(mcpConnectionRepository.create(baseConnection({ slug: 'bad__slug' }))).rejects.toThrow(/slug/);
      await expect(mcpConnectionRepository.create(baseConnection({ slug: 'trailing_' }))).rejects.toThrow(/slug/);
    });

    it('allows the same slug for a different owner or owner type', async () => {
      await mcpConnectionRepository.create(baseConnection());
      await mcpConnectionRepository.create(baseConnection({ ownerKey: 'user-2', userId: 'user-2' }));
      await mcpConnectionRepository.create(orgDefinition({ slug: 'linear' }));
      // An org whose id happens to equal a user's id still has its own slug namespace.
      await mcpConnectionRepository.create(
        orgDefinition({ slug: 'linear', ownerKey: 'user-1', organizationId: 'user-1' })
      );
      expect(await McpConnection.countDocuments({ slug: 'linear' })).toBe(4);
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
        await mcpConnectionRepository.updateDiscovery(created.id, {
          tools: [],
          fingerprint: 'fp',
          expectedFingerprint: null,
        }),
        await mcpConnectionRepository.rename(created.id, OWNER, 'Renamed'),
        await mcpConnectionRepository.setEnabled(created.id, OWNER, true),
        await mcpConnectionRepository.setToolSettings(created.id, OWNER, []),
      ];
      for (const doc of reads) {
        expect(doc).not.toBeNull();
        expect(secretValues(doc)).toEqual([]);
      }
    });

    it('returns every secret from the credential read', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      const withCreds = await mcpConnectionRepository.findByIdWithCredentials(created.id);
      expect(withCreds?.urlEnc).toBe('enc:url');
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
      expect(view).not.toHaveProperty('urlEnc');
      expect(view.displayUrl).toBe('https://mcp.linear.app/mcp');
      expect(view.auth.oauth).toMatchObject({ hasAccessToken: true, hasRefreshToken: true });
      expect(view).not.toHaveProperty('refreshLease');
    });
  });

  describe('owner consistency', () => {
    it.each([
      ['a user connection whose ownerKey is not its userId', baseConnection({ ownerKey: 'user-2' })],
      ['an org definition without organizationId', orgDefinition({ organizationId: undefined })],
      ['an org definition whose ownerKey is not its organizationId', orgDefinition({ ownerKey: 'org-2' })],
      [
        'an org definition carrying an access token',
        baseConnection({ ownerType: 'org', ownerKey: 'org-1', organizationId: 'org-1' }),
      ],
      [
        'an org definition carrying an API key',
        apiKeyConnection({ ownerType: 'org', ownerKey: 'org-1', organizationId: 'org-1' }),
      ],
      [
        'an org definition holding a refresh lease',
        orgDefinition({ refreshLease: { holder: 'h', until: new Date(Date.now() + 1000) } }),
      ],
    ])('refuses %s, in create and in schema validation', async (_label, input) => {
      await expect(mcpConnectionRepository.create(input)).rejects.toThrow(/ownerKey|org definition/);
      await expect(new McpConnection(input).validate()).rejects.toThrow(/ownerKey|org definition/);
    });

    it('never writes tokens or a lease onto an org definition', async () => {
      const def = await mcpConnectionRepository.create(orgDefinition());
      expect(await mcpConnectionRepository.setInitialOAuthTokens(def.id, { accessTokenEnc: 'enc:x' })).toBeNull();
      expect(await mcpConnectionRepository.acquireRefreshLease(def.id, 'h')).toBeNull();
      const raw = await McpConnection.collection.findOne({ _id: new mongoose.Types.ObjectId(def.id) });
      expect(raw?.auth?.oauth?.accessTokenEnc).toBeUndefined();
      expect(raw?.refreshLease).toBeUndefined();
    });
  });

  describe('generic writers', () => {
    it('writing back a default read cannot drop the stored secrets', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      const read = await mcpConnectionRepository.findById(created.id);

      await expect(mcpConnectionRepository.update({ ...read!, displayName: 'Edited' })).rejects.toThrow(
        McpConnectionProtectedFieldError
      );
      await expect(mcpConnectionRepository.updateGuarded({ ...read!, displayName: 'Edited' })).rejects.toThrow(
        McpConnectionProtectedFieldError
      );

      const withCreds = await mcpConnectionRepository.findByIdWithCredentials(created.id);
      expect(withCreds?.auth.oauth).toMatchObject({ accessTokenEnc: 'enc:access', refreshTokenEnc: 'enc:refresh' });
      expect(withCreds?.displayName).toBe('Linear');
    });

    it('refuses protected fields as dotted paths, in updateMany and in the unset option', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());

      await expect(
        mcpConnectionRepository.update({ id: created.id, 'auth.oauth.accessTokenEnc': 'enc:forged' })
      ).rejects.toThrow(McpConnectionProtectedFieldError);
      await expect(mcpConnectionRepository.update({ id: created.id, ownerKey: 'user-2' })).rejects.toThrow(
        McpConnectionProtectedFieldError
      );
      await expect(
        mcpConnectionRepository.update({ id: created.id, displayName: 'x' }, { unset: ['refreshLease'] })
      ).rejects.toThrow(McpConnectionProtectedFieldError);
      await expect(mcpConnectionRepository.updateMany({}, { auth: { kind: 'none' } })).rejects.toThrow(
        McpConnectionProtectedFieldError
      );
    });

    it('still writes unprotected fields', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      const updated = await mcpConnectionRepository.update({ id: created.id, displayName: 'Edited' });
      expect(updated?.displayName).toBe('Edited');
      const withCreds = await mcpConnectionRepository.findByIdWithCredentials(created.id);
      expect(withCreds?.auth.oauth?.accessTokenEnc).toBe('enc:access');
    });
  });

  describe('queries', () => {
    it('listForUser returns only enabled, connected, user-owned connections', async () => {
      await mcpConnectionRepository.create(baseConnection({ slug: 'ok' }));
      await mcpConnectionRepository.create(baseConnection({ slug: 'off', enabled: false }));
      await mcpConnectionRepository.create(baseConnection({ slug: 'stale', status: 'needs_reconnect' }));
      await mcpConnectionRepository.create(orgDefinition({ slug: 'orgdef' }));

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

    it('updateDiscovery stores the tools, fingerprint, fetch time and server details', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      const updated = await mcpConnectionRepository.updateDiscovery(created.id, {
        tools: [tool('create_issue', { annotations: { readOnlyHint: false } })],
        fingerprint: 'fp-1',
        expectedFingerprint: null,
        detectedTransport: 'streamable-http',
        serverInfo: { name: 'linear', version: '1.0.0' },
        dropped: 2,
      });
      expect(updated?.toolsFingerprint).toBe('fp-1');
      expect(updated?.toolsFetchedAt).toBeInstanceOf(Date);
      expect(updated).toMatchObject({ detectedTransport: 'streamable-http', toolsDropped: 2 });
      expect(updated?.serverInfo).toMatchObject({ name: 'linear', version: '1.0.0' });
      expect(updated?.tools[0]).toMatchObject({ name: 'create_issue', state: 'pending_review', enabled: false });
    });

    it('a discovery diffed against a stale fingerprint loses and leaves the review choices alone', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      await mcpConnectionRepository.updateDiscovery(created.id, {
        tools: [tool('a')],
        fingerprint: 'fp-1',
        expectedFingerprint: null,
      });
      await mcpConnectionRepository.setToolSettings(created.id, OWNER, [
        { name: 'a', enabled: true, state: 'active', approval: 'always_allow' },
      ]);

      // Two concurrent re-discoveries both read fp-1; the second must not overwrite the first.
      const [first, second] = await Promise.all([
        mcpConnectionRepository.updateDiscovery(created.id, {
          tools: [tool('a', { enabled: true, state: 'active', approval: 'always_allow' }), tool('b')],
          fingerprint: 'fp-2',
          expectedFingerprint: 'fp-1',
        }),
        mcpConnectionRepository.updateDiscovery(created.id, {
          tools: [tool('a')],
          fingerprint: 'fp-3',
          expectedFingerprint: 'fp-1',
        }),
      ]);
      expect([first, second].filter(r => r !== null)).toHaveLength(1);

      // A first discovery replayed after one already landed also loses.
      expect(
        await mcpConnectionRepository.updateDiscovery(created.id, {
          tools: [],
          fingerprint: 'fp-x',
          expectedFingerprint: null,
        })
      ).toBeNull();

      const stored = await mcpConnectionRepository.findById(created.id);
      expect(['fp-2', 'fp-3']).toContain(stored?.toolsFingerprint);
    });

    it('setToolSettings applies several tools in one write and ignores unknown names', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      await mcpConnectionRepository.updateDiscovery(created.id, {
        tools: [tool('a'), tool('b'), tool('c')],
        fingerprint: 'fp-1',
        expectedFingerprint: null,
      });

      const updated = await mcpConnectionRepository.setToolSettings(created.id, OWNER, [
        { name: 'a', enabled: true, state: 'active' },
        { name: 'b', approval: 'always_ask' },
        { name: 'a', approval: 'always_allow' },
        { name: 'missing', enabled: true },
      ]);
      expect(updated?.tools.map(t => [t.name, t.enabled, t.approval, t.state])).toEqual([
        ['a', true, 'always_allow', 'active'],
        ['b', false, 'always_ask', 'pending_review'],
        ['c', false, 'default', 'pending_review'],
      ]);

      await expect(
        mcpConnectionRepository.setToolSettings(created.id, OWNER, [
          { name: 'a', approval: 'whenever' as IMcpConnectionTool['approval'] },
        ])
      ).rejects.toThrow(/approval/);
      expect(
        await mcpConnectionRepository.setToolSettings(created.id, { ownerType: 'user', ownerKey: 'user-2' }, [
          { name: 'a', enabled: false },
        ])
      ).toBeNull();
    });

    it('rename and setEnabled only reach the owner', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      const stranger = { ownerType: 'user' as const, ownerKey: 'user-2' };

      expect(await mcpConnectionRepository.rename(created.id, stranger, 'Hijacked')).toBeNull();
      expect(await mcpConnectionRepository.setEnabled(created.id, stranger, false)).toBeNull();
      expect((await mcpConnectionRepository.rename(created.id, OWNER, 'Linear (work)'))?.displayName).toBe(
        'Linear (work)'
      );
      expect((await mcpConnectionRepository.setEnabled(created.id, OWNER, false))?.enabled).toBe(false);
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

    it('setInitialOAuthTokens stores tokens without returning them and refuses a non-OAuth connection', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      const stored = await mcpConnectionRepository.setInitialOAuthTokens(created.id, {
        accessTokenEnc: 'enc:access-2',
        expiresAt: new Date(Date.now() + 3600_000),
      });
      expect(secretValues(stored)).toEqual([]);
      const withCreds = await mcpConnectionRepository.findByIdWithCredentials(created.id);
      expect(withCreds?.auth.oauth).toMatchObject({ accessTokenEnc: 'enc:access-2', refreshTokenEnc: 'enc:refresh' });

      const key = await mcpConnectionRepository.create(apiKeyConnection());
      expect(await mcpConnectionRepository.setInitialOAuthTokens(key.id, { accessTokenEnc: 'enc:x' })).toBeNull();
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

    it('completeRefresh stores the tokens and frees the lease for the holder only', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      await mcpConnectionRepository.acquireRefreshLease(created.id, 'a');

      const done = await mcpConnectionRepository.completeRefresh(created.id, 'a', {
        accessTokenEnc: 'enc:access-2',
        refreshTokenEnc: 'enc:refresh-2',
      });
      expect(done).not.toBeNull();
      expect(secretValues(done)).toEqual([]);
      expect(done?.refreshLease).toBeUndefined();
      const withCreds = await mcpConnectionRepository.findByIdWithCredentials(created.id);
      expect(withCreds?.auth.oauth).toMatchObject({ accessTokenEnc: 'enc:access-2', refreshTokenEnc: 'enc:refresh-2' });
    });

    it('a stale holder cannot write after a successor took the expired lease', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      await mcpConnectionRepository.acquireRefreshLease(created.id, 'slow');
      await McpConnection.updateOne({ _id: created.id }, { $set: { 'refreshLease.until': new Date(Date.now() - 1) } });
      expect(await mcpConnectionRepository.acquireRefreshLease(created.id, 'successor')).not.toBeNull();
      await mcpConnectionRepository.completeRefresh(created.id, 'successor', {
        accessTokenEnc: 'enc:access-new',
        refreshTokenEnc: 'enc:refresh-new',
      });

      expect(
        await mcpConnectionRepository.completeRefresh(created.id, 'slow', {
          accessTokenEnc: 'enc:access-stale',
          refreshTokenEnc: 'enc:refresh-stale',
        })
      ).toBeNull();
      const withCreds = await mcpConnectionRepository.findByIdWithCredentials(created.id);
      expect(withCreds?.auth.oauth).toMatchObject({
        accessTokenEnc: 'enc:access-new',
        refreshTokenEnc: 'enc:refresh-new',
      });
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
