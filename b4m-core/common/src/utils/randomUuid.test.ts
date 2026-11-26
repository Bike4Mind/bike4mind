import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUuid } from './randomUuid';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const realCrypto = globalThis.crypto;
const realGetRandomValues = realCrypto.getRandomValues.bind(realCrypto);

describe('randomUuid', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('delegates to crypto.randomUUID when present', () => {
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-0000000000aa');
    expect(randomUuid()).toBe('00000000-0000-4000-8000-0000000000aa');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('builds a v4 UUID from getRandomValues when randomUUID is absent', () => {
    vi.stubGlobal('crypto', { getRandomValues: realGetRandomValues });
    const ids = Array.from({ length: 1000 }, () => randomUuid());
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(new Set(ids).size).toBe(1000);
  });

  it.each([
    [0xff, 'ffffffff-ffff-4fff-bfff-ffffffffffff'],
    [0x00, '00000000-0000-4000-8000-000000000000'],
  ])('sets version and variant bits for fill byte %i', (fill, expected) => {
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array) => {
        a.fill(fill);
        return a;
      },
    });
    expect(randomUuid()).toBe(expected);
  });

  it.each([
    ['an empty crypto', {}],
    ['no crypto', undefined],
  ])('throws a named error with %s', (_label, stub) => {
    vi.stubGlobal('crypto', stub);
    expect(() => randomUuid()).toThrow('randomUuid: Web Crypto is unavailable in this runtime');
  });
});
