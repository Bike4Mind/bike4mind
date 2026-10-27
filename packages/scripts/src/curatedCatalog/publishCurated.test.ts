import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyCandidate, type CuratedCandidate } from './catalogChecks';
import { EXIT, main, publishCandidate, type PublishDeps } from './publishCurated';
import type { PublishStore, PutCondition } from './publishStore';
import { catalogBytes, sigBytes, testSigner } from './testCatalog';

const signing = testSigner('signing');
const recovery = testSigner('recovery');
const keyring = [signing.key, recovery.key];
const P = 'model-hub/curated-v2/';

class FakeStore implements PublishStore {
  objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  calls: string[] = [];
  puts: { key: string; cacheControl: string; condition: PutCondition }[] = [];
  failInvalidation = false;
  #etag = 0;

  seed(key: string, bytes: Uint8Array) {
    this.objects.set(key, { bytes, etag: `"e${++this.#etag}"` });
  }

  async get(key: string) {
    this.calls.push(`get ${key}`);
    return this.objects.get(key) ?? null;
  }

  async put(key: string, bytes: Uint8Array, cacheControl: string, condition: PutCondition) {
    this.calls.push(`put ${key}`);
    this.puts.push({ key, cacheControl, condition });
    const existing = this.objects.get(key);
    if (condition && 'ifNoneMatch' in condition && existing) return 'conflict' as const;
    if (condition && 'ifMatch' in condition && existing?.etag !== condition.ifMatch) return 'conflict' as const;
    this.seed(key, bytes);
    return 'ok' as const;
  }

  async invalidate(paths: string[]) {
    this.calls.push(`invalidate ${paths.join(' ')}`);
    if (this.failInvalidation) throw new Error('invalidation failed: AccessDenied');
  }
}

function signed(sequence: number): CuratedCandidate {
  const manifest = catalogBytes(sequence);
  const checked = verifyCandidate(manifest, sigBytes(manifest, [signing], sequence), keyring);
  if (!checked.ok) throw new Error(checked.error);
  return checked.value;
}

function goLive(store: FakeStore, list: CuratedCandidate) {
  const n = list.catalog.sequence;
  store.seed(`${P}${n}.json`, list.manifest);
  store.seed(`${P}${n}.json.sig`, list.sig);
  store.seed(`${P}latest.json.sig`, list.sig);
  store.seed(`${P}latest.json`, list.manifest);
  store.calls = [];
}

let store: FakeStore;
let lines: string[];
const deps = (over: Partial<PublishDeps> = {}): PublishDeps => ({
  store,
  keyring,
  log: line => lines.push(line),
  dryRun: false,
  ...over,
});

beforeEach(() => {
  store = new FakeStore();
  lines = [];
});

