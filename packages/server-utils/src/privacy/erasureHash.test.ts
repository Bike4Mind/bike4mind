// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
  JWT_SECRET: 'secret-a',
  OVERWATCH_PSEUDONYM_SALT: 'not-configured' as string | undefined,
}));
vi.mock('../utils/config', () => ({ Config: cfg }));

import {
  deriveErasureKey,
  erasureIdHash,
  erasureIdHashWith,
  erasureKeyId,
  erasureKeyIdWith,
  erasurePseudonym,
} from './erasureHash';
import { pseudonymize } from '../analytics/pseudonymize';

describe('erasureHash', () => {
  const keyA = deriveErasureKey('secret-a');
  const keyB = deriveErasureKey('secret-b');
  const id = '64b7f0c2a1d3e4f5a6b7c8d9';

  it('is deterministic and does not contain the raw id', () => {
    expect(erasureIdHashWith(keyA, id)).toBe(erasureIdHashWith(keyA, id));
    expect(erasureIdHashWith(keyA, id)).toMatch(/^[0-9a-f]{64}$/);
    expect(erasureIdHashWith(keyA, id)).not.toContain(id);
  });

  it('differs across keys and across ids, and so does the keyId', () => {
    expect(erasureIdHashWith(keyA, id)).not.toBe(erasureIdHashWith(keyB, id));
    expect(erasureIdHashWith(keyA, id)).not.toBe(erasureIdHashWith(keyA, `${id}0`));
    expect(erasureKeyIdWith(keyA)).toMatch(/^[0-9a-f]{16}$/);
    expect(erasureKeyIdWith(keyA)).not.toBe(erasureKeyIdWith(keyB));
  });

  it('config-backed helpers use the JWT_SECRET-derived key', () => {
    expect(erasureIdHash(id)).toBe(erasureIdHashWith(keyA, id));
    expect(erasureKeyId()).toBe(erasureKeyIdWith(keyA));
  });

  it('hashes one canonical form whatever the id case', () => {
    expect(erasureIdHash(id.toUpperCase())).toBe(erasureIdHash(id));
  });

  it('gives no pseudonym while the salt is unset or the placeholder', () => {
    expect(erasurePseudonym(id)).toBeNull();
    cfg.OVERWATCH_PSEUDONYM_SALT = undefined;
    expect(erasurePseudonym(id)).toBeNull();
    cfg.OVERWATCH_PSEUDONYM_SALT = 'not-configured';
  });

  it('gives the analytics pseudonym once a real salt is set', () => {
    cfg.OVERWATCH_PSEUDONYM_SALT = 'a-real-salt';
    try {
      expect(erasurePseudonym(id)).toBe(pseudonymize(id, 'a-real-salt'));
      expect(erasurePseudonym(id)).not.toBe(id);
    } finally {
      cfg.OVERWATCH_PSEUDONYM_SALT = 'not-configured';
    }
  });
});
