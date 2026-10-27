import { describe, expect, it } from 'vitest';
import { curatedDevKey, curatedDevOverrides } from './devKey';

describe('the curated test key', () => {
  // Pinned so the copy in packages/scripts/src/curatedCatalog/devKey.ts can be checked against the same id.
  it('derives the documented key id from the public seed', () => {
    expect(curatedDevKey()).toEqual({
      keyId: 'b132926cb06522d5',
      spki: 'MCowBQYDK2VwAyEAMC/oy7zJ6C0JTNO6iNeUkZH5dt0BcgCO10LLD03Dd7k=',
      role: 'signing',
    });
  });

  it('is never offered to a packaged app', () => {
    expect(curatedDevOverrides(true, { B4M_CURATED_DEV_URL: 'http://127.0.0.1:4321/latest.json' })).toBeNull();
  });

  it('takes the URL override from the environment of an unpackaged run', () => {
    expect(curatedDevOverrides(false, { B4M_CURATED_DEV_URL: ' http://127.0.0.1:4321/latest.json ' })).toEqual({
      keys: [curatedDevKey()],
      url: 'http://127.0.0.1:4321/latest.json',
    });
    expect(curatedDevOverrides(false, {})?.url).toBeNull();
  });
});
