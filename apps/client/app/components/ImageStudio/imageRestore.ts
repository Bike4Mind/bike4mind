import { z } from 'zod';
import {
  IMAGE_INPUT_ROLES,
  ImageJobRequestSchema,
  resolveLegacyImageModel,
  type GeneratedAssetLineageRole,
  type ImageModels,
} from '@bike4mind/common';
import type { ReferenceFile } from '@client/app/components/Studio/capabilityFields';
import {
  readStoredField,
  restoreInputFile,
  roleNoun,
  type Restored,
  type StudioRestoreRequest,
} from '@client/app/components/Studio/restore/studioRestore';
import { STUDIO_IMAGE_COUNT_MAX } from '@client/app/hooks/data/studioImageJobs';
import type { ImageFormState } from './imageFields';
import { EMPTY_IMAGE_INTENT, imageModelCards, isCatalogImageModel, type ImageIntent } from './imageModelOptions';

export type RestoredImageForm = {
  form: ImageFormState;
  /** The model to pick, or undefined to leave the form on its default (a notice says why). */
  modelId: ImageModels | undefined;
};

const shape = ImageJobRequestSchema.shape;
const StoredInputSchema = z.object({ role: z.enum(IMAGE_INPUT_ROLES), fileId: z.string().min(1) });
const StoredCountSchema = z.number().int().min(1).max(STUDIO_IMAGE_COUNT_MAX);

/**
 * Two shapes are stored: the image job request (camelCase, inputs listed) and the chat tools' arguments
 * (snake_case, `n`, inputs only in the lineage). These are the keys the form reads from either.
 */
const READ_KEYS = new Set(['model', 'mode', 'prompt', 'inputs', 'size', 'aspectRatio', 'aspect_ratio', 'quality', 'n']);

// Labels for the stored keys Create has no control for; any other unread key is named as it is stored.
const UNSET_LABELS: Record<string, string> = {
  outputFormat: 'output format',
  output_format: 'output format',
  transparentBackground: 'background',
  background: 'background',
  width: 'width',
  height: 'height',
  seed: 'seed',
  safety_tolerance: 'safety tolerance',
  prompt_upsampling: 'prompt upsampling',
  steps: 'steps',
  guidance: 'guidance',
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

/** The request's own input list when it has one (image jobs), else the lineage's (chat edits record only that). */
function storedInputs(
  { request, lineageInputs }: StudioRestoreRequest,
  notices: string[]
): readonly { fileId: string; role: GeneratedAssetLineageRole }[] {
  if (request.inputs === undefined) return lineageInputs;
  const parsed = z.array(StoredInputSchema).safeParse(request.inputs);
  if (parsed.success) return parsed.data;
  notices.push("The take's input images could not be read, so choose them again.");
  return [];
}

function restoreReferences(restore: StudioRestoreRequest, notices: string[]): ReferenceFile[] {
  const references: ReferenceFile[] = [];
  const inputs = storedInputs(restore, notices);
  if (inputs.some(input => input.role === 'edit_source')) {
    notices.push('Create makes new images rather than edits, so the edit source comes back as a reference image.');
  }
  for (const { role, fileId } of inputs) {
    if (role !== 'reference' && role !== 'edit_source') {
      notices.push(`Create does not take a ${roleNoun(role)}, so the take's was left out.`);
      continue;
    }
    const file = restoreInputFile(fileId, role, restore.fileNames, notices);
    if (file && !references.some(reference => reference.fileId === fileId)) references.push(file);
  }
  return references;
}

function noticeUnsetKeys(request: Record<string, unknown>, notices: string[]) {
  const labels = new Set(
    Object.keys(request)
      .filter(key => !READ_KEYS.has(key) && request[key] !== undefined)
      .map(key => UNSET_LABELS[key] ?? key)
  );
  if (labels.size > 0) {
    notices.push(`Create does not set the ${[...labels].join(', ')}, so the model's defaults are used.`);
  }
}

/**
 * The image form for a stored image request. Create only generates, so an edit's source comes back as a reference
 * image; values the picked model no longer takes stay in place for the form to mark with a fix.
 */
export function restoreImageForm(
  restore: StudioRestoreRequest,
  models: readonly { id: string; name: string }[]
): Restored<RestoredImageForm> {
  const { request } = restore;
  const notices: string[] = [];
  const prompt = readStoredField(shape.prompt, request.prompt, '', 'prompt', notices);
  const intent: ImageIntent = {
    ...EMPTY_IMAGE_INTENT,
    size: readStoredField(shape.size, request.size, undefined, 'size', notices),
    aspectRatio: readStoredField(
      shape.aspectRatio,
      request.aspectRatio ?? request.aspect_ratio,
      undefined,
      'aspect ratio',
      notices
    ),
    quality: readStoredField(shape.quality, request.quality, undefined, 'quality', notices),
    references: restoreReferences(restore, notices),
  };
  const count = readStoredField(StoredCountSchema, request.n, 1, 'image count', notices);
  noticeUnsetKeys(request, notices);
  const modelId = restoreModel(request.model, models, intent, notices);
  return { value: { form: { prompt, count, intent }, modelId }, notices };
}
