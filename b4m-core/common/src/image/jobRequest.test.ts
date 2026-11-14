import { describe, expect, it } from 'vitest';
import { ImageModels } from '../models';
import {
  IMAGE_JOB_EDIT_REGIONS_PAYLOAD_MAX,
  IMAGE_JOB_INPUTS_MAX,
  IMAGE_JOB_PROMPT_MAX_CHARS,
  ImageJobRequestSchema,
  imageJobInputs,
} from './jobRequest';

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
        { role: 'mask', fileId: 'b'.repeat(24) },
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
    [
      'the same file twice',
      {
        inputs: [
          { role: 'reference', fileId: FILE_ID },
          { role: 'edit_source', fileId: FILE_ID },
        ],
      },
    ],
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
    const inputs = Array.from({ length: IMAGE_JOB_INPUTS_MAX }, (_, i) => ({
      role: 'reference',
      fileId: i.toString(16).padStart(24, '0'),
    }));
    const prompt = 'x'.repeat(IMAGE_JOB_PROMPT_MAX_CHARS);
    expect(ImageJobRequestSchema.safeParse({ ...valid, inputs, prompt }).success).toBe(true);
  });
});

describe('ImageJobRequestSchema job-only models and edit regions', () => {
  const region = { prompt: 'make it blue', bbox: [0.1, 0.2, 0.8, 0.9] };

  it.each(['test-image', 'local-image/sdxl', 'local-image/models/v1.5:fp16'])('accepts the model %s', model => {
    expect(ImageJobRequestSchema.safeParse({ ...valid, model }).success).toBe(true);
  });

  it.each(['local-image/', 'local-image/   ', 'local-image'])('rejects the model %j', model => {
    expect(ImageJobRequestSchema.safeParse({ ...valid, model }).success).toBe(false);
  });

  it('accepts editRegions and keeps them', () => {
    const request = { ...valid, mode: 'edit', editRegions: [region] };
    expect(ImageJobRequestSchema.parse(request)).toEqual(request);
  });

  it('rejects an empty editRegions array and a malformed region', () => {
    expect(ImageJobRequestSchema.safeParse({ ...valid, editRegions: [] }).success).toBe(false);
    expect(ImageJobRequestSchema.safeParse({ ...valid, editRegions: [{ prompt: 'x', bbox: [0, 0, 1] }] }).success).toBe(
      false
    );
  });
});

describe('editRegions payload bound', () => {
  const region = { prompt: 'x', bbox: [0, 0, 0.5, 0.5] };
  const request = (count: number) => ({
    ...valid,
    mode: 'edit',
    editRegions: Array.from({ length: count }, () => region),
  });

  it('leaves the per-model cap to the catalog', () => {
    expect(ImageJobRequestSchema.safeParse(request(9)).success).toBe(true);
  });

  it('bounds the payload', () => {
    expect(ImageJobRequestSchema.safeParse(request(IMAGE_JOB_EDIT_REGIONS_PAYLOAD_MAX)).success).toBe(true);
    expect(ImageJobRequestSchema.safeParse(request(IMAGE_JOB_EDIT_REGIONS_PAYLOAD_MAX + 1)).success).toBe(false);
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
