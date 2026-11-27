import { describe, expect, it } from 'vitest';
import keyring from '../../../../catalog/model-hub/keys.json';
import { parseCuratedKey } from '../curatedSignature';
import { PRODUCTION_CURATED_KEYS } from './keys';

describe('the production curated keyring', () => {
  it('holds only valid keys, so none is dropped silently', () => {
    expect(Array.isArray(keyring)).toBe(true);
    expect((keyring as unknown[]).every(entry => parseCuratedKey(entry) !== null)).toBe(true);
    expect(PRODUCTION_CURATED_KEYS).toHaveLength((keyring as unknown[]).length);
  });

  it('has a recovery key whenever it has a signing key', () => {
    const roles = new Set(PRODUCTION_CURATED_KEYS.map(key => key.role));
    if (roles.has('signing')) expect(roles.has('recovery')).toBe(true);
  });
});
