import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCuratedSignatureFile, verifyCurated } from '@bike4mind/local-models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './cli';
import { generateCuratedKey, main as keygen } from './keygenCurated';
import { loadPrivateKey, signManifest } from './signCurated';
import { catalogBytes, sigBytes, testSigner } from './testCatalog';

const signing = testSigner('signing');
const recovery = testSigner('recovery');
const keyring = [signing.key, recovery.key];
const PASSPHRASE = 'correct horse battery';

describe('signManifest', () => {
  it('writes a signature file with the sequence hint that verifies', () => {
    const manifest = catalogBytes(5);
    const result = signManifest(manifest, signing.privateKey, null, keyring);
    const bytes = new TextEncoder().encode(result.text);
    expect(parseCuratedSignatureFile(bytes)?.sequence).toBe(5);
    expect(verifyCurated(manifest, bytes, keyring).ok).toBe(true);
    expect(result).toMatchObject({ keyId: signing.key.keyId, kept: [], dropped: [] });
  });

  it('adds to a valid signature for the same sequence, and replaces its own entry', () => {
    const manifest = catalogBytes(5);
    const first = new TextEncoder().encode(signManifest(manifest, recovery.privateKey, null, keyring).text);
    const both = signManifest(manifest, signing.privateKey, first, keyring);
    expect(both.kept).toEqual([recovery.key.keyId]);
    const again = signManifest(manifest, signing.privateKey, new TextEncoder().encode(both.text), keyring);
    expect(parseCuratedSignatureFile(new TextEncoder().encode(again.text))?.signatures.map(s => s.keyId)).toEqual([
      recovery.key.keyId,
      signing.key.keyId,
    ]);
  });

  it('drops signatures over other bytes or another sequence', () => {
    const manifest = catalogBytes(5);
    const stale = signManifest(manifest, recovery.privateKey, sigBytes(catalogBytes(4), [signing], 4), keyring);
    expect(stale.dropped).toEqual([signing.key.keyId]);
    const other = catalogBytes(5, catalog => (catalog.updatedAt = '2026-10-20T00:00:00Z'));
    const edited = signManifest(manifest, recovery.privateKey, sigBytes(other, [signing], 5), keyring);
    expect(edited.dropped).toEqual([signing.key.keyId]);
  });
});

describe('keys', () => {
  it('round-trips an encrypted key, refuses the wrong passphrase and a short one', () => {
    const { pem, entry } = generateCuratedKey('recovery', PASSPHRASE);
    expect(pem).toContain('BEGIN ENCRYPTED PRIVATE KEY');
    const key = loadPrivateKey(pem, PASSPHRASE);
    const manifest = catalogBytes(1);
    const sig = new TextEncoder().encode(signManifest(manifest, key, null, [entry]).text);
    expect(verifyCurated(manifest, sig, [entry]).ok).toBe(true);
    expect(() => loadPrivateKey(pem, 'not the passphrase')).toThrow();
    expect(() => generateCuratedKey('signing', 'short')).toThrow(/at least 12/);
  });

  describe('curated:keygen', () => {
    let dir: string;
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'curated-keygen-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('writes the key owner-only, never over an existing file, and never inside the repo', async () => {
      const env = { CURATED_KEY_PASSPHRASE: PASSPHRASE, INIT_CWD: dir };
      expect(await keygen(['--out', 'signing.pem', '--role', 'signing'], env, log)).toBe(0);
      expect((await stat(path.join(dir, 'signing.pem'))).mode & 0o777).toBe(0o600);
      expect(lines.at(-1)).toContain('"role": "signing"');
      expect(await keygen(['--out', 'signing.pem', '--role', 'signing'], env, log)).toBe(1);

      const inside = path.join(REPO_ROOT, 'catalog', 'leak.pem');
      expect(await keygen(['--out', inside, '--role', 'signing'], env, log)).toBe(1);
      await expect(readFile(inside)).rejects.toThrow();
      expect(await keygen(['--out', 'x.pem', '--role', 'admin'], env, log)).toBe(2);
    });

    it('refuses a symlinked path that leads into the repo', async () => {
      await symlink(path.join(REPO_ROOT, 'catalog'), path.join(dir, 'link'));
      const env = { CURATED_KEY_PASSPHRASE: PASSPHRASE, INIT_CWD: dir };
      expect(await keygen(['--out', 'link/leak.pem', '--role', 'signing'], env, log)).toBe(1);
    });
  });
});
