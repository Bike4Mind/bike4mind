import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  MCP_CONNECTION_LIMITS,
  MCP_CONNECTION_SECRET_PATHS,
  McpConnectionProtectedFieldError,
  McpConnectionSlugConflictError,
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
      await expect(mcpConnectionRepository.create(baseConnection({ displayName: 'Again' }))).rejects.toThrow(
        McpConnectionSlugConflictError
      );
    });

    it('stores the URL host lowercase and without a trailing dot', async () => {
      const created = await mcpConnectionRepository.create(baseConnection({ urlHost: ' MCP.Linear.APP. ' }));
      expect(created.urlHost).toBe('mcp.linear.app');
    });

    it('refuses a reserved slug at the schema level', async () => {
      await expect(mcpConnectionRepository.create(baseConnection({ slug: 'github' }))).rejects.toThrow();
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
      expect(view.auth.oauth).not.toHaveProperty('hasAccessToken');
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
      expect(await mcpConnectionRepository.acquireRefreshLease(def.id, 'h')).toEqual({ outcome: 'not_found' });
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

    it('refuses the URL fields, which only move together', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());

      for (const patch of [
        { urlEnc: 'enc:other-url' },
        { urlHost: 'other.example.com' },
        { displayUrl: 'https://x' },
      ]) {
        await expect(mcpConnectionRepository.update({ id: created.id, ...patch })).rejects.toThrow(
          McpConnectionProtectedFieldError
        );
      }
      expect((await mcpConnectionRepository.findById(created.id))?.urlHost).toBe('mcp.linear.app');
    });

    it('runs the schema validators, so a generic write cannot store what create refuses', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());

      for (const slug of ['bad__x', 'bad_', 'github']) {
        await expect(mcpConnectionRepository.update({ id: created.id, slug })).rejects.toThrow(
          mongoose.Error.ValidationError
        );
      }
      await expect(
        mcpConnectionRepository.update({ id: created.id, status: 'bogus' as IMcpConnectionDocument['status'] })
      ).rejects.toThrow(mongoose.Error.ValidationError);
      await expect(mcpConnectionRepository.updateMany({ _id: created.id }, { slug: 'bad__x' })).rejects.toThrow(
        mongoose.Error.ValidationError
      );
      expect((await mcpConnectionRepository.findById(created.id))?.slug).toBe('linear');
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

    it('stores the authorization-server endpoints and the step-up scope', async () => {
      const input = baseConnection();
      Object.assign(input.auth.oauth!, {
        tokenEndpoint: 'https://linear.app/oauth/token',
        revocationEndpoint: 'https://linear.app/oauth/revoke',
        registrationEndpoint: 'https://linear.app/oauth/register',
        tokenEndpointAuthMethod: 'none',
        issParameterSupported: true,
      });
      const created = await mcpConnectionRepository.create(input);
      expect((await mcpConnectionRepository.findById(created.id))?.auth.oauth).toMatchObject({
        tokenEndpoint: 'https://linear.app/oauth/token',
        revocationEndpoint: 'https://linear.app/oauth/revoke',
        registrationEndpoint: 'https://linear.app/oauth/register',
        tokenEndpointAuthMethod: 'none',
        issParameterSupported: true,
      });

      const stepUp = await mcpConnectionRepository.setStatus(created.id, 'needs_reconnect', {
        code: 'insufficient_scope',
        message: 'needs write',
        requiredScope: 'read write',
      });
      expect(stepUp?.lastError).toMatchObject({ code: 'insufficient_scope', requiredScope: 'read write' });
    });

    it('refuses to store blocked_by_policy', async () => {
      await expect(
        mcpConnectionRepository.create(
          baseConnection({ status: 'blocked_by_policy' as unknown as IMcpConnectionDocument['status'] })
        )
      ).rejects.toThrow(/status/);
    });

    it('setStatus requires a lastError for a failure status and refuses an unknown code', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      const setStatus = mcpConnectionRepository.setStatus.bind(mcpConnectionRepository) as (
        id: string,
        status: string,
        lastError?: { code: string; message: string }
      ) => Promise<unknown>;

      await expect(setStatus(created.id, 'error')).rejects.toThrow(/requires a lastError/);
      await expect(setStatus(created.id, 'needs_reconnect')).rejects.toThrow(/requires a lastError/);
      await expect(setStatus(created.id, 'error', { code: 'kaboom', message: 'x' })).rejects.toThrow(/code/);
      expect((await mcpConnectionRepository.findById(created.id))?.status).toBe('connected');
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
      expect(withCreds?.auth.oauth?.accessTokenEnc).toBe('enc:access-2');

      const key = await mcpConnectionRepository.create(apiKeyConnection());
      expect(await mcpConnectionRepository.setInitialOAuthTokens(key.id, { accessTokenEnc: 'enc:x' })).toBeNull();
    });
  });

  describe('org member connections', () => {
    const member = (userId: string, overrides: Partial<CreateInput> = {}) =>
      baseConnection({ ownerKey: userId, userId, organizationId: 'org-1', ...overrides });

    it('listMemberConnections returns members only, optionally by host, without schemas or secrets', async () => {
      const def = await mcpConnectionRepository.create(orgDefinition());
      await mcpConnectionRepository.create(member('user-1', { definitionId: def.id }));
      await mcpConnectionRepository.create(
        member('user-2', { slug: 'airtable', urlHost: 'mcp.airtable.com', displayUrl: 'https://mcp.airtable.com/mcp' })
      );
      await mcpConnectionRepository.create(baseConnection({ ownerKey: 'user-3', userId: 'user-3' }));

      const all = await mcpConnectionRepository.listMemberConnections('org-1');
      expect(all.map(c => c.userId).sort()).toEqual(['user-1', 'user-2']);
      const linear = await mcpConnectionRepository.listMemberConnections('org-1', { urlHost: 'MCP.LINEAR.APP' });
      expect(linear.map(c => c.userId)).toEqual(['user-1']);
      for (const doc of all) expect(secretValues(doc)).toEqual([]);
    });

    it('finds and cascades by definition, leaving the definition and other connections', async () => {
      const def = await mcpConnectionRepository.create(orgDefinition());
      await mcpConnectionRepository.create(member('user-1', { definitionId: def.id }));
      await mcpConnectionRepository.create(member('user-2', { definitionId: def.id }));
      await mcpConnectionRepository.create(member('user-3', { slug: 'other' }));

      expect((await mcpConnectionRepository.findByDefinitionId(def.id)).map(c => c.userId).sort()).toEqual([
        'user-1',
        'user-2',
      ]);
      expect(await mcpConnectionRepository.deleteByDefinitionId(def.id)).toBe(2);
      expect(await mcpConnectionRepository.findByDefinitionId(def.id)).toEqual([]);
      expect(await McpConnection.countDocuments({})).toBe(2);
    });

    it('deleteAllForUser removes only the user-owned connections', async () => {
      await mcpConnectionRepository.create(baseConnection({ slug: 'one' }));
      await mcpConnectionRepository.create(baseConnection({ slug: 'two' }));
      await mcpConnectionRepository.create(baseConnection({ ownerKey: 'user-2', userId: 'user-2' }));
      await mcpConnectionRepository.create(orgDefinition({ userId: 'user-1' }));

      expect(await mcpConnectionRepository.deleteAllForUser('user-1')).toBe(2);
      expect(await McpConnection.countDocuments({})).toBe(2);
      expect(await mcpConnectionRepository.listForOrg('org-1')).toHaveLength(1);
    });
  });

  describe('hot path and bounds', () => {
    it('listForUser keeps the input schemas and narrows by slug', async () => {
      const a = await mcpConnectionRepository.create(baseConnection({ slug: 'alpha' }));
      await mcpConnectionRepository.create(baseConnection({ slug: 'beta' }));
      await mcpConnectionRepository.updateDiscovery(a.id, {
        tools: [tool('t', { inputSchema: { type: 'object', properties: { q: { type: 'string' } } } })],
        fingerprint: 'fp',
        expectedFingerprint: null,
      });

      const all = await mcpConnectionRepository.listForUser('user-1');
      expect(all.map(c => c.slug).sort()).toEqual(['alpha', 'beta']);
      const narrowed = await mcpConnectionRepository.listForUser('user-1', { slugs: ['alpha'] });
      expect(narrowed.map(c => c.slug)).toEqual(['alpha']);
      expect(narrowed[0]?.tools[0]?.inputSchema).toMatchObject({ properties: { q: { type: 'string' } } });
      expect(await mcpConnectionRepository.listForUser('user-1', { slugs: [] })).toEqual([]);
    });

    it('the list and sweep reads drop tools.inputSchema and every secret', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      await mcpConnectionRepository.updateDiscovery(created.id, {
        tools: [tool('t')],
        fingerprint: 'fp',
        expectedFingerprint: null,
      });
      await mcpConnectionRepository.create(orgDefinition());

      const slim = [
        ...(await mcpConnectionRepository.listAllForUser('user-1')),
        ...(await mcpConnectionRepository.listForOrg('org-1')),
        ...(await mcpConnectionRepository.findByUrlHost('MCP.linear.app')),
      ];
      expect(slim).toHaveLength(4);
      for (const doc of slim) {
        expect(secretValues(doc)).toEqual([]);
        for (const t of doc.tools) expect(t).not.toHaveProperty('inputSchema');
      }
      expect(slim[0]?.tools[0]?.name).toBe('t');
    });

    it('refuses more than the tool cap and an oversized tool list', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      const tooMany = Array.from({ length: MCP_CONNECTION_LIMITS.maxTools + 1 }, (_, i) => tool(`t${i}`));
      await expect(
        mcpConnectionRepository.updateDiscovery(created.id, {
          tools: tooMany,
          fingerprint: 'fp',
          expectedFingerprint: null,
        })
      ).rejects.toThrow(/tools/);

      const huge = Array.from({ length: 40 }, (_, i) =>
        tool(`t${i}`, { inputSchema: { blob: 'x'.repeat(16 * 1024) } })
      );
      await expect(
        mcpConnectionRepository.updateDiscovery(created.id, {
          tools: huge,
          fingerprint: 'fp',
          expectedFingerprint: null,
        })
      ).rejects.toThrow(/tools/);
      await expect(mcpConnectionRepository.create(baseConnection({ slug: 'big', tools: tooMany }))).rejects.toThrow(
        /tools/
      );
    });

    it('enforces the string and scope bounds', async () => {
      await expect(
        mcpConnectionRepository.create(
          baseConnection({ displayName: 'x'.repeat(MCP_CONNECTION_LIMITS.displayNameLength + 1) })
        )
      ).rejects.toThrow(/displayName/);
      await expect(
        mcpConnectionRepository.create(
          baseConnection({
            slug: 'longdesc',
            tools: [tool('t', { description: 'x'.repeat(MCP_CONNECTION_LIMITS.toolDescriptionLength + 1) })],
          })
        )
      ).rejects.toThrow(/description/);
      const tooManyScopes = baseConnection({ slug: 'scopes' });
      tooManyScopes.auth.oauth!.scopes = Array.from({ length: MCP_CONNECTION_LIMITS.maxScopes + 1 }, (_, i) => `s${i}`);
      await expect(mcpConnectionRepository.create(tooManyScopes)).rejects.toThrow(/scopes/);

      const created = await mcpConnectionRepository.create(baseConnection());
      await expect(
        mcpConnectionRepository.rename(created.id, OWNER, 'x'.repeat(MCP_CONNECTION_LIMITS.displayNameLength + 1))
      ).rejects.toThrow(/displayName/);
    });

    it('truncates untrusted server strings instead of failing the write', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      const discovered = await mcpConnectionRepository.updateDiscovery(created.id, {
        tools: [],
        fingerprint: 'fp',
        expectedFingerprint: null,
        serverInfo: { name: 'n'.repeat(500), version: '1' },
      });
      expect(discovered?.serverInfo?.name).toHaveLength(MCP_CONNECTION_LIMITS.serverInfoFieldLength);

      const failed = await mcpConnectionRepository.setStatus(created.id, 'error', {
        code: 'protocol',
        message: 'm'.repeat(5000),
      });
      expect(failed?.lastError?.message).toHaveLength(MCP_CONNECTION_LIMITS.lastErrorMessageLength);
    });
  });

  describe('refresh lease', () => {
    it('exactly one of N concurrent acquirers wins', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => mcpConnectionRepository.acquireRefreshLease(created.id, `holder-${i}`))
      );
      const winners = results.flatMap(r => (r.outcome === 'acquired' ? [r.connection] : []));
      expect(winners).toHaveLength(1);
      expect(winners[0]?.auth.oauth?.refreshTokenEnc).toBe('enc:refresh');
      const losers = results.filter(r => r.outcome === 'held');
      expect(losers).toHaveLength(9);
      expect(losers[0]).toMatchObject({ holder: winners[0]?.refreshLease?.holder });
    });

    it('an expired lease can be taken over', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      await McpConnection.updateOne(
        { _id: created.id },
        { $set: { refreshLease: { holder: 'crashed', until: new Date(Date.now() - 1000) } } }
      );

      const taken = await mcpConnectionRepository.acquireRefreshLease(created.id, 'next');
      expect(taken.outcome === 'acquired' && taken.connection.refreshLease?.holder).toBe('next');
    });

    it('tells a deleted connection apart from a held lease', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      await mcpConnectionRepository.acquireRefreshLease(created.id, 'a');
      expect(await mcpConnectionRepository.acquireRefreshLease(created.id, 'b')).toMatchObject({
        outcome: 'held',
        holder: 'a',
      });
      await mcpConnectionRepository.deleteForOwner(created.id, OWNER);
      expect(await mcpConnectionRepository.acquireRefreshLease(created.id, 'b')).toEqual({ outcome: 'not_found' });
      expect(await mcpConnectionRepository.acquireRefreshLease('not-an-id', 'b')).toEqual({ outcome: 'not_found' });
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
      expect((await mcpConnectionRepository.acquireRefreshLease(created.id, 'successor')).outcome).toBe('acquired');
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

    it('a reconnect clears what the new grant did not return and voids an in-flight refresh', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      await McpConnection.updateOne(
        { _id: created.id },
        { $set: { 'auth.oauth.expiresAt': new Date(Date.now() - 1000), 'auth.oauth.grantedScope': 'read' } }
      );
      await mcpConnectionRepository.acquireRefreshLease(created.id, 'old-grant');

      await mcpConnectionRepository.setInitialOAuthTokens(created.id, { accessTokenEnc: 'enc:access-new' });

      const withCreds = await mcpConnectionRepository.findByIdWithCredentials(created.id);
      expect(withCreds?.auth.oauth?.accessTokenEnc).toBe('enc:access-new');
      expect(withCreds?.auth.oauth?.refreshTokenEnc).toBeUndefined();
      expect(withCreds?.auth.oauth?.expiresAt).toBeUndefined();
      expect(withCreds?.auth.oauth?.grantedScope).toBeUndefined();
      expect(withCreds?.refreshLease).toBeUndefined();
      expect(
        await mcpConnectionRepository.completeRefresh(created.id, 'old-grant', { accessTokenEnc: 'enc:access-stale' })
      ).toBeNull();
    });

    it('a refresh that returns no expiry clears the stored one and keeps an unrotated refresh token', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      await McpConnection.updateOne(
        { _id: created.id },
        { $set: { 'auth.oauth.expiresAt': new Date(Date.now() - 1000) } }
      );
      await mcpConnectionRepository.acquireRefreshLease(created.id, 'a');

      await mcpConnectionRepository.completeRefresh(created.id, 'a', { accessTokenEnc: 'enc:access-2' });

      const withCreds = await mcpConnectionRepository.findByIdWithCredentials(created.id);
      expect(withCreds?.auth.oauth?.expiresAt).toBeUndefined();
      expect(withCreds?.auth.oauth?.refreshTokenEnc).toBe('enc:refresh');
    });

    it('only the holder can release, and release frees the lease', async () => {
      const created = await mcpConnectionRepository.create(baseConnection());
      await mcpConnectionRepository.acquireRefreshLease(created.id, 'a');

      expect((await mcpConnectionRepository.acquireRefreshLease(created.id, 'b')).outcome).toBe('held');
      expect(await mcpConnectionRepository.releaseRefreshLease(created.id, 'b')).toBe(false);
      expect(await mcpConnectionRepository.releaseRefreshLease(created.id, 'a')).toBe(true);
      expect((await mcpConnectionRepository.acquireRefreshLease(created.id, 'b')).outcome).toBe('acquired');
    });
  });
});
