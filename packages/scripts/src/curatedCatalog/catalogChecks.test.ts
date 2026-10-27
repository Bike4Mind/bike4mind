import { signCurated } from '@bike4mind/local-models';
import { describe, expect, it, vi } from 'vitest';
import {
  CANONICAL_KEYRING_URL,
  fetchKeyringText,
  KEYRING_PATH,
  MAX_SEQUENCE_STEP,
  planPublish,
  readMainKeyring,
  verifyCandidate,
  type CuratedCandidate,
} from './catalogChecks';
import { curatedDevKey } from './devKey';
import { catalogBytes, sigBytes, testSigner } from './testCatalog';

const signing = testSigner('signing');
const recovery = testSigner('recovery');
const keyring = [signing.key, recovery.key];

function candidate(manifest: Uint8Array, signers = [signing]): CuratedCandidate {
  const checked = verifyCandidate(manifest, sigBytes(manifest, signers), keyring);
  if (!checked.ok) throw new Error(checked.error);
  return checked.value;
}

const error = (manifest: Uint8Array, sig = sigBytes(manifest, [signing]), keys = keyring) => {
  const checked = verifyCandidate(manifest, sig, keys);
  return checked.ok ? null : checked.error;
};

describe('readMainKeyring', () => {
  it("reads keys.json from the canonical repo's main over HTTPS, never a local ref", async () => {
    const read = vi.fn(async () => JSON.stringify(keyring));
    expect(await readMainKeyring(read)).toEqual(keyring);
    expect(read).toHaveBeenCalledWith(`https://raw.githubusercontent.com/Bike4Mind/bike4mind/main/${KEYRING_PATH}`);
    expect(CANONICAL_KEYRING_URL).toBe(read.mock.calls[0][0]);
  });

  it('refuses to run when the keyring cannot be read', async () => {
    const read = async () => {
      throw new Error('HTTP 404');
    };
    await expect(readMainKeyring(read)).rejects.toThrow(/could not read the keyring from https:.*: HTTP 404/);
    await expect(readMainKeyring(async () => '<html>')).rejects.toThrow(/could not read the keyring/);
  });

  it('fails on an entry it cannot trust rather than skipping it', async () => {
    const tampered = [{ ...signing.key, keyId: '0000000000000000' }];
    await expect(readMainKeyring(async () => JSON.stringify(tampered))).rejects.toThrow(/invalid entry at index 0/);
  });

  it('fetches with no redirects and refuses a non-200 or an http URL', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(keyring)));
    expect(await fetchKeyringText(CANONICAL_KEYRING_URL, fetchImpl)).toBe(JSON.stringify(keyring));
    expect(fetchImpl).toHaveBeenCalledWith(CANONICAL_KEYRING_URL, expect.objectContaining({ redirect: 'error' }));
    const missing = vi.fn(async () => new Response('', { status: 404 }));
    await expect(fetchKeyringText(CANONICAL_KEYRING_URL, missing)).rejects.toThrow('HTTP 404');
    await expect(fetchKeyringText('http://example.com/keys.json', fetchImpl)).rejects.toThrow(/not https/);
  });
});

describe('verifyCandidate', () => {
  it('accepts a list signed by a production key and reports the signers', () => {
    const manifest = catalogBytes(2);
    const checked = verifyCandidate(manifest, sigBytes(manifest, [recovery, signing]), keyring);
    expect(checked.ok && checked.value.signers.map(key => key.role)).toEqual(['recovery', 'signing']);
    expect(checked.ok && checked.value.catalog.sequence).toBe(2);
  });

  it('refuses a tampered list, an unknown key and an empty production keyring', () => {
    const manifest = catalogBytes(2);
    const tampered = catalogBytes(2, catalog => (catalog.updatedAt = '2026-10-29T00:00:00Z'));
    expect(error(tampered, sigBytes(manifest, [signing]))).toMatch(/^bad-signature/);
    expect(error(manifest, sigBytes(manifest, [testSigner('signing')]))).toMatch(/^unknown-key/);
    expect(error(manifest, undefined, [])).toMatch(/holds no production key/);
  });

  it('refuses a list only the public test keys signed, even if main trusted them', () => {
    for (const dev of [curatedDevKey('signing'), curatedDevKey('recovery')]) {
      const manifest = catalogBytes(2);
      const sig = new TextEncoder().encode(
        JSON.stringify({ signatures: [{ keyId: dev.keyId, sig: signCurated(manifest, dev.privateKey) }] })
      );
      const withDev = [...keyring, { keyId: dev.keyId, spki: dev.spki, role: dev.role }];
      expect(error(manifest, sig, withDev)).toBe('the list is signed only by the public test key');
    }
  });

  it("refuses to revoke a recovery key in main's keyring", () => {
    const manifest = catalogBytes(2, catalog => (catalog.revokedKeyIds = [recovery.key.keyId]));
    expect(error(manifest, sigBytes(manifest, [recovery]))).toBe(
      `revokedKeyIds names recovery key ${recovery.key.keyId}, which cannot be revoked`
    );
  });

  it('refuses a list without a sequence or with a changelog that does not lead with it', () => {
    expect(error(catalogBytes(2, catalog => delete (catalog as { sequence?: number }).sequence))).toMatch(
      /catalog schema: sequence/
    );
    expect(error(catalogBytes(2, catalog => (catalog.changelog = catalog.changelog.slice(1))))).toMatch(
      /changelog\.0\.sequence/
    );
  });

  it('refuses a pick that Desktop would leave out of its slot', () => {
    const manifest = catalogBytes(2, catalog => (catalog.entries[0].name = 'Qwen3.5 0.8B Abliterated'));
    expect(error(manifest)).toMatch(/cannot fill the best slot/);
  });

  it('refuses bytes over the caps before anything else', () => {
    const huge = new Uint8Array(4 * 1024 * 1024 + 1);
    expect(error(huge, new Uint8Array(1))).toMatch(/list is over/);
    expect(error(catalogBytes(2), new Uint8Array(8 * 1024 + 1))).toMatch(/signature file is over/);
  });
});

