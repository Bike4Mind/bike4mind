/**
 * Real-Mongo cover for the release-notes handler: generation and Slack are mocked, the
 * ReleaseNote upsert and its edited-row preservation run against a throwaway mongod.
 * Integration lane only (`WORKERS_TEST_LANE=integration`); consumes the built database dist.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const h = vi.hoisted(() => ({
  getSettingsByNames: vi.fn(),
  writeReleaseNotes: vi.fn(),
  fetch: vi.fn(),
  findWorkspace: vi.fn(),
}));

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));
vi.mock('@server/utils/cloudwatch', () => ({ emitModalGenerationMetrics: vi.fn() }));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: h.getSettingsByNames }));
vi.mock('./releaseNotes/generate', () => ({
  triageReleaseNotes: vi.fn(async () => ({
    notes: new Map([[1, 'note']]),
    usage: { inputTokens: 0, outputTokens: 0 },
  })),
  writeReleaseNotes: h.writeReleaseNotes,
  createReleaseNotesCompleter: vi.fn(async () => ({ complete: vi.fn(), modelId: 'gpt-4o-mini' })),
}));
vi.stubGlobal('fetch', h.fetch);

import { ReleaseNote, slackDevWorkspaceRepository } from '@bike4mind/database';
import { dispatch } from './releaseNotes';

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), updateMetadata: vi.fn() };
const payload = {
  kind: 'release-notes',
  schemaVersion: 1,
  releaseTag: 'v1.2.3.4',
  releaseUrl: 'https://example.com/releases/v1.2.3.4',
  previousTag: 'v1.2.3.3',
  deployedSha: 'abc123',
  deployedAt: '2026-01-01T00:00:00Z',
  prs: [{ number: 10, title: 'feat: faster search', labels: [], excerpt: 'desc' }],
};
const draft = (text: string) => ({
  draft: {
    headline: 'Faster search',
    summary: 'Search is quicker.',
    items: [{ category: 'improved', text, importance: 1, sourcePrs: [10] }],
  },
  usage: { inputTokens: 100, outputTokens: 50 },
});
const run = () =>
  dispatch({ Records: [{ body: JSON.stringify(payload), messageId: 'm1' }] } as never, {} as never, logger as never);
const slackPosts = () => h.fetch.mock.calls.filter(([url]) => String(url).includes('chat.postMessage'));

let server: MongoMemoryServer;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await ReleaseNote.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(() => {
  vi.clearAllMocks();
  h.getSettingsByNames.mockResolvedValue({
    releaseNotesConfig: JSON.stringify({ enabled: true, embargoHours: 12, slackTeamId: 'T1', slackChannelId: 'C1' }),
  });
  vi.spyOn(slackDevWorkspaceRepository, 'findBySlackTeamIdWithToken').mockResolvedValue({
    slackBotToken: 'xoxb-test',
  } as never);
  h.fetch.mockResolvedValue({ json: async () => ({ ok: true }) });
});
afterEach(async () => {
  await ReleaseNote.deleteMany({});
});

describe('releaseNotes handler against real Mongo', () => {
  it('stores one scheduled note per tag and overwrites it on redelivery', async () => {
    h.writeReleaseNotes.mockResolvedValueOnce(draft('Search is faster'));
    await run();
    h.writeReleaseNotes.mockResolvedValueOnce(draft('Search is much faster'));
    await run();

    const rows = await ReleaseNote.find({ releaseTag: 'v1.2.3.4' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('scheduled');
    expect(rows[0].items[0].text).toBe('Search is much faster');
    expect(rows[0].publishAt.toISOString()).toBe('2026-01-01T12:00:00.000Z');
    expect(slackPosts()).toHaveLength(2);
  });

  it('keeps a human-edited note and does not announce the regenerated one', async () => {
    h.writeReleaseNotes.mockResolvedValue(draft('Search is faster'));
    await run();
    await ReleaseNote.updateOne({ releaseTag: 'v1.2.3.4' }, { $set: { headline: 'Edited', editedAt: new Date() } });
    h.fetch.mockClear();

    await run();

    const row = await ReleaseNote.findOne({ releaseTag: 'v1.2.3.4' }).lean();
    expect(row?.headline).toBe('Edited');
    expect(slackPosts()).toHaveLength(0);
  });
});
