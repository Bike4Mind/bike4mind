import { describe, expect, it } from 'vitest';
import { findInputImage, type ResolvedInputImage } from './types';

describe('findInputImage', () => {
  const reference: ResolvedInputImage = { role: 'reference', bytes: Buffer.from('r'), mimeType: 'image/png' };
  const firstFrame: ResolvedInputImage = { role: 'first_frame', bytes: Buffer.from('f'), mimeType: 'image/png' };

  it('picks the image by role, wherever it sits in the list', () => {
    expect(findInputImage({ images: [reference, firstFrame] }, 'first_frame')).toBe(firstFrame);
  });

  it('returns undefined when no image has the role, or there are no images', () => {
    expect(findInputImage({ images: [reference] }, 'first_frame')).toBeUndefined();
    expect(findInputImage({}, 'first_frame')).toBeUndefined();
  });
});
