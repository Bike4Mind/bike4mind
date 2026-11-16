import {
  IMAGE_INPUT_ROLES,
  IMAGE_MODEL_CATALOG,
  IMAGE_MODEL_STRENGTHS,
  IMAGE_PROVIDER_LABELS,
  rankImageModels,
  resolveLegacyImageModel,
  toPublicImageSizing,
  usdToCredits,
  type ImageModeCapabilities,
  type ImageModels,
  type ImageProviderId,
  type PublicImageModel,
} from '@bike4mind/common';
import { isUsableApiKey } from '@bike4mind/services/generationJobs';
import { UnsupportedImageModelError, estimateImageUsd, resolveBilledImageQuality } from '@bike4mind/services/imageCost';
import type { ImageJobDeps } from '@bike4mind/services/imageJobs';

export type ImageModelAvailabilityDeps = Pick<ImageJobDeps, 'providers' | 'resolveApiKey'>;

/**
 * A model the caller's model list offers (GET /api/models: not disabled, not past its deprecation date, not locked
 * to a paid plan). The list is the source of the display name, which an admin can override in the model catalog.
 */
export type OfferedImageModel = { id: string; name: string; deprecationDate?: string };

// The plain request the list is ordered for, so an API caller gets the order Studio opens on.
const PLAIN_REQUEST = { mode: 'generate', count: 1 } as const;

const isCatalogImageModel = (id: string): id is ImageModels => Object.hasOwn(IMAGE_MODEL_CATALOG, id);

const toPublicAspectRatios = (aspectRatios: ImageModeCapabilities['aspectRatios']) => {
  if (!aspectRatios) return null;
  if (aspectRatios.kind === 'discrete') return { kind: 'discrete' as const, values: [...aspectRatios.values] };
  return { kind: 'range' as const, tallest: aspectRatios.tallest, widest: aspectRatios.widest };
};

const toPublicMode = (mode: ImageModeCapabilities) => ({
  input_roles: IMAGE_INPUT_ROLES.flatMap(role => {
    const accepted = mode.inputs[role];
    return accepted ? [{ role, max: accepted.max, required: accepted.required === true }] : [];
  }),
  max_outputs: mode.maxOutputs,
  aspect_ratios: toPublicAspectRatios(mode.aspectRatios),
  output_formats: [...mode.outputFormats],
});

/** Credits for one image at the model's default quality and size with no inputs, priced as the job's hold is. */
const defaultCreditsPerImage = (model: ImageModels): number | null => {
  try {
    const quality = resolveBilledImageQuality(model, undefined);
    // The cost input is a per-provider union keyed on narrower model types; the calculators dispatch on the id.
    const input = { model, quality, inputImageCount: 0 } as Parameters<typeof estimateImageUsd>[2];
    return usdToCredits(estimateImageUsd(model, 1, input));
  } catch (error) {
    if (error instanceof UnsupportedImageModelError) return null;
    throw error;
  }
};

export const toPublicImageModel = (offered: OfferedImageModel & { id: ImageModels }): PublicImageModel => {
  const entry = IMAGE_MODEL_CATALOG[offered.id];
  return {
    id: offered.id,
    object: 'image_model',
    display_name: offered.name,
    provider: entry.provider,
    provider_label: IMAGE_PROVIDER_LABELS[entry.provider],
    blurb: IMAGE_MODEL_STRENGTHS[offered.id],
    tier: entry.tier,
    released_at: entry.releasedAt,
    preview: entry.preview,
    modes: {
      ...(entry.modes.generate && { generate: toPublicMode(entry.modes.generate) }),
      ...(entry.modes.edit && { edit: toPublicMode(entry.modes.edit) }),
    },
    sizing: toPublicImageSizing(entry.sizing),
    qualities: [...entry.qualities],
    transparent_background: entry.transparentBackground,
    seed: entry.seed,
    credits_per_image: defaultCreditsPerImage(offered.id),
    deprecation_date: offered.deprecationDate ?? null,
  };
};

/**
 * The catalog image models the caller can run as an image job: offered to them, served by a registered provider
 * that lists the id (a retired id is served only under its successor), and backed by a key they can use - the same
 * checks createImageJobs refuses with model_unavailable. Ordered by rankImageModels for a plain request.
 */
export async function listUsableImageModels(
  userId: string,
  offered: readonly OfferedImageModel[],
  deps: ImageModelAvailabilityDeps
): Promise<PublicImageModel[]> {
  const keys = new Map<ImageProviderId, Promise<boolean>>();
  const hasKey = (provider: ImageProviderId): Promise<boolean> => {
    const cached = keys.get(provider);
    if (cached) return cached;
    const resolved = deps.resolveApiKey(provider, userId).then(isUsableApiKey);
    keys.set(provider, resolved);
    return resolved;
  };
  const usable = new Map<string, PublicImageModel>();
  for (const model of offered) {
    if (!isCatalogImageModel(model.id) || usable.has(model.id)) continue;
    if (resolveLegacyImageModel(model.id) !== model.id) continue;
    const providerId = IMAGE_MODEL_CATALOG[model.id].provider;
    const provider = deps.providers.get(providerId);
    if (!provider || !(provider.models as readonly string[]).includes(model.id)) continue;
    if (await hasKey(providerId)) usable.set(model.id, toPublicImageModel({ ...model, id: model.id }));
  }
  return rankImageModels([...usable.keys()], PLAIN_REQUEST).flatMap(ranked => {
    const model = usable.get(ranked.id);
    return model ? [model] : [];
  });
}
