import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  curatedPublicKey,
  signCurated,
  type CuratedKey,
  type CuratedKeyRole,
} from '@bike4mind/local-models/curated-signing';

/** Test-only: the repo's curated catalog re-published at any sequence, signed with throwaway keys. */
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
};

const REPO_CATALOG = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../catalog/model-hub/curated-v2.json'),
  'utf8'
);

/** The repo's catalog at `sequence` (1 to 19), one changelog item per sequence so the history stays valid. */
export function catalogText(sequence: number, edit: (catalog: Catalog) => void = () => {}): string {
  const catalog = JSON.parse(REPO_CATALOG) as Catalog;
  const first = catalog.changelog[0];
  catalog.sequence = sequence;
  catalog.updatedAt = `2026-10-${String(10 + sequence).padStart(2, '0')}T00:00:00Z`;
  catalog.changelog = Array.from({ length: sequence }, (_, i) => {
    const at = sequence - i;
    return at === 1 ? { ...first, sequence: 1 } : { ...first, sequence: at, added: [], notes: `Release ${at}.` };
  });
  edit(catalog);
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

export function signatureText(manifest: string, signers: TestSigner[], sequence?: number): string {
  const bytes = Buffer.from(manifest, 'utf8');
  const signatures = signers.map(s => ({ keyId: s.key.keyId, sig: signCurated(bytes, s.privateKey) }));
  return `${JSON.stringify({ sequence: sequence ?? (JSON.parse(manifest) as Catalog).sequence, signatures }, null, 2)}\n`;
}
