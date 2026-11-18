/**
 * The Studio image form's choices, read from the capability catalog (b4m-core/common/src/image/catalog.ts) and
 * checked with its validator, so a model that cannot honour the request is greyed with its why-not reason. Prices
 * come from the same cost tables the credit hold uses (@bike4mind/services/imageCost).
 */
import {
  IMAGE_MODEL_CATALOG,
  IMAGE_MODEL_STRENGTHS,
  IMAGE_PROVIDER_LABELS,
  type ImageModels,
  getImageModelCatalogEntry,
  rankImageModels,
  resolveLegacyImageModel,
  usdToCredits,
  validateImageRequest,
  type ImageCapabilityRequest,
  type ImageInputRole,
  type ImageMode,
  type ImageRequestField,
  type OpenAIImageQuality,
} from '@bike4mind/common';
import { UnsupportedImageModelError, estimateImageUsd, resolveBilledImageQuality } from '@bike4mind/services/imageCost';
import type { ReferenceFile } from '@client/app/components/Studio/capabilityFields';
import { rankedCardFit, type StudioModelCard } from '@client/app/components/Studio/studioModelCard';

/**
 * What the form asks for besides the prompt. size, aspectRatio and quality are absent when left on the model's
 * default. Kept across a model switch: a value the new model does not take is marked, never dropped. editSource and
 * mask are only sent in edit mode, and kept across a switch back to generate so returning to edit restores them.
 */
export type ImageIntent = {
  mode: ImageMode;
  size?: string;
  aspectRatio?: string;
  quality?: OpenAIImageQuality;
  references: readonly ReferenceFile[];
  editSource?: ReferenceFile;
  mask?: ReferenceFile;
};

export const EMPTY_IMAGE_INTENT: ImageIntent = { mode: 'generate', references: [] };

/** The role-tagged files the intent sends, in the order the job takes them: the source first, then mask, references. */
export const imageIntentInputs = (intent: ImageIntent): { role: ImageInputRole; file: ReferenceFile }[] => [
  ...(intent.mode === 'edit' && intent.editSource ? [{ role: 'edit_source' as const, file: intent.editSource }] : []),
  ...(intent.mode === 'edit' && intent.mask ? [{ role: 'mask' as const, file: intent.mask }] : []),
  ...intent.references.map(file => ({ role: 'reference' as const, file })),
];

// Offered on a model that takes any ratio within a range; the validator keeps the ones inside it.
const COMMON_ASPECT_RATIOS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9', '9:21'] as const;

export const isCatalogImageModel = (id: string): id is ImageModels => Object.hasOwn(IMAGE_MODEL_CATALOG, id);

// Count 1, as createImageJobs validates: "make N" is N one-image jobs, bounded by STUDIO_IMAGE_COUNT_MAX.
// An edit with no source yet is checked as if it had one, so the cards rank by what the model can edit, and the
// missing source is the form's own prompt to pick one rather than a reason against every model.
const toCapabilityRequest = (intent: ImageIntent): ImageCapabilityRequest => {
  const { mode, size, aspectRatio, quality } = intent;
  const roles = imageIntentInputs(intent).map(({ role }) => role);
  if (mode === 'edit' && !intent.editSource) roles.unshift('edit_source');
  return {
    mode,
    count: 1,
    ...(size && { size }),
    ...(aspectRatio && { aspectRatio }),
    ...(quality && { quality }),
    ...(roles.length > 0 && { inputs: roles.map(role => ({ role })) }),
  };
};

const failuresOf = (model: ImageModels, intent: ImageIntent) => {
  const result = validateImageRequest(toCapabilityRequest(intent), getImageModelCatalogEntry(model));
  return result.ok ? [] : result.failures;
};

/** Every reason `model` cannot make `intent`, joined into one sentence list, or null when it can. */
export const imageModelWhyNot = (model: ImageModels, intent: ImageIntent): string | null => {
  const failures = failuresOf(model, intent);
  return failures.length === 0 ? null : failures.map(failure => failure.reason).join(' ');
};

/** Why `model` cannot run in `mode` at all, whatever else is asked, or null when it can. */
export const imageModelUnavailableReason = (model: ImageModels, mode: ImageMode): string | null => {
  // The job route serves a retired id under its successor only, so the retired id itself never runs.
  if (resolveLegacyImageModel(model) !== model) return 'Retired. Pick its successor instead.';
  const unsupported = failuresOf(model, { ...EMPTY_IMAGE_INTENT, mode }).filter(
    failure => failure.code === 'unsupported_mode'
  );
  return unsupported.length > 0 ? unsupported.map(failure => failure.reason).join(' ') : null;
};

export type ImageProblemField = 'size' | 'aspect' | 'quality' | 'references' | 'editSource' | 'mask';

const PROBLEM_FIELD: Partial<Record<ImageRequestField, ImageProblemField>> = {
  size: 'size',
  aspectRatio: 'aspect',
  quality: 'quality',
  inputs: 'references',
};

const INPUT_PROBLEM_FIELD: Record<ImageInputRole, ImageProblemField> = {
  edit_source: 'editSource',
  mask: 'mask',
  reference: 'references',
};

