import { describe, expect, it } from 'vitest';
import { designTokensSchema, hexColorSchema, rgbaColorSchema } from './schema';
import { designTokens } from './tokens';

describe('designTokensSchema', () => {
  it('accepts the canonical token set', () => {
    // designTokens is already the parsed output; re-parsing proves the data
    // round-trips the schema (no coercion, no stripped keys).
    expect(designTokensSchema.parse(designTokens)).toEqual(designTokens);
  });

  it('rejects a malformed color', () => {
    expect(hexColorSchema.safeParse('#12345').success).toBe(false);
    expect(hexColorSchema.safeParse('red').success).toBe(false);
    expect(rgbaColorSchema.safeParse('rgba(300 1 1 / 0.5)').success).toBe(false);
  });

  it('rejects unknown keys in a semantic scheme', () => {
    const mutated = structuredClone(designTokens);
    (mutated.color.schemes.light.text as Record<string, string>).quaternary = '#123456';
    expect(designTokensSchema.safeParse(mutated).success).toBe(false);
  });

  it('rejects a missing required token', () => {
    const mutated = structuredClone(designTokens);
    delete (mutated.color.schemes.dark as Partial<typeof mutated.color.schemes.dark>).divider;
    expect(designTokensSchema.safeParse(mutated).success).toBe(false);
  });
});
