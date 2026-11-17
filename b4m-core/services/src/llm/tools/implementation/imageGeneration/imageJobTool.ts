import {
  getImageModelCatalogEntry,
  ImageJobRequestSchema,
  ImageModels,
  isBflImageModel,
  isGeminiImageModel,
  rejectsTransparentBackground,
  resolveLegacyImageModel,
  validateImageRequest,
  type GenerateImageToolCall,
  type ImageJobInput,
  type ImageMode,
  type ImageOutputFormat,
  type ImageRequestField,
  type OpenAIImageBackground,
  type OpenAIImageQuality,
} from '@bike4mind/common';
import { resolveBilledImageQuality } from '../../../../imageCost';
import {
  IMAGE_JOB_BATCH_MAX,
  type CreateImageJobsInput,
  type CreateImageJobsResult,
} from '../../../../imageJobs/types';
import type { ToolContext } from '../../base/types';
import { settingsModelRefusalOrRethrow } from '../../helpers/toolModelRefusal';
import { isPriceableImageSize } from '../../../imageCostCalculator/OpenAIImageCostCalculator';
import { buildJobIdempotencyKey, isReplayOfDeadJob } from '../generationJobTool';

// The agent-mode per-run cap (agentExecutor.imageToolConfig.ts) refuses here; createImageJobs never returns this code.
export type ImageLimitRefusal = { ok: false; status: 403; code: 'image_limit_reached'; message: string };
export type ImageToolJobsResult = CreateImageJobsResult | ImageLimitRefusal;

/**
 * The job-engine config for image_generation and edit_image. A host that wires it has the tools start image jobs
 * (billed per image by each job's hold); any other config keeps the in-process render.
 */
export type ImageToolConfig = {
  /** The chat's image selection (model and defaults); undefined when the caller chose none. */
  selection: GenerateImageToolCall | undefined;
  createJobs: (input: CreateImageJobsInput) => Promise<ImageToolJobsResult>;
  /** Surfaces with no progress UI use this to tell the model how the finished images reach the user. */
  deliveryNote?: string;
};

export const isImageJobToolConfig = (value: unknown): value is ImageToolConfig =>
  typeof value === 'object' && value !== null && 'createJobs' in value && typeof value.createJobs === 'function';

/** The selection either config shape carries: the bare legacy config is the selection itself. */
export const imageSelectionOf = (config: unknown): GenerateImageToolCall | undefined =>
  isImageJobToolConfig(config) ? config.selection : (config as GenerateImageToolCall | undefined);

const SELECTION_DEFAULTED_FIELDS = [
  'size',
  'aspectRatio',
  'quality',
  'outputFormat',
  'transparentBackground',
  'seed',
] as const satisfies readonly ImageRequestField[];
type DefaultedField = (typeof SELECTION_DEFAULTED_FIELDS)[number];

export type ImageJobRequestDraft = {
  model: string;
  mode: ImageMode;
  prompt: string;
  inputs?: ImageJobInput[];
  size?: string;
  aspectRatio?: string;
  quality?: OpenAIImageQuality;
  outputFormat?: ImageOutputFormat;
  transparentBackground?: boolean;
  seed?: number;
};

/** Where each optional field's value came from: the model's tool call, or the user's saved selection. */
type FieldSources = Partial<Record<DefaultedField, 'tool' | 'selection'>>;

/** The tool-call args both image tools share; each wins over the selection's value for the same field. */
export type ImageJobToolArgs = {
  size?: string | null;
  quality?: OpenAIImageQuality | null;
  background?: OpenAIImageBackground | null;
  outputFormat?: ImageOutputFormat | null;
};

const pick = <T>(tool: T | null | undefined, selection: T | null | undefined) =>
  tool != null
    ? { value: tool, from: 'tool' as const }
    : selection != null
      ? { value: selection, from: 'selection' as const }
      : undefined;

const isDefaultedField = (field: ImageRequestField): field is DefaultedField =>
  (SELECTION_DEFAULTED_FIELDS as readonly string[]).includes(field);

/**
 * A selection value is a saved default for whichever model the user last used, so one the model cannot take is
 * dropped rather than refused. A value the tool call supplied is left in, so createImageJobs reports it to the model.
 */