describe('publishCandidate', () => {
  it('writes the immutable pair, then the locked latest sig, then latest, then invalidates', async () => {
    goLive(store, signed(2));
    const liveSigEtag = store.objects.get(`${P}latest.json.sig`)?.etag;
    const liveJsonEtag = store.objects.get(`${P}latest.json`)?.etag;
    expect(await publishCandidate(signed(3), deps())).toBe(EXIT.ok);

    expect(store.calls.filter(call => !call.startsWith('get'))).toEqual([
      `put ${P}3.json`,
      `put ${P}3.json.sig`,
      `put ${P}latest.json.sig`,
      `put ${P}latest.json`,
      `invalidate /${P}latest.json /${P}latest.json.sig`,
    ]);
    expect(store.puts).toEqual([
      { key: `${P}3.json`, cacheControl: 'public, max-age=31536000, immutable', condition: { ifNoneMatch: '*' } },
      { key: `${P}3.json.sig`, cacheControl: 'public, max-age=31536000, immutable', condition: { ifNoneMatch: '*' } },
      { key: `${P}latest.json.sig`, cacheControl: 'public, max-age=300', condition: { ifMatch: liveSigEtag } },
      { key: `${P}latest.json`, cacheControl: 'public, max-age=300', condition: { ifMatch: liveJsonEtag } },
    ]);
  });

  it('locks the first publish with If-None-Match', async () => {
    expect(await publishCandidate(signed(1), deps())).toBe(EXIT.ok);
    expect(store.puts[2]).toMatchObject({ key: `${P}latest.json.sig`, condition: { ifNoneMatch: '*' } });
    expect(store.puts[3]).toMatchObject({ key: `${P}latest.json`, condition: { ifNoneMatch: '*' } });
    expect(lines).toContain('plan: first publish of sequence 1');
  });

  it('stops before latest.json when someone else published after the live read', async () => {
    goLive(store, signed(2));
    const put = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementation(async (key, bytes, cacheControl, condition) => {
      if (key === `${P}latest.json.sig`) store.seed(key, signed(3).sig);
      return put(key, bytes, cacheControl, condition);
    });
    expect(await publishCandidate(signed(3), deps())).toBe(EXIT.failed);
    expect(store.calls).not.toContain(`put ${P}latest.json`);
    expect(lines.at(-1)).toMatch(/someone else published/);
  });

  it('does not overwrite a latest.json that another publish wrote after the live read', async () => {
    goLive(store, signed(2));
    const put = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementation(async (key, bytes, cacheControl, condition) => {
      if (key === `${P}latest.json`) store.seed(key, signed(4).manifest);
      return put(key, bytes, cacheControl, condition);
    });
    expect(await publishCandidate(signed(3), deps())).toBe(EXIT.failed);
    expect(store.objects.get(`${P}latest.json`)?.bytes).toEqual(signed(4).manifest);
    expect(lines.at(-1)).toMatch(/latest\.json changed since it was read/);
  });

  it('continues past an identical immutable object from a partial run and stops on different bytes', async () => {
    goLive(store, signed(2));
    const three = signed(3);
    store.seed(`${P}3.json`, three.manifest);
    expect(await publishCandidate(three, deps())).toBe(EXIT.ok);
    expect(lines).toContain(`${P}3.json is already there with these bytes`);

    store = new FakeStore();
    goLive(store, signed(2));
    store.seed(`${P}3.json`, catalogBytes(4));
    expect(await publishCandidate(three, deps())).toBe(EXIT.failed);
    expect(store.calls).not.toContain(`put ${P}latest.json.sig`);
  });

  it('exits with the behind-live code for an older list and is a no-op for the live one', async () => {
    goLive(store, signed(3));
    expect(await publishCandidate(signed(2), deps())).toBe(EXIT.behindLive);
    expect(await publishCandidate(signed(3), deps())).toBe(EXIT.ok);
    expect(lines.at(-1)).toBe('sequence 3 is already live; nothing to do');
    expect(store.puts).toEqual([]);
  });

  it('publishes a recovery list below a live list that only a leaked key signed, and a re-run finishes it', async () => {
    const leakedBytes = catalogBytes(3, catalog => {
      catalog.sequence = 999999;
      catalog.changelog.unshift({ ...catalog.changelog[0], sequence: 999999, notes: 'Leaked.' });
    });
    const leaked = verifyCandidate(leakedBytes, sigBytes(leakedBytes, [signing], 999999), keyring);
    if (!leaked.ok) throw new Error(leaked.error);
    goLive(store, leaked.value);
    const manifest = catalogBytes(4, catalog => (catalog.revokedKeyIds = [signing.key.keyId]));
    const checked = verifyCandidate(manifest, sigBytes(manifest, [recovery], 4), keyring);
    if (!checked.ok) throw new Error(checked.error);

    const put = store.put.bind(store);
    const interrupted = vi.spyOn(store, 'put').mockImplementation(async (key, bytes, cacheControl, condition) => {
      if (key === `${P}latest.json`) throw new Error('network down');
      return put(key, bytes, cacheControl, condition);
    });
    await expect(publishCandidate(checked.value, deps())).rejects.toThrow('network down');
    expect(lines).toContain(`plan: sequence 999999 -> 4, below live: it revokes ${signing.key.keyId}`);
    interrupted.mockRestore();

    expect(await publishCandidate(checked.value, deps())).toBe(EXIT.ok);
    expect(lines).toContain('plan: finish the interrupted publish of sequence 4');
    expect(store.objects.get(`${P}latest.json`)?.bytes).toEqual(manifest);
    expect(store.objects.get(`${P}latest.json.sig`)?.bytes).toEqual(checked.value.sig);
    expect(await publishCandidate(signed(5), deps())).toBe(EXIT.failed);
    expect(lines.at(-1)).toMatch(/signed only by keys the live list revokes/);
  });

  it('reads a live pair caught mid-publish through the sig hint, and a re-run finishes it', async () => {
    goLive(store, signed(2));
    const three = signed(3);
    store.seed(`${P}3.json`, three.manifest);
    store.seed(`${P}3.json.sig`, three.sig);
    store.seed(`${P}latest.json.sig`, three.sig);
    expect(await publishCandidate(three, deps())).toBe(EXIT.ok);
    expect(lines[0]).toBe(`live is mid-publish; reading it as ${P}3.json`);
    expect(lines).toContain('plan: finish the interrupted publish of sequence 3');
    expect(store.objects.get(`${P}latest.json`)?.bytes).toEqual(three.manifest);
  });

  it('writes nothing on a dry run', async () => {
    goLive(store, signed(2));
    expect(await publishCandidate(signed(3), deps({ dryRun: true }))).toBe(EXIT.ok);
    expect(store.puts).toEqual([]);
    expect(lines).toContain('plan: sequence 2 -> 3');
  });

  it('treats a failed invalidation and a failed read-back as warnings', async () => {
    store.failInvalidation = true;
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(
      await publishCandidate(signed(1), deps({ publicUrl: 'https://catalog.example.com/x/latest.json', fetch }))
    ).toBe(EXIT.ok);
    expect(lines).toContain('warning: invalidation failed: AccessDenied; edges refresh within 5 minutes');
    expect(lines).toContain('warning: could not read the list back through the CDN');
  });
});

