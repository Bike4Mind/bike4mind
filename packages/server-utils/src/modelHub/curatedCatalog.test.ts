import { describe, expect, it, vi } from 'vitest';
import type {
  CuratedCatalogVersionRecord,
  CuratedCatalogVersionRepository,
  NewCuratedCatalogVersion,
} from '@bike4mind/database';
import {
  CURATED_MAX_MANIFEST_BYTES,
  CURATED_MAX_SIGNATURE_BYTES,
  PRODUCTION_CURATED_KEYS,
} from '@bike4mind/local-models/curated-signing';
import { curatedDevKeys as cliDevKeys } from '../../../cli/src/models/curatedDevKey';
import { curatedDevKeys as scriptsDevKeys } from '../../../scripts/src/curatedCatalog/devKey';
import {
  CURATED_CHANNEL,
  curatedDevKeysEnabled,
  curatedServerKeyring,
  importCuratedVersion,
  parseCuratedFileName,
  type CuratedImportDeps,
} from './curatedCatalog';
import { curatedDevKeys } from './curatedDevKeys';
import { catalogText, signatureText, testSigner } from './__tests__/utils/curatedTestPairs';

const tolerantDrop = vi.hoisted(() => ({ path: null as string | null }));
vi.mock('@bike4mind/common/modelHub', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/common/modelHub')>();
  return {
    ...actual,
    parseHubManifest: (input: unknown) => {
      const parsed = actual.parseHubManifest(input);
      return tolerantDrop.path ? { ...parsed, dropped: [{ path: tolerantDrop.path, reason: 'test drop' }] } : parsed;
    },
  };
});

const signing = testSigner('signing');
const signing2 = testSigner('signing');
const recovery = testSigner('recovery');
const stranger = testSigner('signing');
const keyring = [signing.key, signing2.key, recovery.key];

/** An in-memory repository with the Mongo one's unique (channel, sequence) and (channel, position) rules. */
function memoryRepository() {
  const versions: CuratedCatalogVersionRecord[] = [];
  const latest = async (channel: string) =>
    versions.filter(v => v.channel === channel).sort((a, b) => b.position - a.position)[0] ?? null;
  const repository = {
    ready: async () => {},
    latest,
    async findBySequence(channel: string, sequence: number) {
      return versions.find(v => v.channel === channel && v.sequence === sequence) ?? null;
    },
    async highestSequenceSignedBy(channel: string, keyIds: readonly string[]) {
      const signed = versions.filter(v => v.channel === channel && v.keyIds.some(id => keyIds.includes(id)));
      return Math.max(0, ...signed.map(v => v.sequence));
    },
    async append(version: NewCuratedCatalogVersion) {
      const taken = (v: CuratedCatalogVersionRecord) =>
        v.channel === version.channel && (v.sequence === version.sequence || v.position === version.position);
      if (versions.some(taken)) return null;
      const record = { ...version, sha256: `sha-${version.sequence}`, publishedAt: new Date() };
      versions.push(record);
      return record;
    },
  } as unknown as CuratedCatalogVersionRepository;
  return { versions, repository, latest };
}

const pair = (sequence: number, signers = [signing], edit?: Parameters<typeof catalogText>[1]) => {
  const manifest = catalogText(sequence, edit);
  return { manifest, signature: signatureText(manifest, signers) };
};

const importPair = (
  repository: CuratedCatalogVersionRepository,
  p: { manifest: string; signature: string },
  deps: CuratedImportDeps = {}
) =>
  importCuratedVersion({ ...p, origin: 'import', publishedBy: 'admin-1', reason: 'test import' }, keyring, {
    repository,
    transact: work => work(),
    ...deps,
  });

const revoking =
  (...ids: string[]) =>
  (c: { revokedKeyIds?: string[] }) =>
    (c.revokedKeyIds = ids);

