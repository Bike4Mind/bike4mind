import { describe, expect, it, vi } from 'vitest';
import type { CapabilityControl, CapabilityField } from '@client/app/components/Studio/capabilityFields';
import { discreteModel, optionalAudioModel, rangeModel } from '@client/app/hooks/data/__test__/videoGenerationFixtures';
import { videoCapabilityFields } from './videoFields';
import { initialFormFor } from './videoForm';

const flatten = (fields: CapabilityField[]): CapabilityControl[] =>
  fields.flatMap(field => (field.kind === 'group' ? [...field.fields] : [field]));

const fieldOf = (fields: CapabilityField[], id: string): CapabilityControl => {
  const field = flatten(fields).find(candidate => candidate.id === id);
  if (!field) throw new Error(`no ${id} field`);
  return field;
};

const actions = () => ({ update: vi.fn(), pickImage: vi.fn() });

describe('videoCapabilityFields', () => {
  it('lays out the video controls in their display order', () => {
    const fields = videoCapabilityFields(rangeModel, initialFormFor(rangeModel), actions());
    expect(flatten(fields).map(field => `${field.kind}:${field.id}`)).toEqual([
      'segmented:mode',
      'text:prompt',
      'range:duration',
      'select:aspect',
      'select:resolution',
      'note:audio',
    ]);
  });

  it('offers the image picker only in image to video, and leaving that mode drops the image', () => {
    const form = { ...initialFormFor(rangeModel), mode: 'image_to_video' as const };
    const withImage = { ...form, inputImage: { fileId: 'f1', fileName: 'harbor.png' } };
    const handlers = actions();
    const fields = videoCapabilityFields(rangeModel, withImage, handlers);
    expect(fieldOf(fields, 'image')).toMatchObject({ kind: 'image', fileName: 'harbor.png' });

    const mode = fieldOf(fields, 'mode');
    if (mode.kind !== 'segmented') throw new Error('mode is segmented');
    mode.onChange('text_to_video');
    expect(handlers.update).toHaveBeenCalledWith({ mode: 'text_to_video', inputImage: null });

    const textOnly = videoCapabilityFields(rangeModel, initialFormFor(rangeModel), actions());
    expect(flatten(textOnly).some(field => field.id === 'image')).toBe(false);
  });

  it('turns a discrete duration into choices and ignores a value the model does not offer', () => {
    const handlers = actions();
    const duration = fieldOf(videoCapabilityFields(discreteModel, initialFormFor(discreteModel), handlers), 'duration');
    if (duration.kind !== 'segmented') throw new Error('a discrete duration is segmented');
    expect(duration.options.map(option => option.value)).toEqual(['4', '6', '8']);
    expect(duration.label).toBe('Duration: 4s');
    duration.onChange('5');
    expect(handlers.update).not.toHaveBeenCalled();
    duration.onChange('8');
    expect(handlers.update).toHaveBeenCalledWith({ durationSeconds: 8 });
  });

  it('bounds a range duration by the model', () => {
    const duration = fieldOf(videoCapabilityFields(rangeModel, initialFormFor(rangeModel), actions()), 'duration');
    expect(duration).toMatchObject({ kind: 'range', min: 1, max: 15, step: 1, value: 6 });
  });

  it('offers an audio switch only where audio is optional', () => {
    const handlers = actions();
    const optional = fieldOf(
      videoCapabilityFields(optionalAudioModel, initialFormFor(optionalAudioModel), handlers),
      'audio'
    );
    expect(optional).toMatchObject({ kind: 'switch', checked: true });
    if (optional.kind !== 'switch') throw new Error('audio is a switch');
    optional.onChange(false);
    expect(handlers.update).toHaveBeenCalledWith({ audio: false });
    const always = fieldOf(videoCapabilityFields(rangeModel, initialFormFor(rangeModel), actions()), 'audio');
    expect(always).toMatchObject({ kind: 'note', label: 'Audio is included.' });
  });

  it('only accepts aspect ratios and resolutions the model offers', () => {
    const handlers = actions();
    const fields = videoCapabilityFields(discreteModel, initialFormFor(discreteModel), handlers);
    const aspect = fieldOf(fields, 'aspect');
    if (aspect.kind !== 'select') throw new Error('aspect is a select');
    aspect.onChange('21:9');
    expect(handlers.update).not.toHaveBeenCalled();
    aspect.onChange('9:16');
    expect(handlers.update).toHaveBeenCalledWith({ aspectRatio: '9:16' });

    handlers.update.mockClear();
    const resolution = fieldOf(fields, 'resolution');
    if (resolution.kind !== 'select') throw new Error('resolution is a select');
    resolution.onChange('4k');
    expect(handlers.update).not.toHaveBeenCalled();
    resolution.onChange('720p');
    expect(handlers.update).toHaveBeenCalledWith({ resolution: '720p' });
  });
});
