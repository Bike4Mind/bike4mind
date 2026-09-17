import { GenerateImageToolCall, ImageModels, type OpenAIImageQuality } from '@bike4mind/common';
import { isPriceableImageSize } from '../../../imageCostCalculator/OpenAIImageCostCalculator';

/** Tool-call args that may override the client's saved image selections. Nulls are
 *  accepted because the OpenAI SDK types them that way; the resolver normalizes them out. */
export interface ImageToolArgs {
  n?: number | null;
  size?: string | null;
  quality?: OpenAIImageQuality | null;
}

export interface ResolvedImageArgs {
  model: string;
  n: number;
  size?: string | null;
  quality?: OpenAIImageQuality;
}

/**
 * The single definition of "which args does this generation actually run with".
 *
 * `imageConfig` is the client's Smart Tools panel selection and is a DEFAULT, not a pin:
 * an arg the model supplied in the tool call wins (`??`), and an omitted one falls back to
 * the client value. `model` is the exception - the tool schema exposes no model parameter,
 * so the panel's selection stays authoritative there.
 *
 * `size` is the second exception: a model-supplied size only wins when the cost calculator
 * can actually price it, otherwise it is discarded in favor of the client value. The tool
 * schema advertises only priceable sizes, so this only trips when a model ignores the enum -
 * but an off-enum size would otherwise be generated at one size and billed at the
 * `1024x1024` row (see `OpenAIImageCostCalculator.normalizeInput`).
 *
 * Both the credit reservation (`ToolBuilder.reserveImageCredits` reads the `onStart`
 * payload) and the provider dispatch read this output, so the two can never disagree about
 * which args an image ran with. Note that is an agreement about args, not about price: a
 * panel-selected gpt-image-2 size outside the priced set (e.g. `2048x2048`) is honored here
 * and still estimated at the `1024x1024` row.
 */
export function resolveImageArgs(
  imageConfig: GenerateImageToolCall | undefined,
  toolArgs: ImageToolArgs
): ResolvedImageArgs {
  // Auto-upgrade gpt-image-1 to gpt-image-2 (latest model) here rather than at the
  // dispatch site, so billing and the provider call see the same model id.
  const configuredModel = imageConfig?.model || ImageModels.GPT_IMAGE_2;
  const model = configuredModel === ImageModels.GPT_IMAGE_1 ? ImageModels.GPT_IMAGE_2 : configuredModel;

  const modelSuppliedSize = isPriceableImageSize(toolArgs.size) ? toolArgs.size : undefined;

  return {
    model,
    n: toolArgs.n ?? imageConfig?.n ?? 1,
    size: modelSuppliedSize ?? imageConfig?.size,
    quality: toolArgs.quality ?? imageConfig?.quality,
  };
}
