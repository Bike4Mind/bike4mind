import { describe, expect, it } from 'vitest';
import { discreteModel, optionalAudioModel, rangeModel } from '@client/app/hooks/data/__test__/videoGenerationFixtures';
import type { StudioRestoreRequest } from '@client/app/components/Studio/restore/studioRestore';
import type { NonEmptyList } from '@client/app/components/Studio/useCapabilityFormState';
import { initialFormFor } from './videoForm';
import { restoreVideoForm } from './videoRestore';

const MODELS: NonEmptyList<typeof rangeModel> = [rangeModel, discreteModel, optionalAudioModel];

const restoreOf = (
  request: Record<string, unknown>,
  fileNames: StudioRestoreRequest['fileNames'] = {}
): StudioRestoreRequest => ({ medium: 'video', request, fileNames });

describe('restoreVideoForm', () => {
  it('fills every control of a stored video request, with its first frame as the starting image', () => {
    const { value, notices } = restoreVideoForm(
      restoreOf(
        {
          model: discreteModel.id,
          mode: 'image_to_video',
          prompt: 'waves rolling in',
          durationSeconds: 8,
          aspectRatio: '9:16',
          resolution: '1080p',
          inputs: [{ role: 'first_frame', fileId: 'frame-1' }],
        },
        { 'frame-1': 'harbor.png' }
      ),
      MODELS
    );

    expect(value).toEqual({
      modelId: discreteModel.id,
      mode: 'image_to_video',
      prompt: 'waves rolling in',
      durationSeconds: 8,
      aspectRatio: '9:16',
      resolution: '1080p',
      audio: null,
      inputImage: { fileId: 'frame-1', fileName: 'harbor.png' },
    });
    expect(notices).toEqual([]);
  });

  it('reads the legacy single-image field as the first frame', () => {
    const { value } = restoreVideoForm(
      restoreOf({ model: rangeModel.id, mode: 'image_to_video', prompt: 'x', inputImageFileId: 'frame-1' }),
      MODELS
    );
    expect(value.inputImage).toEqual({ fileId: 'frame-1', fileName: 'First frame' });
  });

  it('restores audio only for a model where it is optional', () => {
    expect(
      restoreVideoForm(restoreOf({ model: optionalAudioModel.id, prompt: 'x', audio: false }), MODELS).value.audio
    ).toBe(false);
    expect(
      restoreVideoForm(restoreOf({ model: rangeModel.id, prompt: 'x', audio: false }), MODELS).value.audio
    ).toBeNull();
  });

  it('names each input Create cannot take yet', () => {
    const { value, notices } = restoreVideoForm(
      restoreOf({
        model: rangeModel.id,
        mode: 'image_to_video',
        prompt: 'x',
        inputs: [
          { role: 'first_frame', generatedImageKey: 'chat/key.png' },
          { role: 'last_frame', fileId: 'frame-2' },
          { role: 'reference', fileId: 'ref-1' },
          { role: 'style', fileId: 'style-1' },
        ],
      }),
      MODELS
    );

    expect(value.inputImage).toBeNull();
    expect(notices).toEqual([
      "The take's first frame was a chat image, which is not in Files; choose a first frame again.",
      "Create does not take a last frame yet, so the take's was left out.",
      "Create does not take a reference image yet, so the take's was left out.",
      "Create does not take a style image yet, so the take's was left out.",
    ]);
  });

  it('falls back to the first model and its defaults when the stored model or a value is gone, with notices', () => {
    const { value, notices } = restoreVideoForm(
      restoreOf({ model: 'retired-video-model', prompt: 'x', aspectRatio: '5:4', inputs: 'broken' }),
      MODELS
    );

    expect(value).toEqual({ ...initialFormFor(rangeModel), prompt: 'x' });
    expect(notices).toEqual([
      `retired-video-model is no longer one of your video models, so ${rangeModel.display_name} is picked.`,
      "The take's input images could not be read, so choose them again.",
      "The take's aspect ratio (5:4) is no longer valid, so the default is used.",
    ]);
  });

  it('keeps a value the picked model does not take, for the Create v2 form to mark', () => {
    const { value, notices } = restoreVideoForm(
      restoreOf({ model: discreteModel.id, prompt: 'x', aspectRatio: '1:1' }),
      MODELS
    );
    expect(value.aspectRatio).toBe('1:1');
    expect(notices).toEqual([]);
  });
});
