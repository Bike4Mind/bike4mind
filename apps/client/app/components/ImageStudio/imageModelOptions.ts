/**
 * The Studio image form's choices, read from the capability catalog (b4m-core/common/src/image/catalog.ts) and
 * checked with its validator, so a model that cannot honour the request is shown disabled with its why-not reason.
 */
import {
  IMAGE_MODEL_CATALOG,
  ImageModels,
  getImageModelCatalogEntry,
  validateImageRequest,
  type ImageCapabilityRequest,
} from '@bike4mind/common';

/** What the form asks for besides the model; size and aspect ratio are absent when left on the model's default. */
export type ImageIntent = { count: number; size?: string; aspectRatio?: string };

export type ImageModelOption = {
  model: ImageModels;
  label: string;
  // Why this model cannot make the current request, or null when it can.
  disabledReason: string | null;
};

// Offered on a model that takes any ratio within a range; the validator keeps the ones inside it.
const COMMON_ASPECT_RATIOS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9', '9:21'] as const;

// Intent first: the form opens on the first of these the user can run. OpenAI and Gemini lead because their Studio
// job providers are wired; the others may answer model_unavailable until theirs are.
const DEFAULT_MODEL_PREFERENCE: readonly ImageModels[] = [
  ImageModels.GPT_IMAGE_1_5,
  ImageModels.GPT_IMAGE_2,
  ImageModels.GEMINI_3_1_FLASH_IMAGE,
];

export const isCatalogImageModel = (id: string): id is ImageModels => Object.hasOwn(IMAGE_MODEL_CATALOG, id);

const toCapabilityRequest = ({ count, size, aspectRatio }: ImageIntent): ImageCapabilityRequest => ({
  mode: 'generate',
  count,
  ...(size && { size }),
  ...(aspectRatio && { aspectRatio }),
});

/** Every reason `model` cannot make `intent`, joined into one sentence list, or null when it can. */
export const imageModelWhyNot = (model: ImageModels, intent: ImageIntent): string | null => {
  const result = validateImageRequest(toCapabilityRequest(intent), getImageModelCatalogEntry(model));
  return result.ok ? null : result.failures.map(failure => failure.reason).join(' ');
};

/** The user's runnable image models (from /api/models) that the catalog knows, each checked against `intent`. */
export const buildImageModelOptions = (
  available: readonly { id: string; name: string }[],
  intent: ImageIntent
): ImageModelOption[] =>
  available.flatMap(({ id, name }) =>
    isCatalogImageModel(id) ? [{ model: id, label: name, disabledReason: imageModelWhyNot(id, intent) }] : []
  );

/** The model the form opens on: the first preferred model on offer, else the first that can generate at all. */
export const pickDefaultImageModel = (options: readonly ImageModelOption[]): ImageModels | undefined => {
  const usable = options.filter(option => option.disabledReason === null).map(option => option.model);
  return DEFAULT_MODEL_PREFERENCE.find(model => usable.includes(model)) ?? usable[0];
};

/** The sizes `model` offers by name; empty when its size follows the aspect ratio, the input image, or is fixed. */
export const imageSizeOptions = (model: ImageModels): readonly string[] => {
  const { sizing } = getImageModelCatalogEntry(model);
  return sizing.kind === 'presets' || sizing.kind === 'constrained' || sizing.kind === 'dimensions'
    ? sizing.presets
    : [];
};

/** The aspect ratios `model` takes when generating; empty when it takes none. */
export const imageAspectRatioOptions = (model: ImageModels): readonly string[] => {
  const ratios = getImageModelCatalogEntry(model).modes.generate?.aspectRatios;
  if (!ratios) return [];
  if (ratios.kind === 'discrete') return ratios.values;
  return COMMON_ASPECT_RATIOS.filter(aspectRatio => imageModelWhyNot(model, { count: 1, aspectRatio }) === null);
};
