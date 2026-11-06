import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { curatedPublicKey, signCurated, type CuratedKey, type CuratedKeyRole } from '@bike4mind/local-models';
import { CATALOG_PATH, REPO_ROOT } from './cli';

/** Test-only helpers: the repo's catalog re-published at any sequence, and throwaway signing keys. */
export interface TestSigner {
  key: CuratedKey;
  privateKey: KeyObject;
}

export function testSigner(role: CuratedKeyRole): TestSigner {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { key: { ...curatedPublicKey(privateKey), role }, privateKey };
}

type Catalog = Record<string, unknown> & {
  sequence: number;
  updatedAt: string;
  revokedKeyIds?: string[];
  changelog: Record<string, unknown>[];
  entries: Record<string, unknown>[];
};

const REPO_CATALOG = readFileSync(path.join(REPO_ROOT, CATALOG_PATH), 'utf8');

/** The repo's catalog at `sequence`, with one changelog item per sequence from 1 so the history stays valid. */
export function catalogBytes(sequence: number, edit: (catalog: Catalog) => void = () => {}): Uint8Array {
  const catalog = JSON.parse(REPO_CATALOG) as Catalog;
  const first = catalog.changelog[0];
  catalog.sequence = sequence;
  catalog.updatedAt = `2026-10-${String(10 + sequence).padStart(2, '0')}T00:00:00Z`;
  catalog.changelog = Array.from({ length: sequence }, (_, i) => {
    const at = sequence - i;
    return at === 1 ? { ...first, sequence: 1 } : { ...first, sequence: at, added: [], notes: `Release ${at}.` };
  });
  edit(catalog);
  return new TextEncoder().encode(`${JSON.stringify(catalog, null, 2)}\n`);
}

export function sigBytes(manifest: Uint8Array, signers: TestSigner[], sequence?: number): Uint8Array {
  const signatures = signers.map(s => ({ keyId: s.key.keyId, sig: signCurated(manifest, s.privateKey) }));
  return new TextEncoder().encode(JSON.stringify({ sequence, signatures }));
}
