import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../../packages/database/src/__test__/createMongoServer';
import { Cache as CacheModel, CuratedCatalogVersion, curatedCatalogVersionRepository } from '@bike4mind/database';
import { curatedJsonSchemaText } from '@bike4mind/common';
import {
  CURATED_CHANNEL,
  checkCuratedImport,
  importCuratedVersion,
} from '@bike4mind/server-utils/modelHub/curatedCatalog';
import { catalogText, signatureText, testSigner } from '@bike4mind/server-utils/modelHub/curatedTestPairs';
import handler from '../[file]';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { MONGODB_URI: 'unused', STAGE: 'test' },
  isDevelopment: () => false,
  isProduction: () => false,
}));
vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  connectDB: vi.fn(),
}));

type ApiRes = ServerResponse & { status(code: number): ApiRes; send(body: unknown): void; json(body: unknown): void };

let mongo: MongoMemoryServer;
let http: Server;
let base: string;
const signer = testSigner('signing');

beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri());
  await CuratedCatalogVersion.init();
  // The fixed-window limiter relies on the Cache unique index.
  await CacheModel.init();
  // Real HTTP, with the few Next API helpers the handler uses, so the test reads the bytes on the wire.
  http = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const url = new URL(incoming.url ?? '/', 'http://localhost');
    const req = Object.assign(incoming, { query: { file: decodeURIComponent(url.pathname.split('/').pop() ?? '') } });
    const res = outgoing as ApiRes;
    res.status = code => ((res.statusCode = code), res);
    res.send = body => res.end(body);
    res.json = body => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    void handler(req as never, res as never);
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/model-hub/curated/v2/`;
});
afterAll(async () => {
  await new Promise<void>(resolve => http?.close(() => resolve()));
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await CuratedCatalogVersion.collection.deleteMany({});
});

const store = async (sequence: number) => {
  const manifest = catalogText(sequence);
  const signature = signatureText(manifest, [signer]);
  // A standalone mongod has no transactions; the import route's transaction is covered in versions.e2e.test.ts.
  const result = await importCuratedVersion(
    { manifest, signature, origin: 'import', publishedBy: 'admin-1', reason: 'test import' },
    [signer.key],
    { transact: work => work() }
  );
  expect(result.ok).toBe(true);
  return { manifest, signature };
};

const bytes = async (response: Response) => Buffer.from(await response.arrayBuffer());

describe('curated list routes (public baseApi, auth off) against real Mongo', () => {
  it('404s every list file before the first publish', async () => {
    for (const name of ['latest.json', 'latest.json.sig', '1.json', '1.json.sig']) {
      const response = await fetch(`${base}${name}`);
      expect(response.status, name).toBe(404);
    }
  });

  it('serves latest and versioned pairs byte for byte with their cache headers', async () => {
    const first = await store(1);
    const second = await store(2);

    const latest = await fetch(`${base}latest.json`);
    expect(latest.status).toBe(200);
    expect(latest.headers.get('content-type')).toBe('application/json');
    expect(latest.headers.get('cache-control')).toBe('public, max-age=300');
    const latestBytes = await bytes(latest);
    expect(latestBytes.equals(Buffer.from(second.manifest, 'utf8'))).toBe(true);

    const latestSig = await fetch(`${base}latest.json.sig`);
    expect(latestSig.headers.get('cache-control')).toBe('public, max-age=300');
    const latestSigBytes = await bytes(latestSig);
    expect(latestSigBytes.equals(Buffer.from(second.signature, 'utf8'))).toBe(true);
    expect(checkCuratedImport(latestBytes.toString(), latestSigBytes.toString(), [signer.key], null).ok).toBe(true);

    const one = await fetch(`${base}1.json`);
    expect(one.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await bytes(one)).equals(Buffer.from(first.manifest, 'utf8'))).toBe(true);
    const oneSig = await fetch(`${base}1.json.sig`);
    expect(oneSig.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await bytes(oneSig)).equals(Buffer.from(first.signature, 'utf8'))).toBe(true);

    const stored = await curatedCatalogVersionRepository.latest(CURATED_CHANNEL);
    expect(stored?.manifestBytes).toBe(second.manifest);
  });

  it('404s a missing sequence and any name outside the layout', async () => {
    await store(1);
    for (const name of ['3.json', '3.json.sig', '0.json', 'latest', 'source.json', 'schema.json.sig', 'latest.txt']) {
      const response = await fetch(`${base}${name}`);
      expect(response.status, name).toBe(404);
      expect(response.headers.get('cache-control'), name).toBeNull();
    }
  });

  it('serves the published JSON Schema', async () => {
    const response = await fetch(`${base}schema.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(await response.text()).toBe(curatedJsonSchemaText());
  });

  it('answers 405 to a write', async () => {
    const response = await fetch(`${base}latest.json`, { method: 'POST' });
    expect(response.status).toBe(405);
  });

  it('rate-limits one client across every file name', async () => {
    await CacheModel.collection.deleteMany({});
    const names = ['latest.json', 'schema.json', '1.json'];
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await fetch(`${base}${names[i % names.length]}`)).status);
    expect(statuses.slice(0, 60).every(status => status !== 429)).toBe(true);
    expect(statuses[60]).toBe(429);
    await CacheModel.collection.deleteMany({});
  });
});