describe('importCuratedVersion', () => {
  it('stores a verified first list with its exact texts, verified signers and position 1', async () => {
    const { versions, repository } = memoryRepository();
    const p = pair(1, [signing, recovery]);
    const onStored = vi.fn(async () => {});
    const result = await importPair(repository, p, { onStored });
    expect(result).toMatchObject({ ok: true, alreadyLive: false, plan: 'first', live: null });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      channel: CURATED_CHANNEL,
      sequence: 1,
      position: 1,
      manifestBytes: p.manifest,
      signatureBytes: p.signature,
      keyIds: [signing.key.keyId, recovery.key.keyId],
      origin: 'import',
      publishedBy: 'admin-1',
    });
    expect(onStored).toHaveBeenCalledWith(versions[0], null);
  });

  it('refuses a byte-flipped list, an unknown signer and a malformed signature file', async () => {
    const { versions, repository } = memoryRepository();
    const good = pair(1);
    const flipped = { ...good, manifest: good.manifest.replace('"sequence": 1', '"sequence": 1 ') };
    expect(await importPair(repository, flipped)).toMatchObject({ ok: false, status: 400, error: /bad-signature/ });
    expect(await importPair(repository, pair(1, [stranger]))).toMatchObject({ status: 400, error: /unknown-key/ });
    expect(await importPair(repository, { ...good, signature: '{}' })).toMatchObject({
      status: 400,
      error: /malformed-signature-file/,
    });
    expect(versions).toHaveLength(0);
  });

  it('refuses a lower or equal sequence with 409 and chains the next one', async () => {
    const { versions, repository } = memoryRepository();
    expect((await importPair(repository, pair(2))).ok).toBe(true);
    expect(await importPair(repository, pair(2, [signing2]))).toMatchObject({ status: 409, error: /not above live/ });
    expect(await importPair(repository, pair(1))).toMatchObject({ ok: false, status: 409 });
    expect(await importPair(repository, pair(3))).toMatchObject({ ok: true, plan: 'next' });
    expect(versions.map(v => [v.sequence, v.position])).toEqual([
      [2, 1],
      [3, 2],
    ]);
  });

  it('answers a byte-identical re-import as already live and stores nothing', async () => {
    const { versions, repository } = memoryRepository();
    const p = pair(2);
    await importPair(repository, p);
    const onStored = vi.fn(async () => {});
    expect(await importPair(repository, p, { onStored })).toMatchObject({ ok: true, alreadyLive: true });
    expect(versions).toHaveLength(1);
    expect(onStored).not.toHaveBeenCalled();
  });

  it('caps the step over live, counting a first import from 0', async () => {
    const { repository } = memoryRepository();
    const short = (c: { updatedAt: string; changelog: unknown[] }) => {
      c.updatedAt = '2026-10-30T00:00:00Z';
      c.changelog = c.changelog.slice(0, 2);
    };
    expect(await importPair(repository, pair(1001, [signing], short))).toMatchObject({
      status: 400,
      error: /1001 is more than 1000 above live sequence 0/,
    });
    expect((await importPair(repository, pair(1000, [signing], short))).ok).toBe(true);
    expect(await importPair(repository, pair(2001, [signing], short))).toMatchObject({
      status: 400,
      error: /more than 1000 above live sequence 1000/,
    });
  });

  it('refuses an updatedAt earlier than live', async () => {
    const { repository } = memoryRepository();
    await importPair(repository, pair(2));
    const earlier = (c: { updatedAt: string }) => (c.updatedAt = '2026-01-01T00:00:00Z');
    expect(await importPair(repository, pair(3, [signing], earlier))).toMatchObject({
      status: 400,
      error: /updatedAt 2026-01-01T00:00:00Z is earlier than live/,
    });
  });

  it('refuses a list or a signature file over its size cap', async () => {
    const { repository } = memoryRepository();
    const p = pair(1);
    const bigList = { ...p, manifest: 'a'.repeat(CURATED_MAX_MANIFEST_BYTES + 1) };
    expect(await importPair(repository, bigList)).toMatchObject({ status: 400, error: /the list is over/ });
    const bigSig = { ...p, signature: 'a'.repeat(CURATED_MAX_SIGNATURE_BYTES + 1) };
    expect(await importPair(repository, bigSig)).toMatchObject({ status: 400, error: /signature file is over/ });
  });

  it('refuses a list part of which clients would drop', async () => {
    const { repository } = memoryRepository();
    // The strict schema catches every drop the tolerant reader makes today, so the reader is stubbed to drop one.
    tolerantDrop.path = 'entries.0';
    try {
      expect(await importPair(repository, pair(1))).toMatchObject({
        status: 400,
        error: 'clients would drop part of the list: entries.0 (test drop)',
      });
    } finally {
      tolerantDrop.path = null;
    }
  });

  it('refuses a pick that cannot fill its slot, as the bucket publish does', async () => {
    const { repository } = memoryRepository();
    const abliterated = (c: Record<string, unknown>) =>
      ((c.entries as { name: string }[])[0].name = 'Qwen3.5 0.8B Abliterated');
    expect(await importPair(repository, pair(1, [signing], abliterated))).toMatchObject({
      status: 400,
      error: /cannot fill the best slot/,
    });
  });

  it('refuses a signature file whose sequence hint names another list', async () => {
    const { repository } = memoryRepository();
    const manifest = catalogText(1);
    const signature = signatureText(manifest, [signing], 7);
    expect(await importPair(repository, { manifest, signature })).toMatchObject({ status: 400, error: /sequence 1/ });
  });

  it('refuses a list that fails the strict catalog schema', async () => {
    const { repository } = memoryRepository();
    const p = pair(1, [signing], c => (c.changelog = []));
    expect(await importPair(repository, p)).toMatchObject({ status: 400, error: /catalog schema/ });
  });

  it('needs a recovery signature to revoke, and then refuses lists only the revoked key signed', async () => {
    const { repository } = memoryRepository();
    expect((await importPair(repository, pair(1))).ok).toBe(true);
    const revokes = revoking(signing.key.keyId);
    expect(await importPair(repository, pair(2, [signing2], revokes))).toMatchObject({ error: /recovery key/ });
    expect((await importPair(repository, pair(2, [recovery], revokes))).ok).toBe(true);
    expect(await importPair(repository, pair(3, [signing], revokes))).toMatchObject({ error: /revoked-key/ });
    expect(await importPair(repository, pair(3, [signing2]))).toMatchObject({ error: /drops/ });
    expect((await importPair(repository, pair(3, [signing2], revokes))).ok).toBe(false);
    expect((await importPair(repository, pair(3, [signing2, recovery], revokes))).ok).toBe(true);
  });

  it('does not bind the revocations of a live list no recovery key signed', async () => {
    const { versions, repository } = memoryRepository();
    const manifest = catalogText(1, revoking(signing2.key.keyId));
    versions.push({
      channel: CURATED_CHANNEL,
      sequence: 1,
      position: 1,
      manifestBytes: manifest,
      signatureBytes: signatureText(manifest, [signing]),
      sha256: 'x',
      keyIds: [signing.key.keyId],
      origin: 'mirror',
      publishedAt: new Date(),
      publishedBy: null,
      reason: null,
    });
    expect(await importPair(repository, pair(2, [signing2]))).toMatchObject({ ok: true, plan: 'next' });
  });

  it('refuses revoking a recovery key and a rewritten changelog', async () => {
    const { repository } = memoryRepository();
    expect(await importPair(repository, pair(1, [recovery], revoking(recovery.key.keyId)))).toMatchObject({
      error: /names recovery key/,
    });
    expect((await importPair(repository, pair(1))).ok).toBe(true);
    const rewrite = (c: { changelog: Record<string, unknown>[] }) => (c.changelog[1].notes = 'Rewritten.');
    expect(await importPair(repository, pair(2, [signing], rewrite))).toMatchObject({ error: /changelog/ });
  });

  it('lets a recovery list at a lower unused sequence replace a list a leaked key pushed far ahead', async () => {
    const { versions, repository, latest } = memoryRepository();
    expect((await importPair(repository, pair(2))).ok).toBe(true);
    const leaked = (c: { updatedAt: string; changelog: unknown[] }) => {
      c.updatedAt = '9999-12-31T00:00:00Z';
      c.changelog = c.changelog.slice(0, 2);
    };
    expect(await importPair(repository, pair(1002, [signing], leaked))).toMatchObject({ ok: true, plan: 'next' });

    const recoveryList = pair(3, [recovery, signing2], revoking(signing.key.keyId));
    expect(await importPair(repository, recoveryList)).toMatchObject({ ok: true, plan: 'recover' });
    expect((await latest(CURATED_CHANNEL))?.manifestBytes).toBe(recoveryList.manifest);
    expect(versions.map(v => [v.sequence, v.position])).toEqual([
      [2, 1],
      [1002, 2],
      [3, 3],
    ]);
    expect(await importPair(repository, pair(4, [signing], revoking(signing.key.keyId)))).toMatchObject({
      error: /revoked-key/,
    });
    const next = await importPair(repository, pair(4, [signing2, recovery], revoking(signing.key.keyId)));
    expect(next).toMatchObject({ ok: true, plan: 'next' });
  });

  it('refuses a recovery list below the highest list a key it leaves trusted signed, as clients would ignore it', async () => {
    const { repository } = memoryRepository();
    expect((await importPair(repository, pair(2))).ok).toBe(true);
    expect((await importPair(repository, pair(10))).ok).toBe(true);
    expect((await importPair(repository, pair(15, [signing2]))).ok).toBe(true);

    expect(await importPair(repository, pair(5, [recovery], revoking(signing2.key.keyId)))).toMatchObject({
      ok: false,
      status: 409,
      error: /below 10/,
    });
    expect(await importPair(repository, pair(12, [recovery], revoking(signing2.key.keyId)))).toMatchObject({
      ok: true,
      plan: 'recover',
    });
  });

  it('refuses a recovery list at a sequence already stored, and one that leaves a live signer unrevoked', async () => {
    const { repository } = memoryRepository();
    await importPair(repository, pair(2));
    await importPair(repository, pair(3, [signing2]));
    expect(await importPair(repository, pair(2, [recovery], revoking(signing2.key.keyId)))).toMatchObject({
      status: 409,
      error: /sequence 2 is already stored/,
    });
    expect(await importPair(repository, pair(1, [recovery], revoking(signing.key.keyId)))).toMatchObject({
      status: 409,
      error: /not above live/,
    });
  });

  it('refuses text that is not well-formed UTF-8', async () => {
    const { repository } = memoryRepository();
    const p = pair(1);
    expect(await importPair(repository, { ...p, manifest: `${p.manifest}\ud800` })).toMatchObject({
      status: 400,
      error: /UTF-8/,
    });
  });

  it('takes a list saved with a UTF-8 BOM, as clients do, and stores it with the BOM', async () => {
    const { repository, latest } = memoryRepository();
    const manifest = `\uFEFF${catalogText(1)}`;
    const p = { manifest, signature: signatureText(manifest, [signing], 1) };
    expect(await importPair(repository, p)).toMatchObject({ ok: true, plan: 'first' });
    expect((await latest(CURATED_CHANNEL))?.manifestBytes).toBe(manifest);
    expect(await importPair(repository, pair(2))).toMatchObject({ ok: true, plan: 'next' });
  });

  it('gives the second of two imports checked against the same live version a 409', async () => {
    const { versions, repository, latest } = memoryRepository();
    await importPair(repository, pair(2));
    const snapshot = await latest(CURATED_CHANNEL);
    const stale = { ...repository, latest: async () => snapshot } as unknown as CuratedCatalogVersionRepository;
    expect(await importPair(stale, pair(3))).toMatchObject({ ok: true, plan: 'next' });
    expect(await importPair(stale, pair(4))).toMatchObject({ status: 409, error: /same time/ });
    expect(versions.map(v => v.sequence)).toEqual([2, 3]);
  });
});

