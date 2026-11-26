import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { BadRequestError, NotFoundError } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { OAuthClientModel, oauthClientRepository } from './OAuthClientModel';
import { createOAuthClient, rotateOAuthClientSecret, updateOAuthClient } from './oauthClientAdmin';

const { resolveFederated, redirectSafeParse } = vi.hoisted(() => ({
  resolveFederated: vi.fn(),
  redirectSafeParse: vi.fn(),
}));

// Covers the branches for a non-Error throw and an issue-less parse failure, which the real helpers never produce.
vi.mock('@bike4mind/common', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/common')>();
  return {
    ...actual,
    resolveOAuthFederatedIdp: (...args: Parameters<typeof actual.resolveOAuthFederatedIdp>) =>
      resolveFederated.getMockImplementation() ? resolveFederated(...args) : actual.resolveOAuthFederatedIdp(...args),
    oauthRedirectUriSchema: {
      safeParse: (value: unknown) =>
        redirectSafeParse.getMockImplementation()
          ? redirectSafeParse(value)
          : actual.oauthRedirectUriSchema.safeParse(value),
    },
  };
});

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
  vi.restoreAllMocks();
  resolveFederated.mockReset();
  redirectSafeParse.mockReset();
  await OAuthClientModel.deleteMany({});
});

const base = { name: 'Edge App', redirectUris: ['https://app.example.test/cb'] };

describe('oauthClientAdmin edge cases', () => {
  it('turns a non-Error federated failure into a BadRequestError on create and update', async () => {
    resolveFederated.mockImplementation(() => {
      throw 'bad trust';
    });
    await expect(createOAuthClient({ ...base, federatedIdp: { issuer: 'https://idp.example.test' } })).rejects.toThrow(
      new BadRequestError('bad trust')
    );

    resolveFederated.mockReset();
    const { client } = await createOAuthClient(base);
    resolveFederated.mockImplementation(() => {
      throw 'bad trust';
    });
    await expect(
      updateOAuthClient(client.id, { federatedIdp: { issuer: 'https://idp.example.test' } })
    ).rejects.toThrow('bad trust');
  });

  it('falls back to a generic message for a redirect URI rejected without an issue', async () => {
    const { client } = await createOAuthClient(base);
    redirectSafeParse.mockImplementation(() => ({ success: false, error: { issues: [] } }));
    await expect(updateOAuthClient(client.id, { redirectUris: ['https://new.example.test/cb'] })).rejects.toThrow(
      'https://new.example.test/cb: invalid redirect URI'
    );
  });

  it('404s when the client disappears between the read and the rotate', async () => {
    const { client } = await createOAuthClient(base);
    vi.spyOn(OAuthClientModel, 'findByIdAndUpdate').mockReturnValueOnce({
      exec: async () => null,
    } as unknown as ReturnType<typeof OAuthClientModel.findByIdAndUpdate>);
    await expect(rotateOAuthClientSecret(client.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('OAuthClientModel repository', () => {
  it('findByClientIds includes inactive clients and toJSON drops the secret hash', async () => {
    const { client } = await createOAuthClient(base);
    await OAuthClientModel.updateOne({ _id: client.id }, { $set: { isActive: false } });
    const found = await oauthClientRepository.findByClientIds([client.clientId, 'b4m_none']);
    expect([...found.keys()]).toEqual([client.clientId]);
    const doc = await OAuthClientModel.findById(client.id).select('+clientSecretHash');
    expect(doc?.clientSecretHash).toBeTruthy();
    expect(doc?.toJSON().clientSecretHash).toBeUndefined();
  });
});
