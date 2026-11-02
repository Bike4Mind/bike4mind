import { createHash, type KeyObject } from 'node:crypto';
import { curatedKeyFromSeed, type CuratedKey, type CuratedKeyRole } from '@bike4mind/local-models/curated-signing';

// The seeds are public on purpose, so these keys prove nothing. Must stay in sync with
// packages/scripts/src/curatedCatalog/devKey.ts, apps/desktop/src/main/models/curated/devKey.ts and
// packages/cli/src/models/curatedDevKey.ts; curatedCatalog.test.ts checks all four.
const SEED_TEXTS: Record<CuratedKeyRole, string> = {
  signing: 'b4m-model-hub-curated-test-key',
  recovery: 'b4m-model-hub-curated-test-recovery-key',
};

/** A public test key with its private half, for tests and local runs. */
export function curatedDevKeyPair(role: CuratedKeyRole): { key: CuratedKey; privateKey: KeyObject } {
  const { privateKey, keyId, spki } = curatedKeyFromSeed(createHash('sha256').update(SEED_TEXTS[role]).digest());
  return { key: { keyId, spki, role }, privateKey };
}

export const curatedDevKeys = (): CuratedKey[] => [curatedDevKeyPair('signing').key, curatedDevKeyPair('recovery').key];
