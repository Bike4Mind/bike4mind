import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sstSecret: { value: 'right-secret' } as { value: string } | undefined,
}));

vi.mock('sst', () => ({
  Resource: {
    get E2E_CLEANUP_SECRET() {
      return h.sstSecret;
    },
  },
}));

import { isValidE2eTestSecret } from './e2eTestSecret';

beforeEach(() => {
  h.sstSecret = { value: 'right-secret' };
  delete process.env.E2E_CLEANUP_SECRET;
});

afterEach(() => {
  delete process.env.E2E_CLEANUP_SECRET;
});

describe('isValidE2eTestSecret', () => {
  it('accepts the configured secret', () => {
    expect(isValidE2eTestSecret('right-secret')).toBe(true);
  });

  it('rejects a same-length mismatch', () => {
    expect(isValidE2eTestSecret('wrong-secret')).toBe(false);
  });

  it('rejects a different-length value without throwing', () => {
    expect(isValidE2eTestSecret('right-secret-but-longer')).toBe(false);
    expect(isValidE2eTestSecret('right')).toBe(false);
  });

  it('rejects a missing, empty or non-string header', () => {
    expect(isValidE2eTestSecret(undefined)).toBe(false);
    expect(isValidE2eTestSecret('')).toBe(false);
    expect(isValidE2eTestSecret(['right-secret'])).toBe(false);
  });

  it('fails closed when no secret is configured', () => {
    h.sstSecret = undefined;
    expect(isValidE2eTestSecret('right-secret')).toBe(false);
    expect(isValidE2eTestSecret('')).toBe(false);
    expect(isValidE2eTestSecret(undefined)).toBe(false);
  });

  it('fails closed when the configured secret is empty', () => {
    h.sstSecret = { value: '' };
    process.env.E2E_CLEANUP_SECRET = '';
    expect(isValidE2eTestSecret('')).toBe(false);
  });

  it('fails closed on the SST placeholder value', () => {
    h.sstSecret = { value: 'not-configured' };
    expect(isValidE2eTestSecret('not-configured')).toBe(false);
  });

  it('falls back to the env var when the SST secret is unset', () => {
    h.sstSecret = undefined;
    process.env.E2E_CLEANUP_SECRET = 'env-secret';
    expect(isValidE2eTestSecret('env-secret')).toBe(true);
    expect(isValidE2eTestSecret('right-secret')).toBe(false);
  });

  it('compares bytes, so a multi-byte value of equal character count is rejected', () => {
    h.sstSecret = { value: 'abc' };
    expect(isValidE2eTestSecret('ab\u00e9')).toBe(false);
  });
});
