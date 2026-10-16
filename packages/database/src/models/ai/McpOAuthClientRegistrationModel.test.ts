import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { McpOAuthClientRegistration, mcpOAuthClientRegistrationRepository } from './McpOAuthClientRegistrationModel';

const ISSUER = 'https://auth.example.com';
const REDIRECT = 'https://app.example.com/api/mcp-connections/oauth/callback';

describe('McpOAuthClientRegistrationModel', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await McpOAuthClientRegistration.init();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  afterEach(async () => {
    await McpOAuthClientRegistration.deleteMany({});
  });

  it('is unique per (issuer, redirectUri)', async () => {
    const indexes = await McpOAuthClientRegistration.collection.indexes();
    expect(indexes.find(i => i.name === 'mcpoauthclientreg_issuer_redirect')).toMatchObject({
      key: { issuer: 1, redirectUri: 1 },
      unique: true,
    });
  });

  it('upserts in place and returns the secret on lookup', async () => {
    await mcpOAuthClientRegistrationRepository.upsert({
      issuer: ISSUER,
      redirectUri: REDIRECT,
      clientId: 'client-1',
      clientSecretEnc: 'enc:secret-1',
      tokenEndpointAuthMethod: 'client_secret_post',
    });
    const replaced = await mcpOAuthClientRegistrationRepository.upsert({
      issuer: ISSUER,
      redirectUri: REDIRECT,
      clientId: 'client-2',
      tokenEndpointAuthMethod: 'none',
    });

    expect(await McpOAuthClientRegistration.countDocuments({})).toBe(1);
    expect(replaced).toMatchObject({ clientId: 'client-2', tokenEndpointAuthMethod: 'none' });
    // A public client re-registration must not inherit the previous confidential client's secret.
    expect(replaced.clientSecretEnc).toBeUndefined();

    const found = await mcpOAuthClientRegistrationRepository.findByIssuerAndRedirect(ISSUER, REDIRECT);
    expect(found?.clientId).toBe('client-2');
    expect(await mcpOAuthClientRegistrationRepository.findByIssuerAndRedirect(ISSUER, 'https://other')).toBeNull();
  });

  it('keeps secrets out of default reads', async () => {
    const saved = await mcpOAuthClientRegistrationRepository.upsert({
      issuer: ISSUER,
      redirectUri: REDIRECT,
      clientId: 'client-1',
      clientSecretEnc: 'enc:secret',
      registrationAccessTokenEnc: 'enc:rat',
      tokenEndpointAuthMethod: 'client_secret_basic',
    });
    expect(saved.clientSecretEnc).toBe('enc:secret');

    const plain = await mcpOAuthClientRegistrationRepository.findById(saved.id);
    expect(plain).not.toHaveProperty('clientSecretEnc');
    expect(plain).not.toHaveProperty('registrationAccessTokenEnc');
  });
});
