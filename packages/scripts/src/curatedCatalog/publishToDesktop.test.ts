import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Desktop's own client, so these tests pin what the script publishes to what Desktop accepts.
import { CuratedSource } from '../../../../apps/desktop/src/main/models/curated/CuratedSource';
import { CuratedStore } from '../../../../apps/desktop/src/main/models/curated/CuratedStore';
import { verifyCandidate } from './catalogChecks';
import { EXIT, publishCandidate } from './publishCurated';
import { CURATED_PREFIX, type PublishStore, type PutCondition } from './publishStore';
import { catalogBytes, sigBytes, testSigner, type TestSigner } from './testCatalog';

const ORIGIN = 'https://catalog.example.com/';
const signing = testSigner('signing');
const replacement = testSigner('signing');
const recovery = testSigner('recovery');
const keyring = [signing.key, replacement.key, recovery.key];

class MemoryStore implements PublishStore {
  objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  #etag = 0;

  async get(key: string) {
    return this.objects.get(key) ?? null;
  }

  async put(key: string, bytes: Uint8Array, _cacheControl: string, condition: PutCondition) {
    const existing = this.objects.get(key);
    if (condition && 'ifNoneMatch' in condition && existing) return 'conflict' as const;
    if (condition && 'ifMatch' in condition && existing?.etag !== condition.ifMatch) return 'conflict' as const;
    this.objects.set(key, { bytes, etag: `"e${++this.#etag}"` });
    return 'ok' as const;
  }

  async invalidate() {}

  fetch = async (url: string | URL | Request) => {
    const object = this.objects.get(String(url).slice(ORIGIN.length));
    return object ? new Response(object.bytes) : new Response('', { status: 403 });
  };
}

function list(sequence: number, signers: TestSigner[], edit: Parameters<typeof catalogBytes>[1] = () => {}) {
  const manifest = catalogBytes(sequence, edit);
  const checked = verifyCandidate(manifest, sigBytes(manifest, signers, sequence), keyring);
  if (!checked.ok) throw new Error(checked.error);
  return checked.value;
}

let dir: string;
let store: MemoryStore;
const lines: string[] = [];
const publish = (candidate: ReturnType<typeof list>) =>
  publishCandidate(candidate, { store, keyring, log: line => lines.push(line), dryRun: false });
const desktop = (profile = 'a') =>
  new CuratedSource({
    url: `${ORIGIN}${CURATED_PREFIX}latest.json`,
    keys: keyring,
    store: new CuratedStore(path.join(dir, profile)),
    bundledText: new TextDecoder().decode(catalogBytes(1)),
    allowLoopbackHttp: false,
    fetch: store.fetch,
    log: line => lines.push(line),
    onChange: () => {},
  });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'curated-e2e-'));
  store = new MemoryStore();
  lines.length = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('curated:publish to Desktop', () => {
  it('recovers clients from a leaked key that wrote a high sequence straight to the bucket', async () => {
    expect(await publish(list(3, [signing]))).toBe(EXIT.ok);
    const client = desktop();
    const missedIt = desktop('b');
    for (const each of [client, missedIt]) {
      await each.checkNow();
      expect(each.view()).toMatchObject({ origin: 'updated', sequence: 3 });
    }

    const leakedBytes = catalogBytes(3, catalog => {
      catalog.sequence = 999999;
      catalog.changelog.unshift({ ...catalog.changelog[0], sequence: 999999, notes: 'Leaked.' });
    });
    const leakedSig = sigBytes(leakedBytes, [signing], 999999);
    for (const key of ['999999.json', 'latest.json']) await store.put(`${CURATED_PREFIX}${key}`, leakedBytes, '', null);
    for (const key of ['999999.json.sig', 'latest.json.sig'])
      await store.put(`${CURATED_PREFIX}${key}`, leakedSig, '', null);
    await client.checkNow();
    expect(client.view()).toMatchObject({ sequence: 999999 });

    const recoveryList = list(4, [recovery], catalog => (catalog.revokedKeyIds = [signing.key.keyId]));
    expect(await publish(recoveryList)).toBe(EXIT.ok);
    await client.checkNow();
    expect(client.view()).toMatchObject({ origin: 'updated', sequence: 4, check: 'updated' });
    await missedIt.checkNow();
    expect(missedIt.view()).toMatchObject({ origin: 'updated', sequence: 4 });

    expect(await publish(list(5, [recovery, signing], catalog => (catalog.revokedKeyIds = [signing.key.keyId])))).toBe(
      EXIT.ok
    );
    await client.checkNow();
    expect(client.view()).toMatchObject({ sequence: 5 });
  });

  it('recovers from a leaked key that wrote live+1 with a future date and revoked the replacement key', async () => {
    expect(await publish(list(3, [signing]))).toBe(EXIT.ok);
    const client = desktop();
    const missedIt = desktop('b');
    for (const each of [client, missedIt]) await each.checkNow();

    const leaked = list(4, [signing], catalog => {
      catalog.updatedAt = '2099-01-01T00:00:00Z';
      catalog.revokedKeyIds = [replacement.key.keyId];
    });
    for (const key of ['4.json', 'latest.json']) await store.put(`${CURATED_PREFIX}${key}`, leaked.manifest, '', null);
    for (const key of ['4.json.sig', 'latest.json.sig'])
      await store.put(`${CURATED_PREFIX}${key}`, leaked.sig, '', null);
    await client.checkNow();
    expect(client.view()).toMatchObject({ sequence: 4 });
    expect((await new CuratedStore(path.join(dir, 'a')).readRevoked()).ids).toEqual(new Set());

    const revokeLeaked: Parameters<typeof catalogBytes>[1] = catalog => {
      catalog.revokedKeyIds = [signing.key.keyId];
    };
    expect(await publish(list(5, [recovery, replacement], revokeLeaked))).toBe(EXIT.ok);
    expect(lines).toContain(`plan: sequence 4 -> 5, it revokes ${signing.key.keyId}`);
    for (const each of [client, missedIt]) {
      await each.checkNow();
      expect(each.view()).toMatchObject({ origin: 'updated', sequence: 5, check: 'updated' });
    }
    expect((await new CuratedStore(path.join(dir, 'a')).readRevoked()).ids).toEqual(new Set([signing.key.keyId]));

    expect(await publish(list(6, [recovery, replacement], revokeLeaked))).toBe(EXIT.ok);
    await client.checkNow();
    expect(client.view()).toMatchObject({ sequence: 6 });
    expect(await publish(list(7, [signing]))).toBe(EXIT.failed);
    expect(lines.at(-1)).toMatch(/signed only by keys the live list revokes/);
  });
});
