import { describe, expect, it } from 'vitest';
import { STUDIO_COMPOSITION_LIMITS } from './composition';
import {
  productImageReferenceFileIds,
  productReferenceFileIds,
  referenceImageState,
  withDirectorProduct,
  withProductLook,
} from './productReferences';

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

describe('productImageReferenceFileIds', () => {
  // id(2) is the kit video: the lookup leaves out every file an image job will not take.
  const kinds = new Map([
    [id(1), 'ready' as const],
    [id(3), 'checking' as const],
  ]);

  it('drops videos, keeping the brief photo first', () => {
    expect(
      productImageReferenceFileIds(
        { brief: { productFileId: id(1) }, brandKit: { productFileIds: [id(2), id(3)] } },
        kinds
      )
    ).toEqual([id(1), id(3)]);
  });

  it('drops a video at the front of the kit before any cap slice, so it cannot take the only slot', () => {
    const refs = productImageReferenceFileIds({ brief: {}, brandKit: { productFileIds: [id(2), id(3)] } }, kinds);
    expect(refs.slice(0, 1)).toEqual([id(3)]);
  });

  it('drops a file the lookup left out', () => {
    expect(
      productImageReferenceFileIds({ brief: { productFileId: id(9) }, brandKit: { productFileIds: [id(3)] } }, kinds)
    ).toEqual([id(3)]);
  });

  it('is empty for a kit of only videos and no brief photo', () => {
    expect(productImageReferenceFileIds({ brief: {}, brandKit: { productFileIds: [id(2)] } }, kinds)).toEqual([]);
  });
});

describe('referenceImageState', () => {
  const file = { userId: 'u1', mimeType: 'image/png', filePath: 'files/a', moderationStatus: 'clean' };

  it('is ready for a clean PNG, JPEG or WebP the user owns, and checking while its safety check runs', () => {
    expect(referenceImageState(file, 'u1')).toBe('ready');
    expect(referenceImageState({ ...file, mimeType: 'image/jpeg; charset=binary' }, 'u1')).toBe('ready');
    expect(referenceImageState({ ...file, mimeType: 'image/webp', moderationStatus: 'scanning' }, 'u1')).toBe(
      'checking'
    );
    expect(referenceImageState({ ...file, moderationStatus: 'pending' }, 'u1')).toBe('checking');
  });

  it('is null for what the image job refuses', () => {
    expect(referenceImageState(file, 'u2')).toBeNull();
    expect(referenceImageState({ ...file, userId: null }, 'u1')).toBeNull();
    expect(referenceImageState({ ...file, deletedAt: new Date() }, 'u1')).toBeNull();
    expect(referenceImageState({ ...file, filePath: null }, 'u1')).toBeNull();
    expect(referenceImageState({ ...file, mimeType: 'image/gif' }, 'u1')).toBeNull();
    expect(referenceImageState({ ...file, mimeType: 'video/mp4' }, 'u1')).toBeNull();
    expect(referenceImageState({ ...file, moderationStatus: 'blocked' }, 'u1')).toBeNull();
    expect(referenceImageState({ ...file, moderationStatus: null }, 'u1')).toBeNull();
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

describe('withDirectorProduct', () => {
  it('makes the photo the look when the brand kit has no images', () => {
    expect(withDirectorProduct([], id(9))).toEqual([id(9)]);
  });

  it("keeps the user's look first and puts the photo second", () => {
    expect(withDirectorProduct([id(1), id(2)], id(9))).toEqual([id(1), id(9), id(2)]);
  });

  it('leaves the list unchanged when the photo is already in it', () => {
    expect(withDirectorProduct([id(1), id(2)], id(2))).toEqual([id(1), id(2)]);
  });

  it('stays within the cap, dropping the last image', () => {
    const max = STUDIO_COMPOSITION_LIMITS.brandProductFilesMax;
    const full = Array.from({ length: max }, (_, index) => id(index + 1));
    const next = withDirectorProduct(full, id(500));
    expect(next).toHaveLength(max);
    expect(next.slice(0, 2)).toEqual([id(1), id(500)]);
    expect(next).not.toContain(full[max - 1]);
  });
});
