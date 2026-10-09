import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { ConflictError, NotFoundError, BadRequestError } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { OAuthClientModel, oauthClientRepository } from './OAuthClientModel';
import {
  createOAuthClient,
  generateOAuthClientId,
  listOAuthClients,
  toOAuthClientView,
  rotateOAuthClientSecret,
  updateOAuthClient,
} from './oauthClientAdmin';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 60000);

afterEach(async () => {
  await OAuthClientModel.deleteMany({});
});

const base = { name: 'My App', redirectUris: ['https://app.example.test/callback'] };

describe('generateOAuthClientId', () => {
  it('keeps the b4m_<name>_<8 hex> shape and strips characters unsafe in a URL', () => {
    expect(generateOAuthClientId('My App')).toMatch(/^b4m_my_app_[0-9a-f]{8}$/);
    expect(generateOAuthClientId('  Wild/Name?! ')).toMatch(/^b4m_wild_name_[0-9a-f]{8}$/);
    expect(generateOAuthClientId('!!!')).toMatch(/^b4m_client_[0-9a-f]{8}$/);
  });

  it('does not leave a trailing underscore when the 40-char cut lands on a separator', () => {
    const name = `${'a'.repeat(39)} tail`;
    const id = generateOAuthClientId(name);
    expect(id).toMatch(new RegExp(`^b4m_a{39}_[0-9a-f]{8}$`));
    expect(id).not.toContain('__');
  });
});