describe('curatedServerKeyring', () => {
  it('trusts the test keys only when enabled, off production, and on a deployed stage only for a preview', () => {
    const on = { MODEL_HUB_CURATED_DEV_KEYS: '1' };
    expect(curatedDevKeysEnabled(on, 'dev', false)).toBe(true);
    expect(curatedDevKeysEnabled(on, 'pr6349', true)).toBe(true);
    expect(curatedDevKeysEnabled(on, 'staging', true)).toBe(false);
    expect(curatedDevKeysEnabled(on, 'staging', false)).toBe(false);
    expect(curatedDevKeysEnabled(on, 'production', false)).toBe(false);
    expect(curatedDevKeysEnabled({}, 'dev', false)).toBe(false);
    expect(curatedServerKeyring(false)).toEqual([...PRODUCTION_CURATED_KEYS]);
    expect(curatedServerKeyring(true)).toEqual([...PRODUCTION_CURATED_KEYS, ...curatedDevKeys()]);
  });

  it('derives the same test keys as the scripts and CLI copies, and the ids Desktop pins', () => {
    const ids = (keys: { keyId: string; role: string }[]) => keys.map(key => `${key.role}:${key.keyId}`);
    // Desktop is off limits to this package; apps/desktop/src/main/models/curated/devKey.test.ts pins the same ids.
    const expected = ['signing:b132926cb06522d5', 'recovery:689f488b0fe321ad'];
    expect(ids(curatedDevKeys())).toEqual(expected);
    expect(ids(scriptsDevKeys())).toEqual(expected);
    expect(ids(cliDevKeys())).toEqual(expected);
  });
});

describe('parseCuratedFileName', () => {
  it.each([
    ['latest.json', { kind: 'latest', signature: false }],
    ['latest.json.sig', { kind: 'latest', signature: true }],
    ['17.json', { kind: 'sequence', sequence: 17, signature: false }],
    ['17.json.sig', { kind: 'sequence', sequence: 17, signature: true }],
    ['schema.json', { kind: 'schema' }],
  ])('reads %s', (name, expected) => {
    expect(parseCuratedFileName(name)).toEqual(expected);
  });

  it.each([
    '0.json',
    '01.json',
    '1000001.json',
    'latest',
    'latest.sig',
    '../latest.json',
    'schema.json.sig',
    '1.5.json',
  ])('rejects %s', name => {
    expect(parseCuratedFileName(name)).toBeNull();
  });
});
