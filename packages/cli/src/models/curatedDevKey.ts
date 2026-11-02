import { createHash } from 'node:crypto';
import { curatedKeyFromSeed, type CuratedKey, type CuratedKeyRole } from '@bike4mind/local-models';

// The seeds are public on purpose, so these keys prove nothing. Must stay in sync with
// packages/scripts/src/curatedCatalog/devKey.ts, which scans built bundles for them.
const SEED_TEXTS: Record<CuratedKeyRole, string> = {
  signing: 'b4m-model-hub-curated-test-key',
  recovery: 'b4m-model-hub-curated-test-recovery-key',
};

export function curatedDevKey(role: CuratedKeyRole): CuratedKey {
  const { keyId, spki } = curatedKeyFromSeed(createHash('sha256').update(SEED_TEXTS[role]).digest());
  return { keyId, spki, role };
}

export const curatedDevKeys = (): CuratedKey[] => [curatedDevKey('signing'), curatedDevKey('recovery')];
