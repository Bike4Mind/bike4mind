import { describe, expect, it } from 'vitest';
import { ImageModels } from '@bike4mind/common';
import type { StudioRestoreRequest } from '@client/app/components/Studio/restore/studioRestore';
import { restoreImageForm } from './imageRestore';

const MODELS = [
  { id: ImageModels.GPT_IMAGE_2, name: 'GPT Image 2' },
  { id: ImageModels.GEMINI_3_1_FLASH_IMAGE, name: 'Nano Banana 2' },
  { id: ImageModels.FLUX_PRO_ULTRA, name: 'FLUX Ultra' },
];
const CAT = 'a'.repeat(24);
const DOG = 'b'.repeat(24);

const restoreOf = (
  request: Record<string, unknown>,
  fileNames: StudioRestoreRequest['fileNames'] = {}
): StudioRestoreRequest => ({ medium: 'image', request, fileNames });

describe('restoreImageForm', () => {
  it('fills the prompt, model, shape, quality and references of a stored image job request', () => {
    const { value, notices } = restoreImageForm(
      restoreOf(
        {
          model: ImageModels.GEMINI_3_1_FLASH_IMAGE,
          mode: 'generate',
          prompt: 'a cat on a windowsill',
          aspectRatio: '16:9',
          size: '1024x1024',
          quality: 'high',
          inputs: [{ role: 'reference', fileId: CAT }],
        },
        { [CAT]: 'cat.png' }
      ),
      MODELS
    );

    expect(value).toEqual({
      modelId: ImageModels.GEMINI_3_1_FLASH_IMAGE,
      form: {
        prompt: 'a cat on a windowsill',
        count: 1,
        intent: {
          size: '1024x1024',
          aspectRatio: '16:9',
          quality: 'high',
          references: [{ fileId: CAT, fileName: 'cat.png' }],
        },
      },
    });
    expect(notices).toEqual([]);
  });

  it('picks the successor of a retired model and says so', () => {
    const { value, notices } = restoreImageForm(
      restoreOf({ model: ImageModels.GPT_IMAGE_1, mode: 'generate', prompt: 'x' }),
      MODELS
    );
    expect(value.modelId).toBe(ImageModels.GPT_IMAGE_2);
    expect(notices).toEqual([
      `${ImageModels.GPT_IMAGE_1} is retired, so its successor ${ImageModels.GPT_IMAGE_2} is picked instead.`,
    ]);
  });

  it('leaves the form on its default model, with the reason, when the stored one cannot be picked', () => {
    const missing = restoreImageForm(restoreOf({ model: ImageModels.GPT_IMAGE_1_5, prompt: 'x' }), MODELS);
    expect(missing.value.modelId).toBeUndefined();
    expect(missing.notices).toEqual([
      `${ImageModels.GPT_IMAGE_1_5} is no longer one of your image models, so the default model is picked.`,
    ]);

    const unavailable = restoreImageForm(restoreOf({ model: ImageModels.FLUX_PRO_ULTRA, prompt: 'x' }), MODELS);
    expect(unavailable.value.modelId).toBeUndefined();
    expect(unavailable.notices).toEqual([
      'FLUX Ultra cannot run in Create (Temporarily unavailable in Studio.), so the default model is picked.',
    ]);

    expect(restoreImageForm(restoreOf({ prompt: 'x' }), MODELS).notices).toEqual([
      'The take did not record its model, so the default model is picked.',
    ]);
  });

  it('brings an edit source back as a reference and names what Create cannot take', () => {
    const { value, notices } = restoreImageForm(
      restoreOf(
        {
          model: ImageModels.GPT_IMAGE_2,
          mode: 'edit',
          prompt: 'make it blue',
          inputs: [
            { role: 'edit_source', fileId: CAT },
            { role: 'mask', fileId: DOG },
          ],
          seed: 7,
          outputFormat: 'webp',
        },
        { [CAT]: 'cat.png', [DOG]: 'mask.png' }
      ),
      MODELS
    );

    expect(value.form.intent.references).toEqual([{ fileId: CAT, fileName: 'cat.png' }]);
    expect(notices).toEqual([
      'Create makes new images rather than edits, so the edit source comes back as a reference image.',
      "Create does not take a mask, so the take's mask was left out.",
      "Create does not set the output format, so the model's default is used.",
      "Create does not set the seed, so the model's default is used.",
    ]);
  });

  it('leaves out an input the user can no longer read, and names one outside the trail by its role', () => {
    const { value, notices } = restoreImageForm(
      restoreOf(
        {
          model: ImageModels.GPT_IMAGE_2,
          prompt: 'x',
          inputs: [
            { role: 'reference', fileId: CAT },
            { role: 'reference', fileId: DOG },
          ],
        },
        { [CAT]: null }
      ),
      MODELS
    );

    expect(value.form.intent.references).toEqual([{ fileId: DOG, fileName: 'Reference image' }]);
    expect(notices).toEqual(["The take's reference image is no longer available to you, so it was left out."]);
  });

  it('falls back from a stored value that is no longer valid, with a notice', () => {
    const { value, notices } = restoreImageForm(
      restoreOf({ model: ImageModels.GPT_IMAGE_2, prompt: 'x', quality: 'ultra' }),
      MODELS
    );
    expect(value.form.intent.quality).toBeUndefined();
    expect(notices).toEqual(["The take's quality (ultra) is no longer valid, so the default is used."]);
  });
});