describe('planPublish', () => {
  const REVOKED = '00000000000000aa';
  const live = candidate(
    catalogBytes(3, catalog => (catalog.revokedKeyIds = [REVOKED])),
    [recovery]
  );
  const next = (edit?: Parameters<typeof catalogBytes>[1], sequence = 4) =>
    candidate(
      catalogBytes(sequence, catalog => {
        catalog.revokedKeyIds = [REVOKED];
        edit?.(catalog);
      })
    );
  const reason = (edit: Parameters<typeof catalogBytes>[1]) => {
    const plan = planPublish(next(edit), live);
    return plan.kind === 'refused' ? plan.reason : plan.kind;
  };

  it('publishes a higher sequence, and treats a missing live list as the first publish', () => {
    expect(planPublish(next(), live)).toEqual({ kind: 'publish', liveSequence: 3 });
    const unrevoked = next(catalog => (catalog.revokedKeyIds = []));
    expect(planPublish(unrevoked, null)).toEqual({ kind: 'first-publish' });
  });

  it('refuses a step of more than MAX_SEQUENCE_STEP over live, counting a first publish from 0', () => {
    // catalogBytes writes one changelog item per sequence, so a jump prepends a single item instead.
    const jump = (from: number, to: number) =>
      candidate(
        catalogBytes(from, catalog => {
          if (from === 3) catalog.revokedKeyIds = [REVOKED];
          catalog.sequence = to;
          catalog.changelog.unshift({ ...catalog.changelog[0], sequence: to, notes: `Release ${to}.` });
        })
      );
    const at = (sequence: number) => {
      const plan = planPublish(jump(3, sequence), live);
      return plan.kind === 'refused' ? plan.reason : plan.kind;
    };
    expect(MAX_SEQUENCE_STEP).toBe(1000);
    expect(at(3 + MAX_SEQUENCE_STEP)).toBe('publish');
    expect(at(4 + MAX_SEQUENCE_STEP)).toBe('sequence 1004 is more than 1000 above live sequence 3');
    expect(planPublish(jump(1, MAX_SEQUENCE_STEP), null)).toEqual({ kind: 'first-publish' });
    expect(planPublish(jump(1, MAX_SEQUENCE_STEP + 1), null)).toEqual({
      kind: 'refused',
      reason: 'sequence 1001 is more than 1000 above live sequence 0',
    });
  });

  it('refuses a new revocation unless a recovery key signed the list', () => {
    const NEW = '00000000000000bb';
    const growing = (signers: (typeof signing)[]) =>
      candidate(
        catalogBytes(4, catalog => (catalog.revokedKeyIds = [REVOKED, NEW])),
        signers
      );
    expect(planPublish(growing([signing]), live)).toEqual({
      kind: 'refused',
      reason: `revokedKeyIds adds ${NEW} without a recovery-key signature`,
    });
    expect(planPublish(growing([recovery, signing]), live)).toEqual({ kind: 'publish', liveSequence: 3 });
    expect(planPublish(next(), null)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(REVOKED) });
  });

  it('is a no-op for the live bytes and behind live for a lower or a different equal sequence', () => {
    expect(planPublish(live, live)).toEqual({ kind: 'already-live', liveSequence: 3 });
    expect(planPublish(next(undefined, 2), live)).toMatchObject({ kind: 'behind-live', liveSequence: 3 });
    const different = next(catalog => (catalog.entries[0].why = 'Different.'), 3);
    expect(planPublish(different, live)).toMatchObject({ kind: 'behind-live', liveSequence: 3 });
  });

  it('refuses an earlier updatedAt, a rewritten changelog and a dropped revocation', () => {
    expect(reason(catalog => (catalog.updatedAt = '2026-10-01T00:00:00Z'))).toMatch(/updatedAt/);
    expect(reason(catalog => (catalog.changelog[1].notes = 'Rewritten.'))).toMatch(/changelog items already live/);
    expect(reason(catalog => (catalog.revokedKeyIds = []))).toBe(`revokedKeyIds drops ${REVOKED}`);
  });

  it('lets the oldest changelog items drop off', () => {
    expect(reason(catalog => (catalog.changelog = catalog.changelog.slice(0, 2)))).toBe('publish');
  });
});
