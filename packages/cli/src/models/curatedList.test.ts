import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUNDLED_CURATED_JSON_TEXT,
  curatedKeyFromSeed,
  loadCuratedManifest,
  signCurated,
  type CuratedKey,
} from '@bike4mind/local-models';
import { createCliCuratedList } from './curatedList.js';

const LATEST = 'http://127.0.0.1:4777/curated/latest.json';
const encode = (text: string) => new TextEncoder().encode(text);

// The public test seed, as Desktop's dev build trusts it.
const devSigner = curatedKeyFromSeed(createHash('sha256').update('b4m-model-hub-curated-test-key').digest());

function listText(sequence: number): string {
  const list = JSON.parse(BUNDLED_CURATED_JSON_TEXT);
  list.sequence = sequence;
  list.changelog = [{ ...list.changelog[0], sequence }];
  return `${JSON.stringify(list, null, 2)}\n`;
}

const sigText = (manifest: string, sequence: number) =>
  JSON.stringify({
    sequence,
    signatures: [{ keyId: devSigner.keyId, sig: signCurated(encode(manifest), devSigner.privateKey) }],
  });

let dir: string;
let logs: string[];
let files: Map<string, string>;
let requests: string[];
let fetchFake: typeof fetch;

const publish = (sequence: number, manifest = listText(sequence), sig = sigText(manifest, sequence)) => {
  files.set(LATEST, manifest);
  files.set(`${LATEST}.sig`, sig);
  files.set(new URL(`${sequence}.json`, LATEST).href, manifest);
  files.set(new URL(`${sequence}.json.sig`, LATEST).href, sig);
};

const list = (options: { offline?: boolean; keys?: readonly CuratedKey[]; env?: Record<string, string> } = {}) =>
  createCliCuratedList({
    offline: options.offline ?? false,
    keys: options.keys ?? [],
    env: { XDG_CONFIG_HOME: dir, B4M_CURATED_DEV_URL: LATEST, ...options.env },
    fetch: fetchFake,
    log: message => logs.push(message),
  });

beforeEach(async () => {
  vi.stubEnv('B4M_CURATED_DEV_KEYS', '');
  vi.stubEnv('B4M_CURATED_MANIFEST_URL', '');
  dir = await mkdtemp(path.join(tmpdir(), 'cli-curated-'));
  logs = [];
  files = new Map();
  requests = [];
  fetchFake = vi.fn(async (url: string | URL | Request) => {
    requests.push(String(url));
    const body = files.get(String(url));
    return body === undefined ? new Response('', { status: 404 }) : new Response(body);
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('createCliCuratedList', () => {
  it('shows the bundled list, says nothing about a source and never fetches when the build offers none', async () => {
    const curated = list();
    await curated.refresh();
    expect(await curated.manifest()).toEqual(loadCuratedManifest(() => {}));
    expect(curated.origin()).toBeNull();
    expect(requests).toEqual([]);
  });

  it('does not open the store until the list is read', async () => {
    vi.stubEnv('B4M_CURATED_DEV_KEYS', '1');
    publish(5);
    const curated = list();
    expect(existsSync(path.join(dir, 'b4m'))).toBe(false);
    await curated.manifest();
    expect(existsSync(path.join(dir, 'b4m'))).toBe(true);
  });

  describe('in a build that trusts the test keys', () => {
    beforeEach(() => vi.stubEnv('B4M_CURATED_DEV_KEYS', '1'));

    it('shows the bundled list until a check finds a newer signed one, then caches it across restarts', async () => {
      publish(5);
      const curated = list();
      const first = await curated.manifest();
      expect(first.sequence).toBe(5);
      expect(curated.origin()).toMatchObject({ text: 'Updated online, sequence 5', origin: 'updated', sequence: 5 });
      expect(requests.length).toBeGreaterThan(0);

      requests = [];
      const restarted = list();
      expect((await restarted.manifest()).sequence).toBe(5);
      expect(restarted.origin()?.text).toBe('Updated online, sequence 5');
      expect(requests).toEqual([]);
    });

    it('keeps the last good list when a byte of the next one changes, also after a restart', async () => {
      publish(5);
      await list().manifest();
      const next = listText(6);
      publish(6, `${next}\n`, sigText(next, 6));
      const curated = list();
      await curated.refresh();
      expect((await curated.manifest()).sequence).toBe(5);
      expect(curated.origin()?.text).toBe('Updated online, sequence 5 (the last update check failed)');
      expect(logs.join('\n')).toMatch(/rejected the curated list|does not match its signature/);

      const restarted = list();
      expect((await restarted.manifest()).sequence).toBe(5);
      expect(restarted.origin()?.text).toBe('Updated online, sequence 5 (the last update check failed)');
    });

    it('falls back to the bundled list when the first list ever fetched is tampered', async () => {
      const next = listText(5);
      publish(5, `${next} `, sigText(next, 5));
      const curated = list();
      await curated.refresh();
      expect((await curated.manifest()).sequence).toBe(1);
      expect(curated.origin()?.text).toBe('Bundled with this CLI (the last update check failed)');
    });

    it('ignores a list with a lower sequence than the one in use', async () => {
      publish(5);
      await list().manifest();
      publish(3);
      const curated = list();
      await curated.refresh();
      expect((await curated.manifest()).sequence).toBe(5);
    });

    it('uses the last verified list with no request when offline, from the flag or B4M_CURATED=off', async () => {
      publish(5);
      await list().manifest();
      requests = [];
      for (const curated of [list({ offline: true }), list({ env: { B4M_CURATED: 'off' } })]) {
        await curated.refresh();
        expect((await curated.manifest()).sequence).toBe(5);
        expect(curated.origin()?.text).toBe('Updated online, sequence 5 (updates are off)');
      }
      expect(requests).toEqual([]);
    });

    it('uses the bundled list when offline with nothing cached', async () => {
      const curated = list({ offline: true });
      expect((await curated.manifest()).sequence).toBe(1);
      expect(curated.origin()?.text).toBe('Bundled with this CLI (updates are off)');
      expect(requests).toEqual([]);
    });

    it('stops waiting for a stalled check after its budget and uses the list it has', async () => {
      fetchFake = ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })) as unknown as typeof fetch;
      const started = Date.now();
      const curated = list();
      expect((await curated.manifest()).sequence).toBe(1);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(curated.origin()?.check).toBe('failed');
    }, 10000);

    it('checks again on refresh even when the last check was recent', async () => {
      publish(5);
      const curated = list();
      await curated.manifest();
      publish(6);
      await curated.manifest();
      expect((await curated.manifest()).sequence).toBe(5);
      await curated.refresh();
      expect((await curated.manifest()).sequence).toBe(6);
    });

    it('keeps the test-key cache apart from the production one', async () => {
      publish(5);
      await list().manifest();
      vi.unstubAllEnvs();
      const production = createCliCuratedList({
        offline: false,
        keys: [],
        env: { XDG_CONFIG_HOME: dir },
        fetch: fetchFake,
        log: () => {},
      });
      expect((await production.manifest()).sequence).toBe(1);
      expect(production.origin()).toBeNull();
    });
  });

  it('refuses a plain-http URL in a build without the test keys', async () => {
    vi.stubEnv('B4M_CURATED_MANIFEST_URL', LATEST);
    publish(5);
    const curated = list({ keys: [{ ...devSigner, role: 'signing' }] });
    expect((await curated.manifest()).sequence).toBe(1);
    expect(curated.origin()).toBeNull();
    expect(requests).toEqual([]);
  });
});
