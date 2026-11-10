import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  secret: undefined as { value?: string } | undefined,
  throws: false,
  timingSafeEqual: vi.fn(),
}));

vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto');
  h.timingSafeEqual.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual: h.timingSafeEqual };
});

vi.mock('sst', () => ({
  Resource: {
    get PERSONA_ADMIN_KEY() {
      if (h.throws) throw new Error('PERSONA_ADMIN_KEY is not linked');
      return h.secret;
    },
  },
}));

import { isValidPersonaAdminKey, readPersonaAdminKey } from './personaAdminKey';

const KEY = 'k'.repeat(40);

beforeEach(() => {
  h.secret = undefined;
  h.throws = false;
  delete process.env.PERSONA_ADMIN_KEY;
});

describe('readPersonaAdminKey', () => {
  it('reads the SST secret', () => {
    h.secret = { value: KEY };
    expect(readPersonaAdminKey()).toBe(KEY);
  });

  it('falls back to the env var when the secret is not linked', () => {
    h.throws = true;
    process.env.PERSONA_ADMIN_KEY = KEY;
    expect(readPersonaAdminKey()).toBe(KEY);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['the placeholder', 'not-configured'],
    ['too short to be a real key', 'short-key'],
  ])('is undefined (endpoint off) when the secret is %s', (_label, value) => {
    h.secret = value === undefined ? undefined : { value };
    expect(readPersonaAdminKey()).toBeUndefined();
  });
});

describe('isValidPersonaAdminKey', () => {
  it('accepts only the exact key', () => {
    expect(isValidPersonaAdminKey(KEY, KEY)).toBe(true);
    expect(isValidPersonaAdminKey(`${KEY}x`, KEY)).toBe(false);
    expect(isValidPersonaAdminKey('k'.repeat(39) + 'j', KEY)).toBe(false);
  });

  it('runs the constant-time compare even for a key of the wrong length, so timing never reveals the length', () => {
    h.timingSafeEqual.mockClear();
    expect(isValidPersonaAdminKey('k', KEY)).toBe(false);
    expect(h.timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, '', ['a', 'b'], 42])('rejects a missing or malformed header (%s)', provided => {
    expect(isValidPersonaAdminKey(provided, KEY)).toBe(false);
  });
});
