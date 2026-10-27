import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HUB_MAX_SEQUENCE } from '@bike4mind/common';
import {
  CURATED_MAX_SEQUENCE,
  curatedPublicKey,
  signCurated,
  type CuratedKey,
  type CuratedKeyRole,
} from '@bike4mind/local-models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_CURATED_TEXT } from './bundled';
import { CURATED_BACKOFF_BASE_MS, CURATED_CHECK_INTERVAL_MS, CuratedSource } from './CuratedSource';
import { CuratedStore } from './CuratedStore';

const URL_BASE = 'https://catalog.example.com/model-hub/curated-v2/';
const LATEST = `${URL_BASE}latest.json`;
const NOTE = 'Served by the test server.';

interface Signer {
  key: CuratedKey;
  privateKey: KeyObject;
}

function signer(role: CuratedKeyRole): Signer {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { key: { ...curatedPublicKey(privateKey), role }, privateKey };
}

const encode = (text: string) => new TextEncoder().encode(text);

/** The bundled list re-published at `sequence`, with the first entry's why changed so the swap is visible. */
function listText(sequence: number, edit: (list: Record<string, unknown>) => void = () => {}): string {
  const list = JSON.parse(BUNDLED_CURATED_TEXT) as Record<string, unknown> & {
    entries: { why: string }[];
    changelog: { sequence: number }[];
  };
  list.sequence = sequence;
  list.changelog = [{ ...list.changelog[0], sequence }];
  list.entries[0].why = `${NOTE} List ${sequence}.`;
  edit(list);
  return `${JSON.stringify(list, null, 2)}\n`;
}

function sigText(manifest: string, signers: Signer[], sequence?: number): string {
  const signatures = signers.map(s => ({ keyId: s.key.keyId, sig: signCurated(encode(manifest), s.privateKey) }));
  return JSON.stringify({ ...(sequence === undefined ? {} : { sequence }), signatures });
}

class Server {
  files = new Map<string, string | (() => Response)>();
  requests: string[] = [];

  publish(sequence: number, manifest: string, sig: string): void {
    this.files.set(LATEST, manifest);
    this.files.set(`${LATEST}.sig`, sig);
    this.files.set(`${URL_BASE}${sequence}.json`, manifest);
    this.files.set(`${URL_BASE}${sequence}.json.sig`, sig);
  }

  fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    this.requests.push(String(url));
    const file = this.files.get(String(url));
    if (typeof file === 'function') return file();
    return file === undefined ? new Response('', { status: 403 }) : new Response(file);
  });
}

let dir: string;
let server: Server;
let clock: number;
let logs: string[];
const signing = signer('signing');
const recovery = signer('recovery');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'curated-source-'));
  server = new Server();
  clock = Date.parse('2026-10-28T12:00:00Z');
  logs = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function source(
  options: { keys?: CuratedKey[]; url?: string | null; bundledText?: string; store?: CuratedStore } = {}
) {
  const onChange = vi.fn();
  const created = new CuratedSource({
    url: options.url === undefined ? LATEST : options.url,
    keys: options.keys ?? [signing.key, recovery.key],
    store: options.store ?? new CuratedStore(dir),
    bundledText: options.bundledText ?? BUNDLED_CURATED_TEXT,
    allowLoopbackHttp: false,
    fetch: server.fetch,
    timeoutMs: 200,
    now: () => clock,
    log: message => logs.push(message),
    onChange,
  });
  return Object.assign(created, { onChange });
}

const why = (s: CuratedSource) => s.current().entries[0].why;
const logged = (pattern: RegExp) =>
  expect(
    logs.some(line => pattern.test(line)),
    logs.join('\n')
  ).toBe(true);