/** The why-not reason for each form value `model` does not take, keyed by the field that holds it. */
export const imageFieldProblems = (
  model: ImageModels,
  intent: ImageIntent
): Partial<Record<ImageProblemField, string>> => {
  const problems: Partial<Record<ImageProblemField, string>> = {};
  for (const failure of failuresOf(model, intent)) {
    const field = failure.role ? INPUT_PROBLEM_FIELD[failure.role] : PROBLEM_FIELD[failure.field];
    if (field) problems[field] = problems[field] ? `${problems[field]} ${failure.reason}` : failure.reason;
  }
  return problems;
};

/** The sizes `model` offers by name; empty when its size follows the aspect ratio, the input image, or is fixed. */
export const imageSizeOptions = (model: ImageModels): readonly string[] => {
  const { sizing } = getImageModelCatalogEntry(model);
  return sizing.kind === 'presets' || sizing.kind === 'constrained' || sizing.kind === 'dimensions'
    ? sizing.presets
    : [];
};

/** The aspect ratios `model` takes in `mode`; empty when it takes none. */
export const imageAspectRatioOptions = (model: ImageModels, mode: ImageMode): readonly string[] => {
  const ratios = getImageModelCatalogEntry(model).modes[mode]?.aspectRatios;
  if (!ratios) return [];
  if (ratios.kind === 'discrete') return ratios.values;
  return COMMON_ASPECT_RATIOS.filter(
    aspectRatio => imageModelWhyNot(model, { ...EMPTY_IMAGE_INTENT, mode, aspectRatio }) === null
  );
};

export const imageQualityOptions = (model: ImageModels): readonly OpenAIImageQuality[] =>
  getImageModelCatalogEntry(model).qualities;

/** The most reference images `model` takes in `mode`; 0 when it takes none. */
export const imageReferenceMax = (model: ImageModels, mode: ImageMode): number =>
  getImageModelCatalogEntry(model).modes[mode]?.inputs.reference?.max ?? 0;

/** Whether `model` takes a mask when editing, and whether it needs one (FLUX Fill only fills a masked area). */
export const imageMaskSupport = (model: ImageModels): 'none' | 'optional' | 'required' => {
  const mask = getImageModelCatalogEntry(model).modes.edit?.inputs.mask;
  if (!mask) return 'none';
  return mask.required ? 'required' : 'optional';
};

/**
 * Credits for one image from `model` at `intent` (its own defaults where the intent does not fit it), priced as the
 * job's hold prices it, or null when the cost tables have no price for the model.
 */
export const imageCreditsPerImage = (model: ImageModels, intent: ImageIntent): number | null => {
  const fits = imageModelWhyNot(model, intent) === null;
  const quality = resolveBilledImageQuality(model, fits ? intent.quality : undefined);
  // A mask is not billed as an input image (imageJobCost); the edit source and each reference are.
  const references = fits ? imageIntentInputs(intent).filter(({ role }) => role !== 'mask').length : 0;
  try {
    // The cost input is a per-provider union keyed on narrower model types than ImageModels; the calculators
    // dispatch on the model id, as CostPreviewChip does.
    const input = {
      model,
      quality,
      ...(fits && intent.size && { size: intent.size }),
      inputImageCount: references,
    } as Parameters<typeof estimateImageUsd>[2];
    return usdToCredits(estimateImageUsd(model, 1, input));
  } catch (error) {
    if (error instanceof UnsupportedImageModelError) return null;
    throw error;
  }
};

/**
 * A card per catalog model the user can run (from /api/v1/image-models), in rankImageModels order for `intent`:
 * the ones that can make it first, each with why it was picked; the rest sink with the validator's why-not reason.
 */
export const imageModelCards = (
  available: readonly { id: string; name: string }[],
  intent: ImageIntent
): StudioModelCard[] => {
  const names = new Map<ImageModels, string>();
  for (const { id, name } of available) if (isCatalogImageModel(id)) names.set(id, name);
  const ids = [...names.keys()];
  const unavailable = Object.fromEntries(
    ids.flatMap(id => {
      const reason = imageModelUnavailableReason(id, intent.mode);
      return reason === null ? [] : [[id, reason]];
    })
  );
  return rankImageModels(ids, toCapabilityRequest(intent), { unavailable }).map(ranked => {
    const entry = getImageModelCatalogEntry(ranked.id);
    return {
      id: ranked.id,
      name: names.get(ranked.id) ?? ranked.id,
      provider: IMAGE_PROVIDER_LABELS[entry.provider],
      strength: IMAGE_MODEL_STRENGTHS[ranked.id],
      creditsPerOutput: imageCreditsPerImage(ranked.id, intent),
      outputNoun: 'image',
      ...rankedCardFit(ranked),
      // Every reason, not just the ranker's first, so the picker says all a switch would mark.
      mismatchReason: ranked.status === 'mismatch' ? imageModelWhyNot(ranked.id, intent) : null,
    };
  });
};

/** The model the form opens on: the best-ranked model that can run, so it follows the request until the user picks. */
export const pickDefaultImageModel = (cards: readonly StudioModelCard[]): ImageModels | undefined => {
  for (const card of cards) {
    if (card.unavailableReason === null && isCatalogImageModel(card.id)) return card.id;
  }
  return undefined;
};