describe('createOAuthClient', () => {
  it('stores only a bcrypt hash that verifies against the returned secret', async () => {
    const { client, clientSecret } = await createOAuthClient(base);

    expect(clientSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(client).not.toHaveProperty('clientSecretHash');
    expect(JSON.stringify(client)).not.toContain(clientSecret);

    const stored = await OAuthClientModel.findById(client.id).lean();
    expect(stored?.clientSecretHash).toMatch(/^\$2[aby]\$10\$/);
    expect(stored?.clientSecretHash).not.toBe(clientSecret);
    expect(await oauthClientRepository.verifyClientSecret(client.clientId, clientSecret)).not.toBeNull();
  });

  it('defaults to a confidential relying-party client with identity scopes', async () => {
    const { client } = await createOAuthClient(base);
    expect(client).toMatchObject({
      name: 'My App',
      clientType: 'relying-party',
      tokenEndpointAuthMethod: 'client_secret_post',
      allowedScopes: ['openid', 'email', 'profile'],
      isActive: true,
    });
    expect(client.federatedIdp).toBeUndefined();
  });

  it('honors an explicit first-party opt-in', async () => {
    const { client } = await createOAuthClient({ ...base, clientType: 'first-party' });
    expect(client.clientType).toBe('first-party');
  });

  it('rejects a duplicate name with a ConflictError', async () => {
    await createOAuthClient(base);
    await expect(createOAuthClient({ ...base, name: '  My App ' })).rejects.toBeInstanceOf(ConflictError);
    expect(await OAuthClientModel.countDocuments()).toBe(1);
  });

  it.each([
    ['a relative URI', '/callback'],
    ['a non-http scheme', 'javascript:alert(1)'],
    ['a fragment', 'https://app.example.test/cb#frag'],
    ['garbage', 'not a url'],
    ['a non-loopback http URI', 'http://app.example.test/cb'],
    ['embedded credentials', 'https://user:pass@app.example.test/cb'],
  ])('rejects %s as a redirect URI', async (_label, uri) => {
    await expect(createOAuthClient({ ...base, redirectUris: [uri] })).rejects.toThrow();
    expect(await OAuthClientModel.countDocuments()).toBe(0);
  });

  it('rejects an empty name and an empty redirect list', async () => {
    await expect(createOAuthClient({ ...base, name: '   ' })).rejects.toThrow(/Name is required/);
    await expect(createOAuthClient({ ...base, redirectUris: [] })).rejects.toThrow(/At least one redirect URI/);
  });

  it('registers a sub-shape federated client, defaulting the audience to its client_id', async () => {
    const { client } = await createOAuthClient({
      ...base,
      federatedIdp: {
        subjectSource: 'sub',
        issuer: 'https://b4m.example.test',
        jwksUri: 'https://b4m.example.test/api/oauth/jwks',
      },
    });
    expect(client.federatedIdp).toEqual({
      subjectSource: 'sub',
      issuer: 'https://b4m.example.test',
      jwksUri: 'https://b4m.example.test/api/oauth/jwks',
      audience: client.clientId,
    });
    expect(client.allowedScopes).toEqual(['openid', 'email', 'profile', 'ai:generate', 'me:read']);
  });

  it('applies the same federated shape rules as the seed script', async () => {
    await expect(
      createOAuthClient({ ...base, federatedIdp: { subjectSource: 'sub', issuer: 'https://b4m.example.test' } })
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      createOAuthClient({ ...base, federatedIdp: { issuer: 'https://idp.example.test', audience: 'aud' } })
    ).rejects.toThrow(/issuer, audience, and provider name together/);
    expect(await OAuthClientModel.countDocuments()).toBe(0);
  });
});

describe('rotateOAuthClientSecret', () => {
  it('invalidates the old secret immediately and returns a working new one', async () => {
    const { client, clientSecret: oldSecret } = await createOAuthClient(base);
    const rotated = await rotateOAuthClientSecret(client.id);

    expect(rotated.clientSecret).not.toBe(oldSecret);
    expect(rotated.client).not.toHaveProperty('clientSecretHash');
    expect(await oauthClientRepository.verifyClientSecret(client.clientId, oldSecret)).toBeNull();
    expect(await oauthClientRepository.verifyClientSecret(client.clientId, rotated.clientSecret)).not.toBeNull();
  });

  it('refuses a public client and a missing id', async () => {
    const pub = await OAuthClientModel.create({
      clientId: 'b4m_public',
      clientSecretHash: 'unused',
      name: 'Public',
      redirectUris: ['https://p.example.test/cb'],
      tokenEndpointAuthMethod: 'none',
    });
    await expect(rotateOAuthClientSecret(pub.id)).rejects.toBeInstanceOf(BadRequestError);
    await expect(rotateOAuthClientSecret(new mongoose.Types.ObjectId().toString())).rejects.toBeInstanceOf(
      NotFoundError
    );
  });
});

describe('invalid ids', () => {
  it('answer NotFoundError without querying', async () => {
    const findById = vi.spyOn(OAuthClientModel, 'findById');
    const findByIdAndUpdate = vi.spyOn(OAuthClientModel, 'findByIdAndUpdate');
    await expect(rotateOAuthClientSecret('not-an-id')).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateOAuthClient('not-an-id', { isActive: false })).rejects.toBeInstanceOf(NotFoundError);
    expect(findById).not.toHaveBeenCalled();
    expect(findByIdAndUpdate).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('toOAuthClientView', () => {
  it('returns null timestamps for a document that predates them', () => {
    const view = toOAuthClientView({
      id: 'abc',
      clientId: 'b4m_legacy',
      name: 'Legacy',
      clientType: 'first-party',
      tokenEndpointAuthMethod: 'client_secret_post',
      redirectUris: ['https://l.example.test/cb'],
      allowedScopes: ['openid'],
      isActive: true,
    } as never);
    expect(view.createdAt).toBeNull();
    expect(view.updatedAt).toBeNull();
  });
});

describe('updateOAuthClient', () => {
  it('replaces redirect URIs and reports the before/after state', async () => {
    const { client } = await createOAuthClient(base);
    const { before, after } = await updateOAuthClient(client.id, {
      redirectUris: ['https://app.example.test/cb2', 'http://localhost:9999/callback'],
    });
    expect(before.redirectUris).toEqual(base.redirectUris);
    expect(after.redirectUris).toEqual(['https://app.example.test/cb2', 'http://localhost:9999/callback']);
  });

  it('deactivates without deleting, and a deactivated client stops verifying', async () => {
    const { client, clientSecret } = await createOAuthClient(base);
    const { after } = await updateOAuthClient(client.id, { isActive: false });

    expect(after.isActive).toBe(false);
    expect(await OAuthClientModel.countDocuments()).toBe(1);
    expect(await oauthClientRepository.verifyClientSecret(client.clientId, clientSecret)).toBeNull();
    expect(await oauthClientRepository.findByClientId(client.clientId)).toBeNull();

    await updateOAuthClient(client.id, { isActive: true });
    expect(await oauthClientRepository.verifyClientSecret(client.clientId, clientSecret)).not.toBeNull();
  });

  it('rejects an empty update, unknown fields and invalid URIs', async () => {
    const { client } = await createOAuthClient(base);
    await expect(updateOAuthClient(client.id, {})).rejects.toThrow(/Nothing to update/);
    await expect(updateOAuthClient(client.id, { name: 'x' } as never)).rejects.toThrow();
    await expect(updateOAuthClient(client.id, { redirectUris: ['ftp://x.example.test'] })).rejects.toThrow();
  });
});

describe('listOAuthClients', () => {
  it('returns every client, newest first, without any secret material', async () => {
    const first = await createOAuthClient({ ...base, name: 'First' });
    const second = await createOAuthClient({ ...base, name: 'Second' });
    await updateOAuthClient(first.client.id, { isActive: false });

    const list = await listOAuthClients();
    expect(list.map(c => c.name)).toEqual(['Second', 'First']);
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain('clientSecretHash');
    expect(serialized).not.toContain(first.clientSecret);
    expect(serialized).not.toContain(second.clientSecret);
  });
});