function dropUnsupportedSelectionFields(draft: ImageJobRequestDraft, sources: FieldSources): ImageJobRequestDraft {
  const model = ImageJobRequestSchema.shape.model.safeParse(draft.model);
  // An unknown model is createImageJobs' to refuse; there is no catalog entry to check against.
  if (!model.success) return draft;
  const validation = validateImageRequest({ ...draft, count: 1 }, getImageModelCatalogEntry(model.data));
  if (validation.ok) return draft;
  const kept = { ...draft };
  for (const { field } of validation.failures) {
    if (isDefaultedField(field) && sources[field] === 'selection') delete kept[field];
  }
  return kept;
}

/** The chat settings modal stores a BFL pick as width/height; it outranks the selection's size preset. */
const selectionSize = (selection: GenerateImageToolCall | undefined): string | null | undefined =>
  selection?.width !== undefined && selection.height !== undefined
    ? `${selection.width}x${selection.height}`
    : selection?.size;

/**
 * The request fields both modes share. The quality goes through the billed-tier mapping (standard -> medium,
 * hd -> high, an extended tier clamped) so a legacy alias is not refused by the catalog check.
 */
function buildDraft(
  base: Pick<ImageJobRequestDraft, 'model' | 'mode' | 'prompt' | 'inputs'>,
  selection: GenerateImageToolCall | undefined,
  args: ImageJobToolArgs
): ImageJobRequestDraft {
  const sources: FieldSources = {};
  const draft: ImageJobRequestDraft = { ...base };
  const size = pick(isPriceableImageSize(args.size) ? args.size : undefined, selectionSize(selection));
  if (size) {
    draft.size = size.value;
    sources.size = size.from;
  }
  if (selection?.aspect_ratio) {
    draft.aspectRatio = selection.aspect_ratio;
    sources.aspectRatio = 'selection';
  }
  const quality = pick(args.quality, selection?.quality);
  const billedQuality = quality && resolveBilledImageQuality(base.model, quality.value);
  if (quality && billedQuality) {
    draft.quality = billedQuality;
    sources.quality = quality.from;
  }
  const outputFormat = pick(args.outputFormat, selection?.output_format);
  if (outputFormat) {
    draft.outputFormat = outputFormat.value;
    sources.outputFormat = outputFormat.from;
  }
  const background = pick(args.background, selection?.background);
  if (background?.value === 'transparent') {
    draft.transparentBackground = true;
    sources.transparentBackground = background.from;
  }
  const seed = selection?.seed;
  if (typeof seed === 'number' && Number.isInteger(seed) && seed >= 0) {
    draft.seed = seed;
    sources.seed = 'selection';
  }
  return dropUnsupportedSelectionFields(draft, sources);
}

const wantsTransparent = (selection: GenerateImageToolCall | undefined, args: ImageJobToolArgs) =>
  (args.background ?? selection?.background) === 'transparent';

/** gpt-image-2 refuses a transparent background outright, so such a request steps down to gpt-image-1.5. */
const stepDownForTransparency = (model: string, transparent: boolean): string =>
  transparent && rejectsTransparentBackground(model) ? ImageModels.GPT_IMAGE_1_5 : model;

export function buildGenerateJobRequest(
  selection: GenerateImageToolCall | undefined,
  prompt: string,
  args: ImageJobToolArgs
): ImageJobRequestDraft {
  // The tool takes no model argument: the selection is authoritative, with retired ids remapped.
  const selected = resolveLegacyImageModel(selection?.model || ImageModels.GPT_IMAGE_2);
  const model = stepDownForTransparency(selected, wantsTransparent(selection, args));
  return buildDraft({ model, mode: 'generate', prompt }, selection, args);
}

const editModeRequiresMask = (model: string): boolean => {
  const parsed = ImageJobRequestSchema.shape.model.safeParse(model);
  return parsed.success && getImageModelCatalogEntry(parsed.data).modes.edit?.inputs.mask?.required === true;
};

/**
 * The selection's edit model, else a default by the generation model's provider (as the in-process edit picks).
 * Without a mask, a mask-only inpainting model (FLUX Fill) gives way to FLUX Kontext, BFL's instruction editor:
 * a job cannot synthesize the full-image mask the in-process path paints.
 */
