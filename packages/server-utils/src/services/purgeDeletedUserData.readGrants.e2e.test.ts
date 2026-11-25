import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { GitHubLakeAuthGrant, McpConnection, User } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

vi.mock('../utils/config', () => ({ Config: { GITHUB_CLIENT_ID: 'gh', GITHUB_CLIENT_SECRET: 'gh-secret' } }));

import { readUserIntegrationGrants } from './purgeDeletedUserData';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: MongoMemoryServer;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

const future = () => new Date(Date.now() + 60_000);

async function seed() {
  const tag = new mongoose.Types.ObjectId().toString();
  const user = await User.create({
    name: 'Dev',
    username: `dev-${tag}`,
    email: `dev-${tag}@example.test`,
    emailVerified: true,
    currentCredits: 0,
    authProviders: [
      { strategy: 'apple', id: 'apple-sub', refreshToken: 'enc-apple', encrypted: true },
      { strategy: 'github', id: '42', accessToken: 'enc-gh', encrypted: true },
    ],
    notionConnect: { accessToken: 'enc-notion', workspaceId: 'w', workspaceName: 'W', botId: 'b' },
    slackSettings: { slackUserId: 'U1', slackTeamId: 'T1', slackUserToken: 'enc-slack' },
  });
  const userId = user.id as string;
  const base = {
    ownerType: 'user',
    ownerKey: userId,
    userId,
    displayUrl: 'https://mcp.example.test/mcp',
    urlHost: 'mcp.example.test',
    urlEnc: 'enc:url',
    transport: 'auto',
    status: 'connected',
    tools: [],
    enabled: true,
  };
  await McpConnection.create([
    {
      ...base,
      slug: 'oauthed',
      displayName: 'OAuthed',
      auth: {
        kind: 'oauth',
        oauth: {
          clientMode: 'manual',
          authorizationServerUrl: 'https://as.example.test',
          issuer: 'https://as.example.test',
          resource: 'https://mcp.example.test/mcp',
          accessTokenEnc: 'enc-at',
          refreshTokenEnc: 'enc-rt',
        },
      },
    },
    { ...base, slug: 'open', displayName: 'Open', auth: { kind: 'none' } },
  ]);
  await GitHubLakeAuthGrant.create([
    { nonceHash: `live-${tag}`, userId, dataLakeId: 'l1', encryptedToken: 'enc-lake', expiresAt: future() },
    {
      nonceHash: `stale-${tag}`,
      userId,
      dataLakeId: 'l1',
      encryptedToken: 'enc-stale',
      expiresAt: new Date(Date.now() - 60_000),
    },
  ]);
  return userId;
}

describe('readUserIntegrationGrants', () => {
  it('captures every grant the revokes need, with the credentials a normal read hides', async () => {
    const userId = await seed();

    const grants = await readUserIntegrationGrants(userId);

    expect(grants?.notionConnect?.accessToken).toBe('enc-notion');
    expect(grants?.slackUserToken).toBe('enc-slack');
    expect(grants?.authProviders?.map(p => p.strategy)).toEqual(['apple', 'github']);
    expect(grants?.mcpConnections?.map(c => c.slug)).toEqual(['oauthed']);
    expect(grants?.mcpConnections?.[0].auth.oauth?.refreshTokenEnc).toBe('enc-rt');
    expect(grants?.githubLakeTokens).toEqual(['enc-lake']);
  });

  it('leaves the sign-in identities out when asked', async () => {
    const userId = await seed();

    const grants = await readUserIntegrationGrants(userId, { signIn: false });

    expect(grants?.authProviders).toBeNull();
    expect(grants?.slackUserToken).toBe('enc-slack');
  });

  it('returns null for a user that does not exist', async () => {
    expect(await readUserIntegrationGrants(new mongoose.Types.ObjectId().toString())).toBeNull();
  });
});
