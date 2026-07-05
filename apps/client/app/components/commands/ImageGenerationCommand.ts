import { api } from '@client/app/contexts/ApiContext';
import { createOptimisticQuest, updateOptimisticQuest } from '@client/app/utils/llm';
import {
  IChatHistoryItemDocument,
  OpenAIImageQuality,
  OpenAIImageSize,
  OpenAIImageStyle,
  ImageModelName,
  IFabFileDocument,
  ImageModels,
  B4MLLMTools,
  GenerateImageToolCall,
  ModelInfo,
  PromptIntent,
} from '@bike4mind/common';
import { ISessionDocument } from '@bike4mind/common';
import { QueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import { createOptimisticSessionId } from '@client/app/utils/llm';

export type ImageGenerationCommandArgs = {
  /** Prompt */
  params: string;
  currentSession: ISessionDocument | null;
  workBenchFiles: IFabFileDocument[];
  questId?: string;
  queryClient: QueryClient;
  model: ImageModelName;
  tools: B4MLLMTools[];
  organizationId?: string | null;
  setChatCompletion?: (updater: (prev: any) => any) => void;
  /** tmpId set by useSendMessage during /new pre-navigation. Must be used to key
   * the optimistic placeholder so the session.created cache migration finds it. */
  optimisticSessionId?: string;
} & GenerateImageToolCall;

export type ImageEditCommandArgs = {
  promptFileIds?: string[];
  image?: string; // Image to be edited
} & ImageGenerationCommandArgs;

export type AIImageSettings = {
  model?: ImageModelName;
  size: OpenAIImageSize;
  quality: OpenAIImageQuality;
  style: OpenAIImageStyle;
  safety_tolerance?: number;
  prompt_upsampling?: boolean;
  seed?: number | null;
  output_format?: 'jpeg' | 'png' | null;
  width?: number;
  height?: number;
  aspect_ratio?: string;
};

export async function handleImageGenerationCommand(args: ImageGenerationCommandArgs): Promise<void> {
  const {
    params,
    currentSession,
    questId,
    queryClient,
    model,
    workBenchFiles,
    tools,
    organizationId,
    setChatCompletion,
    imageConfig,
    optimisticSessionId,
    ...rest
  } = args as ImageGenerationCommandArgs & { imageConfig?: GenerateImageToolCall };

  const isPromptEnhancementEnabled = tools.includes('prompt_enhancement' as B4MLLMTools);

  // Reuse the tmpId from useSendMessage when present: generating a fresh id here
  // would key the optimistic placeholder under an id that session.created can't
  // migrate, leaving the assistant turn blank when chunks arrive for the realId.
  const tmpSessionId = optimisticSessionId ?? createOptimisticSessionId();

  const optimisticOperation = questId
    ? (cb: () => Promise<{ quest: IChatHistoryItemDocument; session: ISessionDocument }>) =>
        updateOptimisticQuest(
          queryClient,
          questId,
          currentSession?.id,
          { replies: [], reply: undefined, prompt: params, timestamp: new Date(), status: undefined },
          cb
        )
    : currentSession?.id || tmpSessionId
      ? (cb: () => Promise<{ quest: IChatHistoryItemDocument; session: ISessionDocument }>) =>
          createOptimisticQuest(
            queryClient,
            currentSession?.id || tmpSessionId,
            isPromptEnhancementEnabled ? `${params}\n\n_Enhancing prompt..._ ✨` : params,
            cb
          )
      : async (cb: () => Promise<{ quest: IChatHistoryItemDocument; session: ISessionDocument }>) => {
          // For new sessions: call API first, then optimistically update cache with response
          const result = await cb();
          return result;
        };

  const fabFileIds = workBenchFiles.map(file => file.id);

  // Use the image model from imageConfig (which has the correct image-specific model),
  // falling back to the model param only if imageConfig is not available
  const effectiveModel = imageConfig?.model ?? model;

  const requestBody = {
    ...rest,
    prompt: params,
    sessionId: currentSession?.id,
    questId,
    model: effectiveModel,
    fabFileIds,
    tools,
    organizationId,
  };

  try {
    await optimisticOperation(async () => {
      const { data } = await api.post<{
        session: ISessionDocument;
        quest: IChatHistoryItemDocument;
        intent?: PromptIntent;
      }>(`/api/ai/generate-image`, requestBody);

      // Surface a one-shot hint when the user clearly wanted to continue from the prior image
      // (resolver classified intent='continuation') but their selected model can't take an image
      // input. Skip when a workbench file is attached, since that overrides session carryforward.
      if (data.intent === 'continuation' && fabFileIds.length === 0) {
        const models = queryClient.getQueryData<ModelInfo[]>(['llm', 'models']);
        const modelInfo = models?.find(m => m.id === effectiveModel);
        if (modelInfo && !modelInfo.supportsImageVariation) {
          // Build the suggested-model list dynamically so newly added variation-capable models
          // are surfaced automatically. Falls back to a static example if the model registry
          // hasn't loaded yet.
          const variationCapableNames =
            models
              ?.filter(m => m.type === 'image' && m.supportsImageVariation)
              .map(m => m.name)
              .slice(0, 3) ?? [];
          const suggestions =
            variationCapableNames.length > 0
              ? variationCapableNames.join(', ')
              : 'GPT Image 2, Gemini Image, or Flux Kontext';
          toast.info(
            `This model can't refine prior images — your prompt was treated as a fresh request. ` +
              `Switch to ${suggestions} to edit the previous result.`,
            { duration: 8000 }
          );
        }
      }

      return data;
    });
  } catch (error) {
    console.error('Error generating image:', error);
    toast.error(formatImageActionError(error, 'generate'));
    throw error;
  }
}

/**
 * Build a user-facing toast string for a failed image generate/edit request.
 *
 * Distinguishes:
 *  - CDN/WAF blocks (HTML body, typical of a CloudFront 403): surfaced as a
 *    CDN/network message, NOT "permission denied", since blanket-claiming
 *    permission masks the real cause.
 *  - Application 401/403: uses the server's `message` so the user sees the
 *    actual reason (org plan, feature flag, model gating) rather than a
 *    generic line.
 *  - 400 / 429 / 5xx / other: same buckets, but with server message when present.
 */
function formatImageActionError(error: unknown, action: 'generate' | 'edit'): string {
  const verbPresent = action === 'generate' ? 'generate' : 'edit';
  const verbPast = action === 'generate' ? 'Image generation' : 'Image edit';
  if (!isAxiosError(error)) {
    return `${verbPast} failed. Please check your connection and try again.`;
  }
  const status = error.response?.status;
  const data = error.response?.data;
  // CDN/WAF response - HTML body rather than JSON.
  if (typeof data === 'string') {
    const trimmed = data.trim();
    const looksLikeHtml = trimmed.startsWith('<') || /<html|<!doctype/i.test(trimmed);
    if (looksLikeHtml) {
      if (/cloudfront/i.test(trimmed)) {
        return `Request blocked by CDN (CloudFront, status ${status ?? 'unknown'}). Try again, or check your VPN/network.`;
      }
      return `Request blocked at the edge (status ${status ?? 'unknown'}). Try again, or check your VPN/network.`;
    }
  }
  const serverMessage = (typeof data === 'object' && data?.message) || error.message;
  if (status === 400) return `Invalid request: ${serverMessage}`;
  if (status === 401 || status === 403) return `Cannot ${verbPresent} images: ${serverMessage}`;
  if (status === 429) return 'Too many requests. Please try again later.';
  if (status && status >= 500) return `Server error — could not ${verbPresent} image. Please try again.`;
  return `${verbPast} failed: ${serverMessage}`;
}

export async function handleImageEditCommand(args: ImageEditCommandArgs): Promise<void> {
  const {
    params,
    image,
    currentSession,
    questId,
    queryClient,
    model,
    workBenchFiles,
    promptFileIds,
    organizationId,
    setChatCompletion,
    imageConfig,
    optimisticSessionId,
    ...rest
  } = args as ImageEditCommandArgs & { imageConfig?: GenerateImageToolCall };

  const tmpSessionId = optimisticSessionId ?? createOptimisticSessionId();

  const optimisticOperation = questId
    ? (cb: () => Promise<{ quest: IChatHistoryItemDocument; session: ISessionDocument }>) =>
        updateOptimisticQuest(
          queryClient,
          questId,
          currentSession?.id,
          { replies: [], reply: undefined, prompt: params, timestamp: new Date(), status: undefined },
          cb
        )
    : currentSession?.id || tmpSessionId
      ? (cb: () => Promise<{ quest: IChatHistoryItemDocument; session: ISessionDocument }>) =>
          createOptimisticQuest(queryClient, currentSession?.id || tmpSessionId, params, cb)
      : async (cb: () => Promise<{ quest: IChatHistoryItemDocument; session: ISessionDocument }>) => {
          // For new sessions: call API first, then optimistically update cache with response
          const result = await cb();
          return result;
        };

  const imageEditModel = imageConfig?.editModel ?? ImageModels.FLUX_PRO_FILL;
  const fabFileIds = [...workBenchFiles.map(file => file.id), ...(promptFileIds || [])];
  try {
    await optimisticOperation(async () => {
      const { data } = await api.post<{ session: ISessionDocument; quest: IChatHistoryItemDocument }>(
        `/api/ai/edit-image`,
        {
          ...rest,
          prompt: params,
          image,
          promptFileIds,
          sessionId: currentSession?.id,
          model: imageEditModel,
          fabFileIds,
          organizationId,
        }
      );
      return data;
    });
  } catch (error) {
    console.error('Error editing image:', error);
    toast.error(formatImageActionError(error, 'edit'));
    throw error;
  }
}
