// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { productIdSchema } from './productId';

describe('productIdSchema', () => {
  it.each(['bike4mind', 'Bike4Mind', 'source_product', '1source', 'a-b_C', 'a'.repeat(64)])('accepts %s', id => {
    expect(productIdSchema.safeParse(id).success).toBe(true);
  });

  it.each(['', 'a'.repeat(65), 'a.b', 'a b', 'a/b', '../etc', 'café'])('refuses %s', id => {
    expect(productIdSchema.safeParse(id).success).toBe(false);
  });
});
