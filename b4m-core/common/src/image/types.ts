import type { ImageOutputFormat, OpenAIImageQuality, OpenAIImageStyle } from '../schemas/openai';
import type { ImageModels } from '../models';
import type { ImageSizing } from '../utils/imageCapabilities';
import type { ModelStanding } from '../generation/modelRanking';

// `edit` starts from an edit_source image (optionally masked); `generate` starts from the prompt.
export const IMAGE_MODES = ['generate', 'edit'] as const;
export type ImageMode = (typeof IMAGE_MODES)[number];

// What an input image is for. snake_case to share names with the FabFile lineage roles (derivedFrom).
// edit_source and mask are edit-only; a reference guides the look without being edited, in either mode.
export const IMAGE_INPUT_ROLES = ['edit_source', 'mask', 'reference'] as const;
export type ImageInputRole = (typeof IMAGE_INPUT_ROLES)[number];

// `test` and `local` serve only the image job path: their models are not ImageModels members (see ImageJobModelId).
export const IMAGE_PROVIDER_IDS = ['openai', 'bfl', 'xai', 'gemini', 'test', 'local'] as const;
export type ImageProviderId = (typeof IMAGE_PROVIDER_IDS)[number];

// The free, deterministic model the test provider renders; registered only outside production.
export const TEST_IMAGE_MODEL = 'test-image';
export type TestImageModel = typeof TEST_IMAGE_MODEL;

// A self-hosted Stable Diffusion checkpoint, discovered at runtime from the local backend, so never a static id.
export const LOCAL_IMAGE_MODEL_PREFIX = 'local-image/';
export type LocalImageModelId = `local-image/${string}`;

/**
 * Every model an image job can name: the chat-shared ImageModels plus the job-only ids. The job-only ids stay out of
 * ImageModels so chat model pickers, which list that enum, never offer them.
 */
export type ImageJobModelId = ImageModels | TestImageModel | LocalImageModelId;

export const isLocalImageModelId = (model: string): model is LocalImageModelId =>
  model.startsWith(LOCAL_IMAGE_MODEL_PREFIX);

// Ratios are `W:H` strings. A range is inclusive, from the tallest to the widest ratio accepted.
export type AspectRatioCapability =
  { kind: 'discrete'; values: readonly string[] } | { kind: 'range'; tallest: string; widest: string };

// Formats with an alpha channel, so the only ones that can carry a transparent background.
export const IMAGE_ALPHA_FORMATS: readonly ImageOutputFormat[] = ['png', 'webp'];

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
  // Bounding-box regions an edit can target (FLUX 3's prompt-inline layout); absent when the mode takes none.
  editRegions?: { max: number };
};

/**
 * What an image model can honour, declared as data. Read by validateImageRequest; the image job
 * kind, the Studio form and the API docs are meant to read it too.
 *
 * Must stay in sync with the request path (modelHelpers predicates, IMAGE_SIZE_CONSTRAINTS and the
 * provider services) - catalog.test.ts pins the overlap with getImageModelCapabilities.
 */
export type ImageModelCatalogEntry = ModelStanding & {
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
