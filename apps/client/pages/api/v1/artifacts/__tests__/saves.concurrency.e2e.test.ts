// @vitest-environment node
/**
 * Overlapping POST /versions and PATCH saves through the real v1 handlers, nextRouteForContract chain and
 * artifact repositories against real Mongo. Only API-key validation and rate limiting are stubbed.
 * Whatever a 2xx response reports as its version must carry that version's stored content, including
 * a save that lost the pointer race. Run `pnpm --filter @bike4mind/services-core build` first.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import mongoose from 'mongoose';
import { createMocks } from 'node-mocks-http';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';

const { mockValidate } = vi.hoisted(() => ({ mockValidate: vi.fn() }));

vi.mock('@bike4mind/server-utils/utils/apiKeyTrust', () => ({
  resolveUntrustedKeyLimits: async (_owner: unknown, key: { rateLimit: unknown }) => ({
    rateLimit: key.rateLimit,
    ownerUntrusted: false,
  }),
}));
vi.mock('@bike4mind/server-utils/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} }),
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
  logEventSafe: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => mockValidate(...a),
    },
  };
});
vi.mock('@bike4mind/database', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  connectDB: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@server/auth/auth', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  auth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { ApiKeyScope } from '@bike4mind/common';
import {
  AdminSettings,
  Artifact,
  ArtifactContent,
  ArtifactVersion,
  User,
  artifactContentRepository,
  artifactRepository,
  artifactVersionRepository,
} from '@bike4mind/database';
import { artifactService } from '@bike4mind/services';
import byId from '../[id]/index';
import versions from '../[id]/versions/index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;
let userId: string;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
beforeEach(async () => {
  await AdminSettings.create({ settingName: 'apiKeyAccess', settingValue: 'all' });
  const user = await User.create({
    username: 'saver',
    name: 'Saver',
    email: 'saver@example.com',
    aupAcceptedVersion: '2026-01-01',
  });
  userId = user.id;
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId,
    scopes: [ApiKeyScope.WRITE_NOTEBOOKS],
    rateLimit: { requestsPerMinute: 600, requestsPerDay: 100000 },
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await mongoose.connection.dropDatabase();
});

async function seedArtifact() {
  const created = await artifactService.create(
    userId,
    { type: 'code', title: 'Concurrent', content: 'seed' },
    {
      assertSourceRefsAccessible: async () => {},
      db: {
        artifacts: artifactRepository,
        artifactContents: artifactContentRepository,
        artifactVersions: artifactVersionRepository,
      },
    }
  );
  return created.artifact.id;
}

// any: the handlers' Express-typed params vs node-mocks-http mocks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fire(handler: any, method: 'POST' | 'PATCH', id: string, body: object) {
  const suffix = handler === versions ? '/versions' : '';
  const { req, res } = createMocks(
    {
      method,
      url: `/api/v1/artifacts/${id}${suffix}`,
      query: { id },
      body,
      headers: { 'x-api-key': 'sk-test-valid-key', 'content-type': 'application/json' },
    } as never,
    { eventEmitter: EventEmitter }
  );
  await handler(req, res);
  return res;
}

const saveVia = {
  'POST /versions': (id: string, content: string) => fire(versions, 'POST', id, { content }),
  'PATCH /': (id: string, content: string) => fire(byId, 'PATCH', id, { content }),
};

async function expectResponseMatchesStore(id: string, res: Awaited<ReturnType<typeof fire>>) {
  expect(res._getStatusCode()).toBeLessThan(300);
  const body = res._getJSONData();
  const row = await ArtifactContent.findOne({ artifactId: id, version: body.version }).lean();
  expect(row).not.toBeNull();
  expect(body.content).toBe(row?.content);
}

describe.each(Object.entries(saveVia))('v1 %s concurrent saves', (_label, saveFn) => {
  it('reports the content of the version it reports, for every response', async () => {
    const id = await seedArtifact();
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => saveFn(id, `body-${i}`)));
    for (const res of responses) await expectResponseMatchesStore(id, res);

    const active = await ArtifactVersion.find({ artifactId: id, isActive: true }).lean();
    expect(active).toHaveLength(1);
    const stored = await Artifact.findOne({ id }).lean();
    expect(String(stored?.currentVersionId)).toBe(String(active[0]._id));
  });

  it('a save that loses the pointer race reports the winner version and content', async () => {
    const id = await seedArtifact();
    const original = artifactRepository.updateWithWriteAccess.bind(artifactRepository);
    let winnerDone!: () => void;
    const winnerWrote = new Promise<void>(resolve => (winnerDone = resolve));
    // Holds the lower-numbered pointer write until the higher one committed.
    vi.spyOn(artifactRepository, 'updateWithWriteAccess').mockImplementation(async (user, data, extraFilter) => {
      const below = (extraFilter?.version as { $lt?: number } | undefined)?.$lt;
      if (below === 2) await winnerWrote;
      const result = await original(user, data, extraFilter);
      if (below === 3) winnerDone();
      return result;
    });

    const responses = await Promise.all([saveFn(id, 'first'), saveFn(id, 'second')]);

    const bodies = responses.map(res => res._getJSONData());
    expect(bodies.map(b => b.version)).toEqual([3, 3]);
    for (const res of responses) await expectResponseMatchesStore(id, res);
    const winner = await ArtifactContent.findOne({ artifactId: id, version: 3 }).lean();
    expect(bodies.map(b => b.content)).toEqual([winner?.content, winner?.content]);
  });
});
