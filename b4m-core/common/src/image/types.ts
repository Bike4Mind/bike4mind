import type { ImageOutputFormat, OpenAIImageQuality, OpenAIImageStyle } from '../schemas/openai';
import type { ImageSizing } from '../utils/imageCapabilities';

// `edit` starts from an edit_source image (optionally masked); `generate` starts from the prompt.
export const IMAGE_MODES = ['generate', 'edit'] as const;
export type ImageMode = (typeof IMAGE_MODES)[number];

// What an input image is for. snake_case to share names with the FabFile lineage roles (derivedFrom).
// edit_source and mask are edit-only; a reference guides the look without being edited, in either mode.
export const IMAGE_INPUT_ROLES = ['edit_source', 'mask', 'reference'] as const;
export type ImageInputRole = (typeof IMAGE_INPUT_ROLES)[number];

export const IMAGE_PROVIDER_IDS = ['openai', 'bfl', 'xai', 'gemini'] as const;
export type ImageProviderId = (typeof IMAGE_PROVIDER_IDS)[number];

// Ratios are `W:H` strings. A range is inclusive, from the tallest to the widest ratio accepted.
export type AspectRatioCapability =
  { kind: 'discrete'; values: readonly string[] } | { kind: 'range'; tallest: string; widest: string };

// `required` marks a role an edit must carry beyond its edit_source (Fill needs a mask).
export type ImageInputCapability = { max: number; required?: true };

// What a model honours in one mode. These differ by mode: an edit renders one image, and some providers'
// edit calls carry no aspect ratio or format.
export type ImageModeCapabilities = {
  inputs: Partial<Record<ImageInputRole, ImageInputCapability>>;
  // Most images one request renders.
  maxOutputs: number;
  // null when the model takes no `aspect_ratio` in this mode.
  aspectRatios: AspectRatioCapability | null;
  // Empty when no output format is sent and the provider default comes back.
  outputFormats: readonly ImageOutputFormat[];
};

/**
 * What an image model can honour, declared as data. Read by validateImageRequest; the image job
 * kind, the Studio form and the API docs are meant to read it too.
 *
 * Must stay in sync with the request path (modelHelpers predicates, IMAGE_SIZE_CONSTRAINTS and the
 * provider services) - catalog.test.ts pins the overlap with getImageModelCapabilities.
 */
export type ImageModelCatalogEntry = {
  provider: ImageProviderId;
  // A mode is offered exactly when it has an entry.
  modes: Partial<Record<ImageMode, ImageModeCapabilities>>;
  sizing: ImageSizing;
  qualities: readonly OpenAIImageQuality[];
  styles: readonly OpenAIImageStyle[];
  // `background: 'transparent'` yields real alpha.
  transparentBackground: boolean;
  seed: boolean;
};
