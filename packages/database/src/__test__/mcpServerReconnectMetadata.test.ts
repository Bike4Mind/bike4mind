import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import type { IMcpServerDocument } from '@bike4mind/common';
import { connectTestDB, disconnectTestDB } from './utils';
import { McpServer, mcpServerRepository } from '../models/ai/McpServerModel';

// Pins the Mongo behaviour the same-account GitHub reconnect in
// apps/client/pages/api/auth/github/mcp-callback.ts relies on: a leaf-path $set into metadata keeps
// sibling subpaths (the webhook routing token, repo selection), and a stored `metadata: null` cannot
// take one, which is why the handler falls back to a full replace there.
describe('McpServer metadata leaf-path update (GitHub reconnect)', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await connectTestDB();
  }, 30000);

  afterAll(async () => {
    await disconnectTestDB(mongoServer);
  }, 30000);

  beforeEach(async () => {
    await McpServer.deleteMany({});
  });

  const base = {
    name: 'github',
    userId: 'user-1',
    enabled: true,
    envVariables: [{ key: 'GITHUB_ACCESS_TOKEN', value: 'old' }],
    tools: ['a'],
  };

  const reconnect = (id: string) =>
    mcpServerRepository.update(
      {
        id,
        enabled: true,
        envVariables: [{ key: 'GITHUB_ACCESS_TOKEN', value: 'new' }],
        tools: [],
        'metadata.githubLogin': 'octocat',
        'metadata.connectedAt': '2026-09-30T00:00:00.000Z',
        'metadata.scope': 'repo,read:user',
      } as Partial<IMcpServerDocument>,
      { unset: ['metadata.disconnectedAt'] }
    );

  it('keeps the webhook config and repo selection, and the routing token still resolves', async () => {
    const { insertedId } = await McpServer.collection.insertOne({
      ...base,
      metadata: {
        githubLogin: 'octocat',
        connectedAt: '2026-01-01T00:00:00.000Z',
        scope: 'repo',
        disconnectedAt: '2026-02-01T00:00:00.000Z',
        selectedRepositories: [{ fullName: 'octo/repo', owner: 'octo', repo: 'repo' }],
        webhooks: {
          github: {
            routingToken: 'routing-token-1',
            secret: 'encrypted-secret',
            subscribedEvents: ['pull_request'],
            repos: ['octo/repo'],
            createdAt: '2026-01-01T00:00:00.000Z',
            lastDeliveryAt: '2026-03-01T00:00:00.000Z',
          },
        },
      },
    });
    const id = insertedId.toString();

    await reconnect(id);

    const stored = await McpServer.collection.findOne({ _id: insertedId });
    expect(stored?.metadata).toEqual({
      githubLogin: 'octocat',
      connectedAt: '2026-09-30T00:00:00.000Z',
      scope: 'repo,read:user',
      selectedRepositories: [{ fullName: 'octo/repo', owner: 'octo', repo: 'repo' }],
      webhooks: {
        github: {
          routingToken: 'routing-token-1',
          secret: 'encrypted-secret',
          subscribedEvents: ['pull_request'],
          repos: ['octo/repo'],
          createdAt: '2026-01-01T00:00:00.000Z',
          lastDeliveryAt: '2026-03-01T00:00:00.000Z',
        },
      },
    });
    expect((await mcpServerRepository.findByGitHubWebhookToken('routing-token-1'))?.id).toBe(id);
  });

  it('creates metadata when the key is absent', async () => {
    const { insertedId } = await McpServer.collection.insertOne({ ...base });

    await reconnect(insertedId.toString());

    const stored = await McpServer.collection.findOne({ _id: insertedId });
    expect(stored?.metadata).toMatchObject({ githubLogin: 'octocat' });
  });

  it('rejects a leaf-path set into a stored metadata: null', async () => {
    const { insertedId } = await McpServer.collection.insertOne({ ...base, metadata: null });

    await expect(reconnect(insertedId.toString())).rejects.toThrow(/metadata: null/);
  });
});
