import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../../../../../packages/database/src/__test__/createMongoServer';
import {
  AdminAuditLogModel,
  CuratedCatalogVersion,
  adminAuditLogRepository,
  curatedCatalogVersionRepository,
} from '@bike4mind/database';
import { ApiKeyScope, HTTPError } from '@bike4mind/common';
import { CURATED_CHANNEL } from '@bike4mind/server-utils/modelHub/curatedCatalog';
import { curatedDevKeyPair } from '@bike4mind/server-utils/modelHub/curatedDevKeys';
import { catalogText, signatureText, testSigner } from '@bike4mind/server-utils/modelHub/curatedTestPairs';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const stage = vi.hoisted(() => ({ value: 'test', deployed: false }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: {
    get STAGE() {
      return stage.value;
    },
  },
  isDeployedStage: () => stage.deployed,
}));

type Handler = (req: Record<string, unknown>, res: Record<string, unknown>, next: (error?: unknown) => void) => unknown;

// next-connect in miniature: the route's own middlewares (adminApi's permission guard) run for real.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const middlewares: Handler[] = [];
    let post: Handler | undefined;
    const run = async (req: Record<string, unknown>, res: Record<string, unknown>) => {
      try {
        for (const middleware of middlewares) await middleware(req, res, () => {});
        await post?.(req, res, () => {});
      } catch (error) {
        const status = error instanceof HTTPError ? error.statusCode : 500;
        (res.status as (code: number) => { json(body: unknown): void })(status).json({ error: String(error) });
      }
    };
    return Object.assign(run, {
      use: (fn: Handler) => (middlewares.push(fn), run),
      post: (fn: Handler) => ((post = fn), run),
    });
  },
}));

import handler from '../versions';

// A replica set, because the version and its audit entry commit in one transaction.
let mongo: MongoMemoryReplSet;
const dev = curatedDevKeyPair('signing');
const devSigner = { key: dev.key, privateKey: dev.privateKey };
const stranger = testSigner('signing');
const curator = { id: 'curator-1', username: 'curator', name: 'Curator', email: 'c@example.test', isAdmin: false };

beforeAll(async () => {
  mongo = await createMongoReplSet();
  await mongoose.connect(mongo.getUri());
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  stage.value = 'test';
  stage.deployed = false;
  vi.stubEnv('MODEL_HUB_CURATED_DEV_KEYS', '1');
  await CuratedCatalogVersion.collection.deleteMany({});
  await AdminAuditLogModel.collection.deleteMany({});
});

async function post(
  body: Record<string, unknown>,
  user: Record<string, unknown> = { ...curator, adminPermissions: ['models:curate'] },
  extra: Record<string, unknown> = {}
) {
  let status = 0;
  let json: Record<string, unknown> = {};
  const res = {
    status: (code: number) => ((status = code), res),
    json: (value: Record<string, unknown>) => (json = value),
  };
  const req = { method: 'POST', url: '/api/admin/model-hub/curated/versions', headers: {}, body, user, ...extra };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { status, json };
}

const pair = (sequence: number, signers = [devSigner]) => {
  const manifest = catalogText(sequence);
  return { manifest, signature: signatureText(manifest, signers), reason: 'Ship the reviewed list' };
};

