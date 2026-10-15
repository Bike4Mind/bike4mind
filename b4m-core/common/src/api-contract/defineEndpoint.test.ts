import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineEndpoint } from './defineEndpoint';
import type { EndpointContract } from './types';

const base: EndpointContract = {
  method: 'get',
  path: '/api/v1/fixture/{id}',
  operationId: 'getFixture',
  summary: 'Fixture',
  auth: 'public',
  responses: { 200: { description: 'ok' } },
};

describe('defineEndpoint', () => {
  it('returns the contract unchanged when pathParams and queryParams share no field names', () => {
    const contract = defineEndpoint({
      ...base,
      pathParams: z.object({ id: z.string() }),
      queryParams: z.object({ limit: z.coerce.number() }),
    });
    expect(contract.pathParams).toBeDefined();
    expect(contract.queryParams).toBeDefined();
  });

  it('throws when pathParams and queryParams declare the same field name', () => {
    // Next merges the {id} segment and the real query string into the same
    // req.query, keyed by name - a shared name would let the path segment
    // silently win over the documented query value (see the field doc comments
    // in ./types.ts).
    expect(() =>
      defineEndpoint({
        ...base,
        pathParams: z.object({ id: z.string() }),
        queryParams: z.object({ id: z.string(), limit: z.coerce.number() }),
      })
    ).toThrow(/getFixture.*pathParams and queryParams both declare.*"id"/s);
  });

  it('does not false-positive on an Object.prototype name that only pathParams declares', () => {
    // Regression: `key in shape` would also match inherited names like
    // `constructor`, even though queryParams's own shape never declares them.
    const contract = defineEndpoint({
      ...base,
      pathParams: z.object({ constructor: z.string() }),
      queryParams: z.object({ limit: z.coerce.number() }),
    });
    expect(contract.pathParams).toBeDefined();
    expect(contract.queryParams).toBeDefined();
  });

  describe('deprecated', () => {
    it('accepts real dates with the sunset after since', () => {
      const deprecated = { since: '2026-10-15', sunset: '2027-01-15', successor: '/api/v1/fixtures' };
      expect(defineEndpoint({ ...base, deprecated }).deprecated).toEqual(deprecated);
    });

    it.each([
      ['a non-ISO date', { since: '10/15/2026', sunset: '2027-01-15' }],
      ['an impossible calendar date', { since: '2026-10-15', sunset: '2027-02-30' }],
    ])('throws on %s', (_label, deprecated) => {
      expect(() => defineEndpoint({ ...base, deprecated })).toThrow(/getFixture.*real YYYY-MM-DD dates/);
    });

    it('throws when the sunset is not after since', () => {
      expect(() => defineEndpoint({ ...base, deprecated: { since: '2026-10-15', sunset: '2026-10-15' } })).toThrow(
        /getFixture.*sunset \(2026-10-15\) must be after since/
      );
    });
  });
});