describe('main', () => {
  const log = (line: string) => lines.push(line);
  const readKeyring = async () => keyring;
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'curated-publish-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function files(manifest: Uint8Array, sig: Uint8Array) {
    await writeFile(path.join(dir, 'list.json'), manifest);
    await writeFile(path.join(dir, 'list.json.sig'), sig);
    return ['--manifest', 'list.json', '--sig', 'list.json.sig'];
  }

  it('verifies without touching the bucket under --verify-only', async () => {
    const manifest = catalogBytes(2);
    const createStore = vi.fn(() => store);
    const args = [...(await files(manifest, sigBytes(manifest, [signing]))), '--verify-only'];
    const code = await main(args, { INIT_CWD: dir }, { log, readKeyring, createStore });
    expect(code).toBe(EXIT.ok);
    expect(createStore).not.toHaveBeenCalled();
    expect(lines[0]).toBe(`verified sequence 2, signed by ${signing.key.keyId} (signing)`);
  });

  it('refuses a bad signature, and does not upload without an injected store', async () => {
    const manifest = catalogBytes(2);
    const forged = await files(manifest, sigBytes(catalogBytes(3), [signing]));
    expect(await main(forged, { INIT_CWD: dir }, { log, readKeyring })).toBe(EXIT.failed);
    const valid = await files(manifest, sigBytes(manifest, [signing]));
    expect(await main(valid, { INIT_CWD: dir }, { log, readKeyring })).toBe(EXIT.usage);
    expect(lines.at(-1)).toMatch(/not wired/);
  });

  it('runs the whole publish through an injected store', async () => {
    const manifest = catalogBytes(1);
    const args = await files(manifest, sigBytes(manifest, [signing], 1));
    const code = await main(args, { INIT_CWD: dir }, { log, readKeyring, createStore: () => store });
    expect(code).toBe(EXIT.ok);
    expect([...store.objects.keys()].sort()).toEqual(
      [`${P}1.json`, `${P}1.json.sig`, `${P}latest.json`, `${P}latest.json.sig`].sort()
    );
  });
});
