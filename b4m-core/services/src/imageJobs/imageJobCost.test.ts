import { describe, expect, it } from 'vitest';
import { ImageModels, type StoredImageRequest } from '@bike4mind/common';
import { estimateImageJobUsd } from './imageJobCost';

const FIRST_FILE_ID = 'a'.repeat(24);
const SECOND_FILE_ID = 'b'.repeat(24);
const MASK_FILE_ID = 'c'.repeat(24);

const request = (inputs: NonNullable<StoredImageRequest['inputs']>): StoredImageRequest => ({
  model: ImageModels.GPT_IMAGE_2,
  mode: 'generate',
  prompt: 'x',
  quality: 'medium',
  inputs,
});

describe('estimateImageJobUsd', () => {
  it('prices the same reference file listed twice as one input image', () => {
    const once = estimateImageJobUsd(request([{ role: 'reference', fileId: FIRST_FILE_ID }]));
    const twice = estimateImageJobUsd(
      request([
        { role: 'reference', fileId: FIRST_FILE_ID },
        { role: 'reference', fileId: FIRST_FILE_ID },
      ])
    );
    expect(twice).toBe(once);
  });

  it('prices distinct files as separate input images', () => {
    const once = estimateImageJobUsd(request([{ role: 'reference', fileId: FIRST_FILE_ID }]));
    const two = estimateImageJobUsd(
      request([
        { role: 'reference', fileId: FIRST_FILE_ID },
        { role: 'reference', fileId: SECOND_FILE_ID },
      ])
    );
    expect(two).toBeGreaterThan(once);
  });

  it('does not bill a mask as an input image', () => {
    const edit = request([{ role: 'edit_source', fileId: FIRST_FILE_ID }]);
    const masked = request([...(edit.inputs ?? []), { role: 'mask', fileId: MASK_FILE_ID }]);
    expect(estimateImageJobUsd({ ...masked, mode: 'edit' })).toBe(estimateImageJobUsd({ ...edit, mode: 'edit' }));
  });
});
