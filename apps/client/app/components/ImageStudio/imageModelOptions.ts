/**
 * The Studio image form's choices, read from the capability catalog (b4m-core/common/src/image/catalog.ts) and
 * checked with its validator, so a model that cannot honour the request is greyed with its why-not reason. Prices
 * come from the same cost tables the credit hold uses (@bike4mind/services/imageCost).
 */
import {
  IMAGE_MODEL_CATALOG,
  IMAGE_MODEL_STRENGTHS,
  IMAGE_MODES,
  IMAGE_PROVIDER_LABELS,
  ImageModels,
  getImageModelCatalogEntry,
  resolveLegacyImageModel,
  usdToCredits,
  validateImageRequest,
  type ImageCapabilityRequest,
  type ImageMode,
  type ImageProviderId,
  type ImageRequestField,
  type OpenAIImageQuality,
} from '@bike4mind/common';
import { UnsupportedImageModelError, estimateImageUsd, resolveBilledImageQuality } from '@bike4mind/services/imageCost';
import type { ReferenceFile } from '@client/app/components/Studio/capabilityFields';
import type { StudioModelCard } from '@client/app/components/Studio/StudioModelCards';

/**
 * What the form asks for besides the prompt. size, aspectRatio and quality are absent when left on the model's
 * default. Kept across a model switch: a value the new model does not take is marked, never dropped.
 */
export type ImageIntent = {
  size?: string;
  aspectRatio?: string;
  quality?: OpenAIImageQuality;
  references: readonly ReferenceFile[];
};

export const EMPTY_IMAGE_INTENT: ImageIntent = { references: [] };

// Offered on a model that takes any ratio within a range; the validator keeps the ones inside it.
const COMMON_ASPECT_RATIOS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9', '9:21'] as const;

// Intent first: the form opens on the first of these the user can run, on a visible, swappable card.
const DEFAULT_MODEL_PREFERENCE: readonly ImageModels[] = [
  ImageModels.GPT_IMAGE_1_5,
  ImageModels.GPT_IMAGE_2,
  ImageModels.GEMINI_3_1_FLASH_IMAGE,
];

// The providers whose image job adapter is wired; the job route answers model_unavailable for the others. Add a
// provider here when its adapter lands.
const STUDIO_IMAGE_JOB_PROVIDERS: readonly ImageProviderId[] = ['openai', 'gemini'];

const MODE_LABELS: Record<ImageMode, string> = { generate: 'Generate', edit: 'Edit' };

export const isCatalogImageModel = (id: string): id is ImageModels => Object.hasOwn(IMAGE_MODEL_CATALOG, id);

// Count 1, as createImageJobs validates: "make N" is N one-image jobs, bounded by STUDIO_IMAGE_COUNT_MAX.
const toCapabilityRequest = ({ size, aspectRatio, quality, references }: ImageIntent): ImageCapabilityRequest => ({
  mode: 'generate',
  count: 1,
  ...(size && { size }),
  ...(aspectRatio && { aspectRatio }),
  ...(quality && { quality }),
  ...(references.length > 0 && { inputs: references.map(() => ({ role: 'reference' as const })) }),
});

const failuresOf = (model: ImageModels, intent: ImageIntent) => {
  const result = validateImageRequest(toCapabilityRequest(intent), getImageModelCatalogEntry(model));
  return result.ok ? [] : result.failures;
};

/** Every reason `model` cannot make `intent`, joined into one sentence list, or null when it can. */
export const imageModelWhyNot = (model: ImageModels, intent: ImageIntent): string | null => {
  const failures = failuresOf(model, intent);
  return failures.length === 0 ? null : failures.map(failure => failure.reason).join(' ');
};

