// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/config', () => ({ Config: { JWT_SECRET: 'secret-a', OVERWATCH_PSEUDONYM_SALT: 'not-configured' } }));

import {
  deriveErasureKey,
  erasureIdHash,
  erasureIdHashWith,
  erasureKeyId,
  erasureKeyIdWith,
  erasurePseudonym,
} from './erasureHash';

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

  it('gives no pseudonym while the salt is unset or the placeholder', () => {
    expect(erasurePseudonym(id)).toBeNull();
  });
});
