import { GenerateImageToolCall, ImageModels } from '@bike4mind/common';

/** Tool-call args that may override the client's saved image selections. */
export interface ImageToolArgs {
  n?: number;
  size?: string | null;
  quality?: string;
}

export interface ResolvedImageArgs {
  model: string;
  n: number;
  size?: string | null;
  quality?: string;
}

/**
 * The single definition of "which args does this generation actually run with".
 *
 * `imageConfig` is the client's Smart Tools panel selection and is a DEFAULT, not a pin:
 * an arg the model supplied in the tool call wins (`??`), and an omitted one falls back to
 * the client value. `model` is the exception - the tool schema exposes no model parameter,
 * so the panel's selection stays authoritative there.
 *
 * Both the credit reservation (`ToolBuilder.reserveImageCredits` reads the `onStart`
 * payload) and the provider dispatch must read this output, so the ledger can never
 * describe an image other than the one generated.
 */
export function resolveImageArgs(
  imageConfig: GenerateImageToolCall | undefined,
  toolArgs: ImageToolArgs
): ResolvedImageArgs {
  // Auto-upgrade gpt-image-1 to gpt-image-2 (latest model) here rather than at the
  // dispatch site, so billing and the provider call see the same model id.
  const configuredModel = imageConfig?.model || ImageModels.GPT_IMAGE_2;
  const model = configuredModel === ImageModels.GPT_IMAGE_1 ? ImageModels.GPT_IMAGE_2 : configuredModel;

  return {
    model,
    n: toolArgs.n ?? imageConfig?.n ?? 1,
    size: toolArgs.size ?? imageConfig?.size,
    quality: toolArgs.quality ?? imageConfig?.quality,
  };
}
