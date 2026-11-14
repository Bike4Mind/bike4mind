import { z } from 'zod';
import { VideoGenerationRequestSchema, VideoInputSchema, videoRequestInputs, type VideoModel } from '@bike4mind/common';
import {
  readStoredField,
  restoreInputFile,
  roleNoun,
  type Restored,
  type StudioRestoreRequest,
} from '@client/app/components/Studio/restore/studioRestore';
import type { NonEmptyList } from '@client/app/components/Studio/useCapabilityFormState';
import { initialFormFor, type VideoFormState, type VideoInputImage } from './videoForm';

const shape = VideoGenerationRequestSchema.shape;
const StoredInputsSchema = z.object({
  inputs: z.array(VideoInputSchema).optional(),
  inputImageFileId: shape.inputImageFileId,
  inputGeneratedImageKey: shape.inputGeneratedImageKey,
});

function restoreModel(stored: unknown, models: NonEmptyList<VideoModel>, notices: string[]): VideoModel {
  const model = models.find(candidate => candidate.id === stored);
  if (model) return model;
  const fallback = models[0];
  notices.push(
    typeof stored === 'string'
      ? `${stored} is no longer one of your video models, so ${fallback.display_name} is picked.`
      : `The take did not record its model, so ${fallback.display_name} is picked.`
  );
  return fallback;
}

/** The take's first frame, the one input Create takes; every other input is named in a notice. */
function restoreFirstFrame(
  request: Record<string, unknown>,
  fileNames: StudioRestoreRequest['fileNames'],
  notices: string[]
): VideoInputImage | null {
  const stored = StoredInputsSchema.safeParse(request);
  if (!stored.success) {
    notices.push("The take's input images could not be read, so choose them again.");
    return null;
  }
  let firstFrame: VideoInputImage | null = null;
  for (const input of videoRequestInputs(stored.data)) {
    if (input.role !== 'first_frame') {
      notices.push(`Create does not take a ${roleNoun(input.role)} yet, so the take's was left out.`);
    } else if (!('fileId' in input)) {
      notices.push("The take's first frame was a chat image, which is not in Files; choose a first frame again.");
    } else if (!firstFrame) {
      firstFrame = restoreInputFile(input.fileId, input.role, fileNames, notices);
    }
  }
  return firstFrame;
}

/**
 * The video form for a stored video request. Values the picked model does not take are kept, for Create v2's form
 * to mark with a fix; a value no longer valid anywhere falls back to the model's default with a notice.
 */
export function restoreVideoForm(
  { request, fileNames }: StudioRestoreRequest,
  models: NonEmptyList<VideoModel>
): Restored<VideoFormState> {
  const notices: string[] = [];
  const model = restoreModel(request.model, models, notices);
  const base = initialFormFor(model);
  const inputImage = restoreFirstFrame(request, fileNames, notices);
  const audio = readStoredField(z.boolean(), request.audio, base.audio, 'audio setting', notices);
  const value: VideoFormState = {
    ...base,
    mode: readStoredField(shape.mode, request.mode, base.mode, 'mode', notices),
    prompt: readStoredField(shape.prompt, request.prompt, base.prompt, 'prompt', notices),
    durationSeconds: readStoredField(
      shape.durationSeconds,
      request.durationSeconds,
      base.durationSeconds,
      'duration',
      notices
    ),
    aspectRatio: readStoredField(shape.aspectRatio, request.aspectRatio, base.aspectRatio, 'aspect ratio', notices),
    resolution: readStoredField(shape.resolution, request.resolution, base.resolution, 'resolution', notices),
    // The form holds audio only for a model where it is optional; elsewhere the model decides.
    audio: model.audio === 'optional' ? audio : null,
    inputImage,
  };
  return { value, notices };
}