describe('POST /api/admin/model-hub/curated/versions against real Mongo', () => {
  it('stores a dev-key-signed pair byte for byte and writes a critical audit entry', async () => {
    const body = pair(1);
    const { status, json } = await post(body);
    expect(status).toBe(201);
    expect(json).toMatchObject({ sequence: 1, keyIds: [dev.key.keyId] });

    const stored = await curatedCatalogVersionRepository.latest(CURATED_CHANNEL);
    expect(stored?.manifestBytes).toBe(body.manifest);
    expect(stored?.signatureBytes).toBe(body.signature);
    expect(stored).toMatchObject({ origin: 'import', publishedBy: 'curator-1', reason: body.reason });

    const entries = await AdminAuditLogModel.find({}).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'model_hub.curated.imported',
      severity: 'critical',
      target: { kind: 'curatedCatalog', id: CURATED_CHANNEL },
      reason: body.reason,
      changes: [
        { field: 'sequence', before: null, after: 1 },
        { field: 'sha256', before: null, after: json.sha256 },
        { field: 'keyIds', before: null, after: [dev.key.keyId] },
      ],
    });
  });

  it('records the live version as the audit before, and stores nothing for a byte-identical re-import', async () => {
    const first = await post(pair(1));
    const second = await post(pair(2));
    expect(second.status).toBe(201);
    const entry = await AdminAuditLogModel.findOne({ 'changes.after': 2 }).lean();
    expect(entry?.changes).toEqual([
      { field: 'sequence', before: 1, after: 2 },
      { field: 'sha256', before: first.json.sha256, after: second.json.sha256 },
      { field: 'keyIds', before: [dev.key.keyId], after: [dev.key.keyId] },
    ]);
    expect(await post(pair(2))).toEqual({ status: 200, json: { alreadyLive: true, sequence: 2 } });
    expect(await CuratedCatalogVersion.countDocuments()).toBe(2);
    expect(await AdminAuditLogModel.countDocuments()).toBe(2);
  });

  it('rolls the version back when its audit entry cannot be written', async () => {
    const append = vi.spyOn(adminAuditLogRepository, 'append').mockRejectedValueOnce(new Error('audit store down'));
    try {
      expect((await post(pair(1))).status).toBe(500);
    } finally {
      append.mockRestore();
    }
    expect(await CuratedCatalogVersion.countDocuments()).toBe(0);
    expect(await curatedCatalogVersionRepository.latest(CURATED_CHANNEL)).toBeNull();
    expect((await post(pair(1))).status).toBe(201);
  });

  it('refuses a pair whose signature does not verify against the keyring', async () => {
    const flipped = pair(1);
    flipped.manifest = flipped.manifest.replace('"schemaVersion": 2', '"schemaVersion":  2');
    expect(await post(flipped)).toMatchObject({ status: 400, json: { error: expect.stringMatching(/bad-signature/) } });
    expect(await post(pair(1, [stranger]))).toMatchObject({ status: 400, json: { error: /unknown-key/ } });
    expect(await CuratedCatalogVersion.countDocuments()).toBe(0);
    expect(await AdminAuditLogModel.countDocuments()).toBe(0);
  });

  it('trusts the test key only when enabled, off production, and on a deployed stage only for a preview', async () => {
    vi.stubEnv('MODEL_HUB_CURATED_DEV_KEYS', '');
    expect(await post(pair(1))).toMatchObject({ status: 400, json: { error: /unknown-key/ } });
    vi.stubEnv('MODEL_HUB_CURATED_DEV_KEYS', '1');
    stage.value = 'production';
    expect(await post(pair(1))).toMatchObject({ status: 400, json: { error: /unknown-key/ } });
    stage.value = 'staging';
    stage.deployed = true;
    expect(await post(pair(1))).toMatchObject({ status: 400, json: { error: /unknown-key/ } });
    expect(await CuratedCatalogVersion.countDocuments()).toBe(0);
    stage.value = 'pr6350';
    expect((await post(pair(1))).status).toBe(201);
  });

  it('answers 409 to a lower or equal sequence', async () => {
    expect((await post(pair(2))).status).toBe(201);
    const recovery = curatedDevKeyPair('recovery');
    const coSigned = pair(2, [devSigner, { key: recovery.key, privateKey: recovery.privateKey }]);
    expect(await post(coSigned)).toMatchObject({ status: 409, json: { error: /not above live sequence 2/ } });
    expect((await post(pair(1))).status).toBe(409);
    expect((await post(pair(3))).status).toBe(201);
    const sequences = (await CuratedCatalogVersion.find({}).lean()).map(v => v.sequence).sort();
    expect(sequences).toEqual([2, 3]);
  });

  it('requires a reason', async () => {
    const { reason: _reason, ...body } = pair(1);
    expect((await post(body)).status).toBe(400);
    expect((await post({ ...body, reason: 'no' })).status).toBe(400);
  });

  it('requires models:curate, and the admin scope on an API key', async () => {
    expect((await post(pair(1), { ...curator, adminPermissions: ['settings:manage'] })).status).toBe(403);
    const keyed = { apiKeyInfo: { keyId: 'k1', scopes: ['chat:read'] } };
    expect((await post(pair(1), { ...curator, isAdmin: true }, keyed)).status).toBe(403);
    const admin = { apiKeyInfo: { keyId: 'k1', scopes: [ApiKeyScope.ADMIN] } };
    expect((await post(pair(1), { ...curator, adminPermissions: ['models:curate'] }, admin)).status).toBe(201);
    expect(await CuratedCatalogVersion.countDocuments()).toBe(1);
  });
});
