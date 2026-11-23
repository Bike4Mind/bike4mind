import { describe, expect, it } from 'vitest';
import { STUDIO_COMPOSITION_LIMITS } from './composition';
import { productReferenceFileIds, withProductLook } from './productReferences';

const id = (n: number): string => n.toString(16).padStart(24, '0');

describe('productReferenceFileIds', () => {
  it('puts the brief product photo ahead of the brand kit images', () => {
    expect(
      productReferenceFileIds({ brief: { productFileId: id(1) }, brandKit: { productFileIds: [id(2), id(3)] } })
    ).toEqual([id(1), id(2), id(3)]);
  });

  it('uses the brand kit images alone when the brief has no product photo', () => {
    expect(productReferenceFileIds({ brief: {}, brandKit: { productFileIds: [id(2)] } })).toEqual([id(2)]);
  });

  it('lists a file named in both places once, in the brief position', () => {
    expect(
      productReferenceFileIds({ brief: { productFileId: id(2) }, brandKit: { productFileIds: [id(1), id(2)] } })
    ).toEqual([id(2), id(1)]);
  });

  it('is empty when the production has no product images', () => {
    expect(productReferenceFileIds({ brief: {}, brandKit: { productFileIds: [] } })).toEqual([]);
  });
});

describe('withProductLook', () => {
  it('moves the look to the front without duplicating it', () => {
    expect(withProductLook([id(1), id(2), id(3)], id(3))).toEqual([id(3), id(1), id(2)]);
  });

  it('adds a new look in front of the existing images', () => {
    expect(withProductLook([id(1)], id(9))).toEqual([id(9), id(1)]);
  });

  it('drops the last image when the list is full', () => {
    const max = STUDIO_COMPOSITION_LIMITS.brandProductFilesMax;
    const full = Array.from({ length: max }, (_, index) => id(index + 1));
    const next = withProductLook(full, id(500));
    expect(next).toHaveLength(max);
    expect(next[0]).toBe(id(500));
    expect(next).not.toContain(full[max - 1]);
  });
});
