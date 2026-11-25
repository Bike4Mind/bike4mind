import { describe, expect, it } from 'vitest';
import { CreateImageJobBodySchema, ImageModels } from '@bike4mind/common';
import { toCreateImageJobBody } from './imageJobBody';

const fileId = 'a'.repeat(24);

describe('toCreateImageJobBody', () => {
  it('maps the domain request onto the public snake_case body with the count', () => {
    const body = toCreateImageJobBody(
      {
        model: ImageModels.GPT_IMAGE_2,
        mode: 'generate',
        prompt: 'A red bicycle',
        size: '1024x1024',
        aspectRatio: '1:1',
        quality: 'high',
        outputFormat: 'png',
        transparentBackground: false,
        seed: 7,
        inputs: [{ role: 'reference', fileId }],
      },
      3
    );
    expect(body).toEqual({
      model: 'gpt-image-2',
      mode: 'generate',
      prompt: 'A red bicycle',
      size: '1024x1024',
      aspect_ratio: '1:1',
      quality: 'high',
      output_format: 'png',
      transparent_background: false,
      seed: 7,
      inputs: [{ role: 'reference', file_id: fileId }],
      count: 3,
    });
    expect(CreateImageJobBodySchema.safeParse(body).success).toBe(true);
  });

  it('omits unset fields and never sets the payer itself', () => {
    const body = toCreateImageJobBody({ model: ImageModels.GPT_IMAGE_2, mode: 'generate', prompt: 'p' }, 1);
    expect(body).toEqual({ model: 'gpt-image-2', mode: 'generate', prompt: 'p', count: 1 });
    expect(body).not.toHaveProperty('organization_id');
  });

  it('refuses provider settings the public route cannot carry', () => {
    expect(() =>
      toCreateImageJobBody({ model: ImageModels.GPT_IMAGE_2, mode: 'generate', prompt: 'p', safetyTolerance: 1 }, 1)
    ).toThrow('provider safety');
  });

  it('refuses a count outside the contract bound', () => {
    expect(() => toCreateImageJobBody({ model: ImageModels.GPT_IMAGE_2, mode: 'generate', prompt: 'p' }, 0)).toThrow();
  });
});