describe('CuratedSource', () => {
  it('stays on the bundled list and never fetches without a URL or a trusted key', async () => {
    for (const s of [source({ url: null }), source({ keys: [] })]) {
      await s.checkNow();
      await s.checkIfDue();
      expect(s.available).toBe(false);
      expect(s.view()).toMatchObject({ origin: 'bundled', sequence: 1, check: 'off' });
    }
    expect(server.requests).toEqual([]);
  });

  it('accepts a newer signed list, caches it, and shows it again after a restart without fetching', async () => {
    const manifest = listText(3);
    server.publish(3, manifest, sigText(manifest, [signing], 3));
    const s = source();
    await s.checkIfDue();

    expect(why(s)).toBe(`${NOTE} List 3.`);
    expect(s.view()).toMatchObject({ origin: 'updated', sequence: 3, check: 'updated' });
    expect(server.requests).toEqual([`${LATEST}.sig`, LATEST]);
    expect(s.onChange).toHaveBeenCalledTimes(2);
    logged(/accepted curated list 3/);

    server.requests = [];
    const restarted = source();
    await restarted.loaded();
    expect(why(restarted)).toBe(`${NOTE} List 3.`);
    expect(server.requests).toEqual([]);
  });

  it('skips the manifest when the signature file is unchanged', async () => {
    const manifest = listText(3);
    server.publish(3, manifest, sigText(manifest, [signing], 3));
    const s = source();
    await s.checkNow();
    server.requests = [];
    await s.checkNow();
    expect(server.requests).toEqual([`${LATEST}.sig`]);
    expect(s.view().check).toBe('up-to-date');
  });

  it.each([
    ['a tampered list', (m: string) => m.replace(NOTE, 'Tampered.'), [signing]],
    ['an unknown key', (m: string) => m, [signer('signing')]],
  ])('rejects %s, here and at the immutable pair, and keeps the current list', async (_label, tamper, by) => {
    const manifest = listText(4);
    const sig = sigText(manifest, by, 4);
    server.publish(4, tamper(manifest), sig);
    const s = source();
    await s.checkNow();

    expect(s.view()).toMatchObject({ origin: 'bundled', sequence: 1, check: 'failed' });
    expect(server.requests).toEqual([`${LATEST}.sig`, LATEST, `${URL_BASE}4.json.sig`, `${URL_BASE}4.json`]);
    logged(/rejected the curated list: (bad-signature|unknown-key)/);
  });

  it('counts a mismatched pair with no newer hint as a failed check, so it backs off and never sets checkedAt', async () => {
    const manifest = listText(3);
    server.publish(3, manifest.replace(NOTE, 'Tampered.'), sigText(manifest, [signing]));
    const s = source();
    await s.checkNow();
    expect(s.view()).toMatchObject({ origin: 'bundled', check: 'failed', checkedAt: null });
    expect(server.requests).toHaveLength(2);
    clock += CURATED_BACKOFF_BASE_MS - 1;
    await s.checkIfDue();
    expect(server.requests).toHaveLength(2);
  });

  it('follows the hint of a new .sig beside the old list to the immutable pair, mid-publish', async () => {
    const two = listText(2);
    server.publish(2, two, sigText(two, [signing], 2));
    const s = source();
    await s.checkNow();
    const three = listText(3);
    const threeSig = sigText(three, [signing], 3);
    server.files.set(`${URL_BASE}3.json`, three);
    server.files.set(`${URL_BASE}3.json.sig`, threeSig);
    server.files.set(`${LATEST}.sig`, threeSig);
    server.requests = [];
    await s.checkNow();

    expect(server.requests).toEqual([`${LATEST}.sig`, LATEST, `${URL_BASE}3.json.sig`, `${URL_BASE}3.json`]);
    expect(s.view()).toMatchObject({ origin: 'updated', sequence: 3, check: 'updated' });
  });

  it('reports up to date for the old .sig beside the new list, and failed when the hinted pair is missing', async () => {
    const two = listText(2);
    server.publish(2, two, sigText(two, [signing], 2));
    const s = source();
    await s.checkNow();
    server.files.set(LATEST, listText(3));
    await s.checkNow();
    expect(s.view()).toMatchObject({ sequence: 2, check: 'up-to-date' });

    const five = listText(5);
    server.files.set(`${LATEST}.sig`, sigText(five, [signing], 5));
    await s.checkNow();
    expect(s.view()).toMatchObject({ sequence: 2, check: 'failed' });
    logged(/HTTP 403 for \/model-hub\/curated-v2\/5\.json/);
  });

  it('keeps a newer list over an older one, and keeps it over a different list with the same sequence', async () => {
    const three = listText(3);
    server.publish(3, three, sigText(three, [signing], 3));
    const s = source();
    await s.checkNow();

    const two = listText(2);
    server.publish(2, two, sigText(two, [signing], 2));
    await s.checkNow();
    expect(s.view()).toMatchObject({ sequence: 3, check: 'up-to-date' });
    logged(/curated list 2 is older than the current list 3; kept it/);

    const other = listText(3, list => (list.updatedAt = '2026-10-29T00:00:00Z'));
    server.publish(3, other, sigText(other, [signing], 3));
    clock += 1000;
    await s.checkNow();
    expect(why(s)).toBe(`${NOTE} List 3.`);
    expect(s.view()).toMatchObject({ sequence: 3, check: 'up-to-date', checkedAt: new Date(clock).toISOString() });
    logged(/warning: curated list 3 differs from the current list with that sequence; kept it/);
    const state = JSON.parse(await readFile(join(dir, CuratedStore.sourceKey(LATEST), 'state.json'), 'utf8'));
    expect(state).toMatchObject({ failures: 0, lastSuccessAt: clock });
  });

  it('compares against the bundled list too: identical or different, the bundled list stays', async () => {
    server.publish(1, BUNDLED_CURATED_TEXT, sigText(BUNDLED_CURATED_TEXT, [signing], 1));
    const s = source();
    await s.checkNow();
    expect(s.view()).toMatchObject({ origin: 'bundled', check: 'up-to-date' });

    const different = listText(1);
    server.publish(1, different, sigText(different, [signing], 1));
    await s.checkNow();
    expect(s.view()).toMatchObject({ origin: 'bundled', check: 'up-to-date' });
  });

  it('rejects a list above the highest sequence', async () => {
    expect(CURATED_MAX_SEQUENCE).toBe(HUB_MAX_SEQUENCE);
    const huge = listText(HUB_MAX_SEQUENCE + 1);
    server.publish(HUB_MAX_SEQUENCE + 1, huge, sigText(huge, [signing], HUB_MAX_SEQUENCE));
    const s = source();
    await s.checkNow();
    expect(s.view()).toMatchObject({ origin: 'bundled', check: 'failed' });
    logged(/rejected the curated list: invalid list/);
  });

  it('refuses a rollback below the floor after the cached list is lost, and accepts the floor list again', async () => {
    const three = listText(3);
    server.publish(3, three, sigText(three, [signing], 3));
    await source().checkNow();
    await rm(join(dir, CuratedStore.sourceKey(LATEST), 'pair.json'));

    const restarted = source();
    await restarted.loaded();
    expect(restarted.view()).toMatchObject({ origin: 'bundled', sequence: 1 });
    const two = listText(2);
    server.publish(2, two, sigText(two, [signing], 2));
    await restarted.checkNow();
    expect(restarted.view()).toMatchObject({ origin: 'bundled', sequence: 1, check: 'up-to-date' });
    logged(/curated list 2 is older than list 3, accepted before; kept the current list/);

    server.publish(3, three, sigText(three, [signing], 3));
    await restarted.checkNow();
    expect(restarted.view()).toMatchObject({ origin: 'updated', sequence: 3, check: 'updated' });
  });

  it('saves the floor before the copy, so a crash between the two cannot lose it', async () => {
    class OrderStore extends CuratedStore {
      floorsAtCopy: Record<string, number> | null = null;
      override async writeCopy(...args: Parameters<CuratedStore['writeCopy']>) {
        this.floorsAtCopy = (await this.readState(args[0])).floors;
        return super.writeCopy(...args);
      }
    }
    const store = new OrderStore(dir);
    const three = listText(3);
    server.publish(3, three, sigText(three, [signing], 3));
    const s = source({ store });
    await s.checkNow();
    expect(s.view()).toMatchObject({ origin: 'updated', sequence: 3 });
    expect(store.floorsAtCopy).toEqual({ [signing.key.keyId]: 3 });
  });

  it('checks at once, without a stale checked time, when the list accepted before is missing at startup', async () => {
    const three = listText(3);
    server.publish(3, three, sigText(three, [signing], 3));
    await source().checkNow();
    await rm(join(dir, CuratedStore.sourceKey(LATEST), 'pair.json'));
    clock += CURATED_CHECK_INTERVAL_MS / 2;

    const restarted = source();
    await restarted.loaded();
    expect(restarted.view()).toMatchObject({ origin: 'bundled', sequence: 1, checkedAt: null });
    await restarted.checkIfDue();
    expect(restarted.view()).toMatchObject({ origin: 'updated', sequence: 3, check: 'updated' });
  });

  it.each([
    ['no sequence', listText(3, list => delete list.sequence)],
    ['schemaVersion 3', listText(3, list => (list.schemaVersion = 3))],
    ['HTML', '<!doctype html><html></html>'],
  ])('rejects a signed list with %s', async (_label, manifest) => {
    server.publish(3, manifest, sigText(manifest, [signing], 3));
    const s = source();
    await s.checkNow();
    expect(s.view()).toMatchObject({ origin: 'bundled', check: 'failed' });
    logged(/rejected the curated list: (invalid list|the list has no sequence)/);
  });

  it('fails a check on a list over 4 MiB and keeps the current one', async () => {
    const huge = listText(3, list => (list.padding = 'x'.repeat(4 * 1024 * 1024)));
    server.publish(3, huge, sigText(huge, [signing], 3));
    const s = source();
    await s.checkNow();
    expect(s.view()).toMatchObject({ origin: 'bundled', check: 'failed' });
    logged(/\(oversize\)/);
  });

  it('fails a check that times out', async () => {
    server.files.set(
      `${LATEST}.sig`,
      () => new Response(new ReadableStream({ start: () => undefined }), { status: 200 })
    );
    const s = source();
    await s.checkNow();
    expect(s.view().check).toBe('failed');
    logged(/\(timeout\)/);
  });

  it('honors a revocation only from a recovery key, and keeps it after a restart', async () => {
    const fromSigning = listText(2, list => (list.revokedKeyIds = [recovery.key.keyId]));
    server.publish(2, fromSigning, sigText(fromSigning, [signing], 2));
    const s = source();
    await s.checkNow();
    expect(s.view().sequence).toBe(2);

    const revoking = listText(3, list => (list.revokedKeyIds = [signing.key.keyId, recovery.key.keyId]));
    server.publish(3, revoking, sigText(revoking, [recovery], 3));
    await s.checkNow();
    expect(s.view().sequence).toBe(3);
    expect(JSON.parse(await readFile(join(dir, 'revoked-keys.json'), 'utf8'))).toEqual([signing.key.keyId]);

    const four = listText(4);
    server.publish(4, four, sigText(four, [signing], 4));
    const restarted = source();
    await restarted.checkNow();
    expect(restarted.view()).toMatchObject({ sequence: 3, check: 'failed' });
    logged(/revoked-key/);
  });

  it('lets a lower recovery-signed list revoke a leaked key that served the highest sequence', async () => {
    const leaked = listText(HUB_MAX_SEQUENCE);
    const leakedSig = sigText(leaked, [signing], HUB_MAX_SEQUENCE);
    server.publish(HUB_MAX_SEQUENCE, leaked, leakedSig);
    const s = source();
    await s.checkNow();
    expect(s.view()).toMatchObject({ origin: 'updated', sequence: HUB_MAX_SEQUENCE });

    const revoking = listText(5, list => (list.revokedKeyIds = [signing.key.keyId]));
    server.publish(5, revoking, sigText(revoking, [recovery], 5));
    await s.checkNow();
    expect(s.view()).toMatchObject({ origin: 'updated', sequence: 5, check: 'updated' });
    expect(JSON.parse(await readFile(join(dir, 'revoked-keys.json'), 'utf8'))).toEqual([signing.key.keyId]);
    logged(/dropped the cached curated list 1000000: revoked-key/);

    server.publish(HUB_MAX_SEQUENCE, leaked, leakedSig);
    await s.checkNow();
    expect(s.view()).toMatchObject({ sequence: 5, check: 'failed' });
    const restarted = source();
    await restarted.checkNow();
    expect(restarted.view()).toMatchObject({ sequence: 5, check: 'failed' });
  });

  it('rebuilds a missing or unreadable revoked set from a recovery-signed cached list', async () => {
    const revoking = listText(3, list => (list.revokedKeyIds = [signing.key.keyId]));
    server.publish(3, revoking, sigText(revoking, [recovery], 3));
    await source().checkNow();

    for (const damage of [
      () => rm(join(dir, 'revoked-keys.json')),
      () => writeFile(join(dir, 'revoked-keys.json'), '['),
    ]) {
      await damage();
      const restarted = source();
      await restarted.loaded();
      expect(restarted.view()).toMatchObject({ origin: 'updated', sequence: 3 });
      expect(JSON.parse(await readFile(join(dir, 'revoked-keys.json'), 'utf8'))).toEqual([signing.key.keyId]);
      const four = listText(4);
      server.publish(4, four, sigText(four, [signing], 4));
      await restarted.checkNow();
      expect(restarted.view()).toMatchObject({ sequence: 3, check: 'failed' });
    }
    logged(/revoked-keys.json was unreadable; rebuilt it from the cached curated list/);
  });

  it('accepts only a recovery-signed list while an unreadable revoked set is rebuilt, then repairs the file', async () => {
    const three = listText(3);
    server.publish(3, three, sigText(three, [signing], 3));
    await source().checkNow();
    await writeFile(join(dir, 'revoked-keys.json'), '{"not":"a list"}');
    server.requests = [];

    const restarted = source();
    await restarted.loaded();
    expect(restarted.settings().available).toBe(true);
    expect(restarted.view()).toMatchObject({ origin: 'bundled', sequence: 1, checkedAt: null });
    logged(/revoked-keys.json is unreadable and no recovery-signed cached list can rebuild it/);
    const four = listText(4);
    server.publish(4, four, sigText(four, [signing], 4));
    await restarted.checkIfDue();
    expect(restarted.view()).toMatchObject({ origin: 'bundled', sequence: 1, check: 'failed' });
    expect(await readFile(join(dir, 'revoked-keys.json'), 'utf8')).toBe('{"not":"a list"}');
    logged(/only a recovery-signed list can rebuild the unreadable revoked-keys.json/);

    const five = listText(5, list => (list.revokedKeyIds = [signing.key.keyId]));
    server.publish(5, five, sigText(five, [recovery], 5));
    await restarted.checkNow();
    expect(restarted.view()).toMatchObject({ origin: 'updated', sequence: 5, check: 'updated' });
    expect(JSON.parse(await readFile(join(dir, 'revoked-keys.json'), 'utf8'))).toEqual([signing.key.keyId]);
    const six = listText(6);
    server.publish(6, six, sigText(six, [signing], 6));
    await restarted.checkNow();
    expect(restarted.view()).toMatchObject({ sequence: 5, check: 'failed' });
  });

  it('retries a revocation that could not be saved, and applies it from the cached list after a restart', async () => {
    const flaky = new CuratedStore(dir);
    const addRevoked = vi.spyOn(flaky, 'addRevoked').mockRejectedValue(new Error('disk full'));
    const revoking = listText(3, list => (list.revokedKeyIds = [signing.key.keyId]));
    server.publish(3, revoking, sigText(revoking, [recovery], 3));
    const s = source({ store: flaky });
    await s.checkNow();
    expect(addRevoked).toHaveBeenCalledTimes(2);
    expect(s.view()).toMatchObject({ sequence: 3, check: 'updated' });
    await expect(readFile(join(dir, 'revoked-keys.json'))).rejects.toThrow();
    logged(/could not save revoked keys \(attempt 2\): Error: disk full/);

    const four = listText(4);
    server.publish(4, four, sigText(four, [signing], 4));
    await s.checkNow();
    expect(s.view()).toMatchObject({ sequence: 3, check: 'failed' });

    const restarted = source();
    await restarted.checkNow();
    expect(JSON.parse(await readFile(join(dir, 'revoked-keys.json'), 'utf8'))).toEqual([signing.key.keyId]);
    expect(restarted.view()).toMatchObject({ sequence: 3, check: 'failed' });
  });

  it('fails the check when neither the revocation nor the list that carries it could be saved', async () => {
    const broken = new CuratedStore(dir);
    vi.spyOn(broken, 'addRevoked').mockRejectedValue(new Error('disk full'));
    vi.spyOn(broken, 'writeCopy').mockRejectedValue(new Error('disk full'));
    const revoking = listText(3, list => (list.revokedKeyIds = [signing.key.keyId]));
    server.publish(3, revoking, sigText(revoking, [recovery], 3));
    const s = source({ store: broken });
    await s.checkNow();
    expect(s.view()).toMatchObject({ sequence: 3, check: 'failed' });
  });

  it('deletes a cached copy that no longer verifies, and lets a newer bundled list win over the cache', async () => {
    const three = listText(3);
    server.publish(3, three, sigText(three, [signing], 3));
    await source().checkNow();
    const sourceDir = join(dir, CuratedStore.sourceKey(LATEST));

    const newerBundled = source({ bundledText: listText(5) });
    await newerBundled.loaded();
    expect(newerBundled.view()).toMatchObject({ origin: 'bundled', sequence: 5 });

    const pair = JSON.parse(await readFile(join(sourceDir, 'pair.json'), 'utf8')).dir as string;
    await writeFile(join(sourceDir, pair, 'curated-v2.json'), three.replace(NOTE, 'Tampered.'));
    const corrupt = source();
    await corrupt.loaded();
    expect(corrupt.view()).toMatchObject({ origin: 'bundled', sequence: 1 });
    await expect(readFile(join(sourceDir, 'pair.json'))).rejects.toThrow();
    await expect(readFile(join(sourceDir, pair, 'curated-v2.json'))).rejects.toThrow();
    logged(/deleted the cached curated list/);
  });

  it('checks at most every 6 hours, backs off after failures, and lets Check now bypass both', async () => {
    const three = listText(3);
    server.publish(3, three, sigText(three, [signing], 3));
    const s = source();
    await s.checkIfDue();
    expect(server.requests).toHaveLength(2);

    clock += CURATED_CHECK_INTERVAL_MS - 1;
    await s.checkIfDue();
    expect(server.requests).toHaveLength(2);
    clock += 1;
    await s.checkIfDue();
    expect(server.requests).toHaveLength(3);
    clock -= 60_000;
    await s.checkIfDue();
    expect(server.requests).toHaveLength(4);

    server.files.clear();
    clock += CURATED_CHECK_INTERVAL_MS * 2;
    await s.checkIfDue();
    expect(s.view().check).toBe('failed');
    const failedAt = server.requests.length;
    clock += CURATED_BACKOFF_BASE_MS - 1;
    await s.checkIfDue();
    expect(server.requests).toHaveLength(failedAt);
    clock += 1;
    await s.checkIfDue();
    expect(server.requests).toHaveLength(failedAt + 1);
    clock += CURATED_BACKOFF_BASE_MS * 2 - 1;
    await s.checkIfDue();
    expect(server.requests).toHaveLength(failedAt + 1);

    await Promise.all([s.checkNow(), s.checkNow()]);
    expect(server.requests).toHaveLength(failedAt + 2);
  });

  it('flags a list over 180 days old once no check has succeeded for 7 days', async () => {
    const old = listText(3, list => (list.updatedAt = '2026-01-01T00:00:00Z'));
    server.publish(3, old, sigText(old, [signing], 3));
    const s = source();
    await s.checkNow();
    expect(s.view()).toMatchObject({ sequence: 3, stale: false });
    clock += 6 * 24 * 60 * 60 * 1000;
    expect(s.view().stale).toBe(false);
    clock += 2 * 24 * 60 * 60 * 1000;
    expect(s.view().stale).toBe(true);
    await s.checkNow();
    expect(s.view().stale).toBe(false);
  });

  it('uses the bundled list and fetches nothing once turned off, and comes back to the cache when on', async () => {
    const three = listText(3);
    server.publish(3, three, sigText(three, [signing], 3));
    const s = source();
    await s.checkNow();
    server.requests = [];

    expect(await s.setEnabled(false)).toEqual({ available: true, enabled: false });
    await s.checkNow();
    expect(s.view()).toMatchObject({ origin: 'bundled', check: 'off' });
    expect(server.requests).toEqual([]);

    const restarted = source();
    await restarted.loaded();
    expect(restarted.settings().enabled).toBe(false);
    await restarted.setEnabled(true);
    expect(restarted.view()).toMatchObject({ origin: 'updated', sequence: 3 });
  });
});
