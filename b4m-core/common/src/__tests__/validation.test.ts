import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { secureParameters } from '../validation';
import { UnprocessableEntityError, InternalServerError } from '../errors';

describe('secureParameters', () => {
  const schema = z.object({
    name: z.string(),
    age: z.number().int().positive(),
  });

  it('returns parsed data for valid input', () => {
    const result = secureParameters({ name: 'Alice', age: 30 }, schema);
    expect(result).toEqual({ name: 'Alice', age: 30 });
  });

  it('strips extra fields', () => {
    const result = secureParameters({ name: 'Bob', age: 25, extra: true }, schema);
    expect(result).toEqual({ name: 'Bob', age: 25 });
    expect(result).not.toHaveProperty('extra');
  });

  it('throws UnprocessableEntityError for invalid input', () => {
    expect(() => secureParameters({ name: 123, age: 'old' }, schema)).toThrow(UnprocessableEntityError);
  });

  it('includes field paths in error message', () => {
    try {
      secureParameters({ name: 123 }, schema);
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityError);
      expect((e as UnprocessableEntityError).message).toContain('name');
    }
  });

  it('throws InternalServerError for non-zod exceptions', () => {
    const badSchema = {
      parse() {
        throw new TypeError('unexpected');
      },
    } as unknown as z.ZodType;
    expect(() => secureParameters({}, badSchema)).toThrow(InternalServerError);
  });
});
