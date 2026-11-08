import { describe, expect, it } from 'vitest';
import { ImageModels } from '../models';
import { IMAGE_JOB_INPUTS_MAX, IMAGE_JOB_PROMPT_MAX_CHARS, ImageJobRequestSchema, imageJobInputs } from './jobRequest';

const FILE_ID = 'a'.repeat(24);
const valid = { model: ImageModels.GPT_IMAGE_1, mode: 'generate', prompt: 'a red bicycle' } as const;

describe('ImageJobRequestSchema', () => {
  it('accepts a minimal request', () => {
    expect(ImageJobRequestSchema.parse(valid)).toEqual(valid);
  });

  it('accepts a fully specified edit request', () => {
    const request = {
      ...valid,
      mode: 'edit',
      inputs: [
        { role: 'edit_source', fileId: FILE_ID },
        { role: 'mask', fileId: FILE_ID },
      ],
      size: '1024x1024',
      aspectRatio: '1:1',
      quality: 'high',
      outputFormat: 'png',
      transparentBackground: true,
      seed: 0,
    };
    expect(ImageJobRequestSchema.parse(request)).toEqual(request);
  });

  it('trims the prompt', () => {
    expect(ImageJobRequestSchema.parse({ ...valid, prompt: '  hello  ' }).prompt).toBe('hello');
  });

  it.each([
    ['an empty prompt', { prompt: '' }],
    ['a whitespace-only prompt', { prompt: '   ' }],
    ['a prompt over the limit', { prompt: 'x'.repeat(IMAGE_JOB_PROMPT_MAX_CHARS + 1) }],
    ['an unknown model', { model: 'not-a-model' }],
    ['an unknown mode', { mode: 'inpaint' }],
    ['an unknown key', { count: 2 }],
    ['a malformed file id', { inputs: [{ role: 'reference', fileId: 'abc' }] }],
    ['an uppercase file id', { inputs: [{ role: 'reference', fileId: 'A'.repeat(24) }] }],
    ['an unknown input role', { inputs: [{ role: 'style', fileId: FILE_ID }] }],
    ['an unknown key on an input', { inputs: [{ role: 'reference', fileId: FILE_ID, url: 'https://x.test' }] }],
    ['a negative seed', { seed: -1 }],
    ['a fractional seed', { seed: 1.5 }],
    [
      'too many inputs',
      { inputs: Array.from({ length: IMAGE_JOB_INPUTS_MAX + 1 }, () => ({ role: 'reference', fileId: FILE_ID })) },
    ],
  ])('rejects %s', (_label, override) => {
    expect(ImageJobRequestSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });

  it('accepts the maximum number of inputs and a prompt at the limit', () => {
    const inputs = Array.from({ length: IMAGE_JOB_INPUTS_MAX }, () => ({ role: 'reference', fileId: FILE_ID }));
    const prompt = 'x'.repeat(IMAGE_JOB_PROMPT_MAX_CHARS);
    expect(ImageJobRequestSchema.safeParse({ ...valid, inputs, prompt }).success).toBe(true);
  });
});

describe('imageJobInputs', () => {
  it('returns an empty list when the request has no inputs', () => {
    expect(imageJobInputs({})).toEqual([]);
  });

  it('returns the request inputs', () => {
    const inputs = [{ role: 'reference' as const, fileId: FILE_ID }];
    expect(imageJobInputs({ inputs })).toBe(inputs);
  });
});
