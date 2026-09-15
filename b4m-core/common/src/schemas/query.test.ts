import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { queryBool } from './query';

/**
 * `z.coerce.boolean()` is `Boolean(input)`, so on a query string - where every value is a string -
 * `'false'` becomes TRUE. These pin the parse for the shapes `qs.parse` can hand a route, including
 * the repeated-param array that must resolve rather than surface as a 422.
 */
describe('queryBool', () => {
  const schema = z.object({ flag: queryBool });
  const parse = (flag?: unknown) => schema.parse(flag === undefined ? {} : { flag }).flag;

  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['false', false],
    ['False', false],
    ['0', false],
    ['', false],
    ['yes', false],
  ])('parses the string %j as %s', (input, expected) => {
    expect(parse(input)).toBe(expected);
  });

  it('defaults to false when the param is absent', () => {
    expect(parse()).toBe(false);
  });

  it('accepts a real boolean, so the helper is safe off the wire too', () => {
    expect(parse(true)).toBe(true);
    expect(parse(false)).toBe(false);
  });

  it('takes the last value of a repeated param instead of rejecting the request', () => {
    // qs turns ?flag=true&flag=false into an array. Collapsing that to the default would silently
    // ignore a caller who asked twice for true; a bare union would 422 the whole request.
    expect(parse(['true', 'false'])).toBe(false);
    expect(parse(['false', 'true'])).toBe(true);
    expect(parse(['true'])).toBe(true);
  });

  it('falls back to the default for a value it cannot read, rather than 422ing', () => {
    expect(parse({ nested: 'true' })).toBe(false);
    expect(parse(null)).toBe(false);
  });
});
