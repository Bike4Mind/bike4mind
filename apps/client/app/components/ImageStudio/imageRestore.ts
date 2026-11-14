import { z } from 'zod';
import { IMAGE_INPUT_ROLES, ImageJobRequestSchema, resolveLegacyImageModel, type ImageModels } from '@bike4mind/common';
import type { ReferenceFile } from '@client/app/components/Studio/capabilityFields';
import {
  readStoredField,
  restoreInputFile,
  type Restored,
  type StudioRestoreRequest,
} from '@client/app/components/Studio/restore/studioRestore';
import type { ImageFormState } from './imageFields';
import { EMPTY_IMAGE_INTENT, imageModelCards, isCatalogImageModel, type ImageIntent } from './imageModelOptions';

export type RestoredImageForm = {
  form: ImageFormState;
  /** The model to pick, or undefined to leave the form on its default (a notice says why). */
  modelId: ImageModels | undefined;
};

const shape = ImageJobRequestSchema.shape;
// Lenient per entry: chat-made images store their own request shape, so one odd input should not void the rest.
const StoredInputSchema = z.object({ role: z.enum(IMAGE_INPUT_ROLES), fileId: z.string().min(1) });

// Create sets none of these; a take that used them is made again with the model's defaults.
const UNSET_IN_CREATE: Record<string, string> = {
  outputFormat: 'output format',
  transparentBackground: 'transparent background',
  seed: 'seed',
};

function restoreModel(
  stored: unknown,
  models: readonly { id: string; name: string }[],
  intent: ImageIntent,
  notices: string[]
): ImageModels | undefined {
  if (typeof stored !== 'string') {
    notices.push('The take did not record its model, so the default model is picked.');
    return undefined;
  }
  const successor = resolveLegacyImageModel(stored);
  if (successor !== stored && isCatalogImageModel(successor)) {
    notices.push(`${stored} is retired, so its successor ${successor} is picked instead.`);
  }
  const card = imageModelCards(models, intent).find(candidate => candidate.id === successor);
  if (!card) {
    notices.push(`${successor} is no longer one of your image models, so the default model is picked.`);
    return undefined;
  }
  if (card.unavailableReason !== null) {
    notices.push(`${card.name} cannot run in Create (${card.unavailableReason}), so the default model is picked.`);
    return undefined;
  }
  return isCatalogImageModel(card.id) ? card.id : undefined;
}

function restoreReferences(
  request: Record<string, unknown>,
  fileNames: StudioRestoreRequest['fileNames'],
  notices: string[]
) {
  const stored = z.array(z.unknown()).safeParse(request.inputs);
  if (!stored.success) return [];
  const references: ReferenceFile[] = [];
  for (const entry of stored.data) {
    const input = StoredInputSchema.safeParse(entry);
    if (!input.success) continue;
    const { role, fileId } = input.data;
    if (role === 'mask') {
      notices.push("Create does not take a mask, so the take's mask was left out.");
      continue;
    }
    const file = restoreInputFile(fileId, role, fileNames, notices);
    if (file && !references.some(reference => reference.fileId === fileId)) references.push(file);
  }
  return references;
}

/**
 * The image form for a stored image job request. Create only generates, so an edit's source comes back as a
 * reference image; values the picked model no longer takes stay in place for the form to mark with a fix.
 */
export function restoreImageForm(
  { request, fileNames }: StudioRestoreRequest,
  models: readonly { id: string; name: string }[]
): Restored<RestoredImageForm> {
  const notices: string[] = [];
  const prompt = readStoredField(shape.prompt, request.prompt, '', 'prompt', notices);
  if (request.mode === 'edit') {
    notices.push('Create makes new images rather than edits, so the edit source comes back as a reference image.');
  }
  const intent: ImageIntent = {
    ...EMPTY_IMAGE_INTENT,
    size: readStoredField(shape.size, request.size, undefined, 'size', notices),
    aspectRatio: readStoredField(shape.aspectRatio, request.aspectRatio, undefined, 'aspect ratio', notices),
    quality: readStoredField(shape.quality, request.quality, undefined, 'quality', notices),
    references: restoreReferences(request, fileNames, notices),
  };
  for (const [field, label] of Object.entries(UNSET_IN_CREATE)) {
    if (request[field] !== undefined) notices.push(`Create does not set the ${label}, so the model's default is used.`);
  }
  const modelId = restoreModel(request.model, models, intent, notices);
  return { value: { form: { prompt, count: 1, intent }, modelId }, notices };
}