export function resolveEditJobModel(selection: GenerateImageToolCall | undefined, hasMask: boolean): string {
  const generationModel = selection?.model || ImageModels.GPT_IMAGE_1_5;
  const selected = resolveLegacyImageModel(selection?.editModel);
  const fallback = isBflImageModel(generationModel)
    ? ImageModels.FLUX_PRO_FILL
    : isGeminiImageModel(generationModel)
      ? generationModel
      : ImageModels.GPT_IMAGE_1_5;
  const model = selected || fallback;
  return !hasMask && editModeRequiresMask(model) ? ImageModels.FLUX_KONTEXT_PRO : model;
}

export function buildEditJobRequest(
  selection: GenerateImageToolCall | undefined,
  prompt: string,
  files: { image: string; mask?: string },
  args: ImageJobToolArgs
): ImageJobRequestDraft {
  const model = stepDownForTransparency(
    resolveEditJobModel(selection, files.mask !== undefined),
    wantsTransparent(selection, args)
  );
  const inputs: ImageJobInput[] = [
    { role: 'edit_source', fileId: files.image.toLowerCase() },
    ...(files.mask ? [{ role: 'mask' as const, fileId: files.mask.toLowerCase() }] : []),
  ];
  return buildDraft({ model, mode: 'edit', prompt, inputs }, selection, args);
}

/** The batch size for a requested `n`, held to what one call may start. */
export function clampImageCount(requested: number | null | undefined): { count: number; note?: string } {
  const wanted = typeof requested === 'number' && Number.isFinite(requested) ? Math.trunc(requested) : 1;
  const count = Math.min(Math.max(wanted, 1), IMAGE_JOB_BATCH_MAX);
  if (count === wanted) return { count };
  return { count, note: `Started ${count} image(s): one call makes 1 to ${IMAGE_JOB_BATCH_MAX}, not ${wanted}.` };
}

/** createJobs as the tool calls it; a paid-plan refusal comes back as the tool's result text. */
export async function createImageJobsForTool(
  context: Omit<ToolContext, 'config'>,
  config: ImageToolConfig,
  toolName: 'image_generation' | 'edit_image',
  request: ImageJobRequestDraft,
  count: number
): Promise<ImageToolJobsResult | string> {
  try {
    return await config.createJobs({
      user: {
        id: context.userId,
        organizationId: context.organizationId ?? null,
        adminRoleWithheld: !context.user.isAdmin,
      },
      request,
      count,
      source: 'agent',
      apiKeyId: context.apiKeyId,
      questId: context.questId,
      idempotencyKey: buildJobIdempotencyKey(context.userId, context.questId, { request, count }),
    });
  } catch (error) {
    // createImageJobs asserts model admission itself; its REST callers need the throw, the model needs a result.
    return settingsModelRefusalOrRethrow(context, error, request.model, toolName);
  }
}

/**
 * The tool result for a createJobs outcome. Started jobs are announced through statusUpdate so the chat renders
 * their cards; a replayed job that already ended without an image is reported as the failure it was.
 */
export async function reportImageJobs(
  context: Omit<ToolContext, 'config'>,
  config: ImageToolConfig,
  label: string,
  result: ImageToolJobsResult,
  notes: readonly string[] = []
): Promise<string> {
  if (!result.ok) {
    const reasons = result.code === 'unsupported_by_model' ? result.failures.map(failure => failure.reason) : [];
    return `${label} failed (${result.code}): ${reasons.length > 0 ? reasons.join(' ') : result.message}`;
  }
  const live = result.jobs.filter(job => !isReplayOfDeadJob(result.created, job.state));
  if (live.length === 0) {
    const reason = result.jobs[0]?.error?.code ?? result.jobs[0]?.state ?? 'failed';
    return `${label} failed (${reason}): an identical request already ended without an image.`;
  }
  await context.statusUpdate({ generationJobs: live.map(job => ({ id: job.id, kind: 'image' as const })) });
  const note = [...notes, ...(config.deliveryNote ? [config.deliveryNote] : [])].join(' ');
  return JSON.stringify({ jobIds: live.map(job => job.id), groupId: result.groupId, ...(note && { note }) });
}
