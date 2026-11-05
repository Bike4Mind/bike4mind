import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  ConflictError,
  NotFoundError,
  BadRequestError,
  isOAuthClientIdShape,
  FEDERATED_ADMIN_STATUS_SCOPE,
} from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { OAuthClientModel, oauthClientRepository } from './OAuthClientModel';
import {
  addOAuthClientOptInScopes,
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
const federated = {
  ...base,
  federatedIdp: {
    subjectSource: 'sub' as const,
    issuer: 'https://b4m.example.test',
    jwksUri: 'https://b4m.example.test/api/oauth/jwks',
  },
};

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

  // Attribution drops any client_id failing isOAuthClientIdShape, so every minted id must pass it.
  it.each(['My App', 'x'.repeat(200), '\u00e9t\u00e9 \r\n app', '!!!'])(
    'mints an id that isOAuthClientIdShape accepts (%#)',
    name => {
      expect(isOAuthClientIdShape(generateOAuthClientId(name))).toBe(true);
    }
  );
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
    expect(client.allowedScopes).not.toContain(FEDERATED_ADMIN_STATUS_SCOPE);
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

describe('updateOAuthClient legacy redirect URIs', () => {
  const seedLegacy = async () => {
    const { client } = await createOAuthClient(base);
    await OAuthClientModel.updateOne({ _id: client.id }, { $set: { redirectUris: ['com.example.app:/oauth'] } });
    return client;
  };

  it('keeps a stored legacy URI while a new https one is added', async () => {
    const client = await seedLegacy();
    const { after } = await updateOAuthClient(client.id, {
      redirectUris: ['com.example.app:/oauth', 'https://app.example.test/cb'],
    });
    expect(after.redirectUris).toEqual(['com.example.app:/oauth', 'https://app.example.test/cb']);
  });

  it('still rejects a newly-added non-loopback http URI', async () => {
    const client = await seedLegacy();
    await expect(
      updateOAuthClient(client.id, { redirectUris: ['com.example.app:/oauth', 'http://app.example.test/cb'] })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('updateOAuthClient redirect URI edge cases', () => {
  const seedLegacy = async () => {
    const { client } = await createOAuthClient(base);
    await OAuthClientModel.updateOne({ _id: client.id }, { $set: { redirectUris: ['com.example.app:/oauth'] } });
    return client;
  };

  it('answers ConflictError (409) when the stored list changes between the read and the write', async () => {
    const { client } = await createOAuthClient(base);
    const realFindById = OAuthClientModel.findById.bind(OAuthClientModel);
    vi.spyOn(OAuthClientModel, 'findById').mockImplementationOnce(
      (id: unknown) =>
        ({
          exec: async () => {
            const doc = await realFindById(id as string).exec();
            await OAuthClientModel.updateOne({ _id: client.id }, { $set: { redirectUris: ['com.other.app:/oauth'] } });
            return doc;
          },
        }) as never
    );

    await expect(
      updateOAuthClient(client.id, { redirectUris: ['https://app.example.test/cb2'] })
    ).rejects.toMatchObject({ name: 'ConflictError', statusCode: 409 });
    vi.restoreAllMocks();
    const stored = await OAuthClientModel.findById(client.id).lean();
    expect(stored?.redirectUris).toEqual(['com.other.app:/oauth']);
  });

  it('still answers NotFoundError when the client is deleted between the read and the write', async () => {
    const { client } = await createOAuthClient(base);
    const realFindById = OAuthClientModel.findById.bind(OAuthClientModel);
    vi.spyOn(OAuthClientModel, 'findById').mockImplementationOnce(
      (id: unknown) =>
        ({
          exec: async () => {
            const doc = await realFindById(id as string).exec();
            await OAuthClientModel.deleteOne({ _id: client.id });
            return doc;
          },
        }) as never
    );
    await expect(
      updateOAuthClient(client.id, { redirectUris: ['https://app.example.test/cb2'] })
    ).rejects.toBeInstanceOf(NotFoundError);
    vi.restoreAllMocks();
  });

  it('does not guard an isActive-only update on the redirect list', async () => {
    const { client } = await createOAuthClient(base);
    const { after } = await updateOAuthClient(client.id, { isActive: false });
    expect(after.isActive).toBe(false);
  });

  it('rejects re-adding a legacy URI after it was removed in an earlier update', async () => {
    const client = await seedLegacy();
    await updateOAuthClient(client.id, { redirectUris: ['https://app.example.test/cb'] });
    await expect(
      updateOAuthClient(client.id, { redirectUris: ['https://app.example.test/cb', 'com.example.app:/oauth'] })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('treats a case variant of a stored legacy URI as new and rejects it', async () => {
    const client = await seedLegacy();
    await expect(updateOAuthClient(client.id, { redirectUris: ['COM.example.app:/oauth'] })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

const conflictOnRead = (clientId: string, write: Record<string, unknown>) => {
  const realFindById = OAuthClientModel.findById.bind(OAuthClientModel);
  vi.spyOn(OAuthClientModel, 'findById').mockImplementationOnce(
    (id: unknown) =>
      ({
        exec: async () => {
          const doc = await realFindById(id as string).exec();
          await OAuthClientModel.updateOne({ _id: clientId }, write);
          return doc;
        },
      }) as never
  );
};

describe('updateOAuthClient scopes', () => {
  it('sets allowedScopes', async () => {
    const { client } = await createOAuthClient(base);
    const { after } = await updateOAuthClient(client.id, { allowedScopes: ['openid', 'email'] });
    expect(after.allowedScopes).toEqual(['openid', 'email']);
  });

  it('keeps a stored legacy scope and rejects a newly-added unknown one', async () => {
    const { client } = await createOAuthClient(base);
    await OAuthClientModel.updateOne({ _id: client.id }, { $set: { allowedScopes: ['openid', 'legacy:x'] } });
    const { after } = await updateOAuthClient(client.id, { allowedScopes: ['openid', 'legacy:x', 'email'] });
    expect(after.allowedScopes).toEqual(['openid', 'legacy:x', 'email']);
    await expect(
      updateOAuthClient(client.id, { allowedScopes: ['openid', 'legacy:x', 'other:y'] })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects an opt-in scope on a non-federated client', async () => {
    const { client } = await createOAuthClient(base);
    await expect(
      updateOAuthClient(client.id, { allowedScopes: [...client.allowedScopes, FEDERATED_ADMIN_STATUS_SCOPE] })
    ).rejects.toBeInstanceOf(BadRequestError);
    const stored = await OAuthClientModel.findById(client.id).lean();
    expect(stored?.allowedScopes).toEqual(client.allowedScopes);
  });

  it('rejects an opt-in scope on a first-party federated client', async () => {
    const { client } = await createOAuthClient({ ...federated, clientType: 'first-party' });
    await expect(
      updateOAuthClient(client.id, { allowedScopes: [...client.allowedScopes, FEDERATED_ADMIN_STATUS_SCOPE] })
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('grants an opt-in scope to a federated relying-party client and removes it again', async () => {
    const { client } = await createOAuthClient(federated);
    const granted = await updateOAuthClient(client.id, {
      allowedScopes: [...client.allowedScopes, FEDERATED_ADMIN_STATUS_SCOPE],
    });
    expect(granted.after.allowedScopes).toContain(FEDERATED_ADMIN_STATUS_SCOPE);
    const revoked = await updateOAuthClient(client.id, { allowedScopes: client.allowedScopes });
    expect(revoked.after.allowedScopes).toEqual(client.allowedScopes);
  });

  it('answers ConflictError when stored scopes change between the read and the write', async () => {
    const { client } = await createOAuthClient(base);
    conflictOnRead(client.id, { $set: { allowedScopes: ['openid'] } });
    await expect(updateOAuthClient(client.id, { allowedScopes: ['openid', 'email'] })).rejects.toMatchObject({
      name: 'ConflictError',
      statusCode: 409,
    });
    vi.restoreAllMocks();
    const stored = await OAuthClientModel.findById(client.id).lean();
    expect(stored?.allowedScopes).toEqual(['openid']);
  });

  it('answers ConflictError when federation is removed concurrently under an opt-in grant', async () => {
    const { client } = await createOAuthClient(federated);
    await updateOAuthClient(client.id, { allowedScopes: [...client.allowedScopes, FEDERATED_ADMIN_STATUS_SCOPE] });
    conflictOnRead(client.id, { $unset: { federatedIdp: '' } });
    await expect(
      updateOAuthClient(client.id, { allowedScopes: [...client.allowedScopes, FEDERATED_ADMIN_STATUS_SCOPE] })
    ).rejects.toMatchObject({ statusCode: 409 });
    vi.restoreAllMocks();
  });
});

describe('updateOAuthClient federated trust', () => {
  it('adds a sub-shape trust config to a plain client, defaulting the audience to its client_id', async () => {
    const { client } = await createOAuthClient(base);
    const { after } = await updateOAuthClient(client.id, { federatedIdp: federated.federatedIdp });
    expect(after.federatedIdp).toEqual({
      issuer: 'https://b4m.example.test',
      audience: client.clientId,
      jwksUri: 'https://b4m.example.test/api/oauth/jwks',
      subjectSource: 'sub',
    });
  });

  it('rejects a sub config without jwksUri and leaves the client unchanged', async () => {
    const { client } = await createOAuthClient(base);
    await expect(
      updateOAuthClient(client.id, { federatedIdp: { subjectSource: 'sub', issuer: 'https://b4m.example.test' } })
    ).rejects.toBeInstanceOf(BadRequestError);
    const stored = await OAuthClientModel.findById(client.id).lean();
    expect(stored?.federatedIdp).toBeUndefined();
  });

  it('changes an identities config', async () => {
    const { client } = await createOAuthClient(base);
    await updateOAuthClient(client.id, {
      federatedIdp: { subjectSource: 'identities', issuer: 'https://a.example.test', audience: 'a', providerName: 'p' },
    });
    const { after } = await updateOAuthClient(client.id, {
      federatedIdp: { subjectSource: 'identities', issuer: 'https://b.example.test', audience: 'b', providerName: 'q' },
    });
    expect(after.federatedIdp).toMatchObject({ issuer: 'https://b.example.test', audience: 'b', providerName: 'q' });
  });

  it('answers ConflictError when the trust config changes between the read and the write', async () => {
    const { client } = await createOAuthClient(federated);
    conflictOnRead(client.id, { $set: { 'federatedIdp.jwksUri': 'https://other.example.test/jwks' } });
    await expect(
      updateOAuthClient(client.id, { federatedIdp: { ...federated.federatedIdp, issuer: 'https://new.example.test' } })
    ).rejects.toMatchObject({ name: 'ConflictError', statusCode: 409 });
    vi.restoreAllMocks();
    const stored = await OAuthClientModel.findById(client.id).lean();
    expect(stored?.federatedIdp?.jwksUri).toBe('https://other.example.test/jwks');
  });

  it('removes the trust config with null', async () => {
    const { client } = await createOAuthClient(federated);
    const { after } = await updateOAuthClient(client.id, { federatedIdp: null });
    expect(after.federatedIdp).toBeUndefined();
    const stored = await OAuthClientModel.findById(client.id).lean();
    expect(stored).not.toHaveProperty('federatedIdp');
  });

  it('rejects removing federation while an opt-in scope stays', async () => {
    const { client } = await createOAuthClient(federated);
    await updateOAuthClient(client.id, { allowedScopes: [...client.allowedScopes, FEDERATED_ADMIN_STATUS_SCOPE] });
    await expect(updateOAuthClient(client.id, { federatedIdp: null })).rejects.toMatchObject({ statusCode: 400 });
    const stored = await OAuthClientModel.findById(client.id).lean();
    expect(stored?.federatedIdp).toBeDefined();
  });

  it('allows removing federation and the opt-in scope in one update', async () => {
    const { client } = await createOAuthClient(federated);
    await updateOAuthClient(client.id, { allowedScopes: [...client.allowedScopes, FEDERATED_ADMIN_STATUS_SCOPE] });
    const { after } = await updateOAuthClient(client.id, { federatedIdp: null, allowedScopes: client.allowedScopes });
    expect(after.federatedIdp).toBeUndefined();
    expect(after.allowedScopes).toEqual(client.allowedScopes);
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

describe('addOAuthClientOptInScopes', () => {
  it('adds the scope once and is a no-op on rerun', async () => {
    const { client } = await createOAuthClient(federated);

    const first = await addOAuthClientOptInScopes(client.clientId, [FEDERATED_ADMIN_STATUS_SCOPE]);
    const second = await addOAuthClientOptInScopes(client.clientId, [FEDERATED_ADMIN_STATUS_SCOPE]);

    const expected = [...client.allowedScopes, FEDERATED_ADMIN_STATUS_SCOPE];
    expect(first.allowedScopes).toEqual(expected);
    expect(second.allowedScopes).toEqual(expected);
    const stored = await OAuthClientModel.findOne({ clientId: client.clientId }).lean();
    expect(stored?.allowedScopes).toEqual(expected);
  });

  it('rejects a scope that is not opt-in without touching the client', async () => {
    const { client } = await createOAuthClient(federated);
    await expect(addOAuthClientOptInScopes(client.clientId, ['admin:all'])).rejects.toBeInstanceOf(BadRequestError);
    const stored = await OAuthClientModel.findOne({ clientId: client.clientId }).lean();
    expect(stored?.allowedScopes).toEqual(client.allowedScopes);
  });

  it('rejects an empty list', async () => {
    const { client } = await createOAuthClient(federated);
    await expect(addOAuthClientOptInScopes(client.clientId, [])).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects a non-federated client and leaves its scopes alone', async () => {
    const { client } = await createOAuthClient(base);
    await expect(addOAuthClientOptInScopes(client.clientId, [FEDERATED_ADMIN_STATUS_SCOPE])).rejects.toBeInstanceOf(
      BadRequestError
    );
    const stored = await OAuthClientModel.findOne({ clientId: client.clientId }).lean();
    expect(stored?.allowedScopes).not.toContain(FEDERATED_ADMIN_STATUS_SCOPE);
  });

  it('rejects a first-party federated client, which the grant gate would not hold to consent', async () => {
    const { client } = await createOAuthClient({ ...federated, clientType: 'first-party' });
    await expect(addOAuthClientOptInScopes(client.clientId, [FEDERATED_ADMIN_STATUS_SCOPE])).rejects.toBeInstanceOf(
      BadRequestError
    );
    const stored = await OAuthClientModel.findOne({ clientId: client.clientId }).lean();
    expect(stored?.allowedScopes).not.toContain(FEDERATED_ADMIN_STATUS_SCOPE);
  });

  it('rejects a legacy federated client stored without a clientType', async () => {
    const { client } = await createOAuthClient(federated);
    await OAuthClientModel.collection.updateOne({ clientId: client.clientId }, { $unset: { clientType: '' } });
    await expect(addOAuthClientOptInScopes(client.clientId, [FEDERATED_ADMIN_STATUS_SCOPE])).rejects.toBeInstanceOf(
      BadRequestError
    );
    const stored = await OAuthClientModel.collection.findOne({ clientId: client.clientId });
    expect(stored?.allowedScopes).not.toContain(FEDERATED_ADMIN_STATUS_SCOPE);
  });

  it('throws NotFoundError for an unknown clientId', async () => {
    await expect(
      addOAuthClientOptInScopes('b4m_missing_00000000', [FEDERATED_ADMIN_STATUS_SCOPE])
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