/** Why `model` cannot run in Create at all, whatever the request, or null when it can. */
export const imageModelUnavailableReason = (model: ImageModels): string | null => {
  // The job route serves a retired id under its successor only, so the retired id itself never runs.
  if (resolveLegacyImageModel(model) !== model) return 'Retired. Pick its successor instead.';
  const generateOnly = failuresOf(model, EMPTY_IMAGE_INTENT);
  if (generateOnly.length > 0) return generateOnly.map(failure => failure.reason).join(' ');
  if (!STUDIO_IMAGE_JOB_PROVIDERS.includes(getImageModelCatalogEntry(model).provider)) {
    return 'Temporarily unavailable in Studio.';
  }
  return null;
};

export type ImageProblemField = 'size' | 'aspect' | 'quality' | 'references';

const PROBLEM_FIELD: Partial<Record<ImageRequestField, ImageProblemField>> = {
  size: 'size',
  aspectRatio: 'aspect',
  quality: 'quality',
  inputs: 'references',
};

/** The why-not reason for each form value `model` does not take, keyed by the field that holds it. */
export const imageFieldProblems = (
  model: ImageModels,
  intent: ImageIntent
): Partial<Record<ImageProblemField, string>> => {
  const problems: Partial<Record<ImageProblemField, string>> = {};
  for (const failure of failuresOf(model, intent)) {
    const field = PROBLEM_FIELD[failure.field];
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

/** The aspect ratios `model` takes when generating; empty when it takes none. */
export const imageAspectRatioOptions = (model: ImageModels): readonly string[] => {
  const ratios = getImageModelCatalogEntry(model).modes.generate?.aspectRatios;
  if (!ratios) return [];
  if (ratios.kind === 'discrete') return ratios.values;
  return COMMON_ASPECT_RATIOS.filter(
    aspectRatio => imageModelWhyNot(model, { ...EMPTY_IMAGE_INTENT, aspectRatio }) === null
  );
};

export const imageQualityOptions = (model: ImageModels): readonly OpenAIImageQuality[] =>
  getImageModelCatalogEntry(model).qualities;

/** The most reference images `model` takes when generating; 0 when it takes none. */
export const imageReferenceMax = (model: ImageModels): number =>
  getImageModelCatalogEntry(model).modes.generate?.inputs.reference?.max ?? 0;

/**
 * Credits for one image from `model` at `intent` (its own defaults where the intent does not fit it), priced as the
 * job's hold prices it, or null when the cost tables have no price for the model.
 */
export const imageCreditsPerImage = (model: ImageModels, intent: ImageIntent): number | null => {
  const fits = imageModelWhyNot(model, intent) === null;
  const quality = resolveBilledImageQuality(model, fits ? intent.quality : undefined);
  const references = fits ? intent.references.length : 0;
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

/** A card per catalog model the user can run (from /api/models), checked against `intent`. */
export const imageModelCards = (
  available: readonly { id: string; name: string }[],
  intent: ImageIntent
): StudioModelCard[] =>
  available.flatMap(({ id, name }) => {
    if (!isCatalogImageModel(id)) return [];
    const entry = getImageModelCatalogEntry(id);
    const unavailableReason = imageModelUnavailableReason(id);
    return [
      {
        id,
        name,
        provider: IMAGE_PROVIDER_LABELS[entry.provider],
        strength: IMAGE_MODEL_STRENGTHS[id],
        creditsPerOutput: imageCreditsPerImage(id, intent),
        outputNoun: 'image',
        modes: IMAGE_MODES.filter(mode => entry.modes[mode]).map(mode => MODE_LABELS[mode]),
        unavailableReason,
        mismatchReason: unavailableReason === null ? imageModelWhyNot(id, intent) : null,
      },
    ];
  });

/** The model the form opens on: the first preferred model that can run, else the first that can. */
export const pickDefaultImageModel = (cards: readonly StudioModelCard[]): ImageModels | undefined => {
  const usable = cards.filter(card => card.unavailableReason === null).map(card => card.id);
  const preferred = DEFAULT_MODEL_PREFERENCE.find(model => usable.includes(model));
  const first = usable.find(isCatalogImageModel);
  return preferred ?? first;
};
