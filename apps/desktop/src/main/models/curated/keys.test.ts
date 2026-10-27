import { parseCuratedKey } from '@bike4mind/local-models';
import { describe, expect, it } from 'vitest';
import { curatedDevKey } from './devKey';
import keyring from './keys.json';
import { PRODUCTION_CURATED_KEYS } from './keys';

describe('the production curated keyring', () => {
  it('holds only valid keys, so none is dropped silently', () => {
    expect(Array.isArray(keyring)).toBe(true);
    expect((keyring as unknown[]).every(entry => parseCuratedKey(entry) !== null)).toBe(true);
    expect(PRODUCTION_CURATED_KEYS).toHaveLength((keyring as unknown[]).length);
  });

  it('never trusts the test keys', () => {
    for (const dev of [curatedDevKey('signing'), curatedDevKey('recovery')])
      expect(PRODUCTION_CURATED_KEYS.some(key => key.keyId === dev.keyId || key.spki === dev.spki)).toBe(false);
  });

  it('has a recovery key whenever it has a signing key', () => {
    const roles = new Set(PRODUCTION_CURATED_KEYS.map(key => key.role));
    if (roles.has('signing')) expect(roles.has('recovery')).toBe(true);
  });
});
