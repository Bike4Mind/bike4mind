/**
 * The notebook chat's image sends: a send with an image model selected, and the in-chat masked edit. Both post to
 * POST /api/image-jobs; the send path (useSendMessage, SessionMiddle) calls them directly when chatImageSendMode
 * (utils/commands.ts) says a send is one.
 */
import { api } from '@client/app/contexts/ApiContext';
import { createOptimisticQuest, createOptimisticSessionId, updateOptimisticQuest } from '@client/app/utils/llm';
import { terminalQuests } from '@client/app/hooks/chatCompletionState';
import { handleCommand, type CommandArgs, type CommandHandlers } from '@client/app/utils/commands';
import {
  KnowledgeType,
  OpenAIImageQuality,
  OpenAIImageSize,
  OpenAIImageStyle,
  ImageModelName,
  IFabFileDocument,
  ImageModels,
  B4MLLMTools,
  GenerateImageToolCall,
  requiresImageInput,
  type ChatImageJobsBody,
  type ChatImageJobsResponse,
  type CreateFabFileRequestInputType,
} from '@bike4mind/common';
import { ISessionDocument } from '@bike4mind/common';
import { QueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import { getCachedModels } from '@client/app/hooks/data/useModelInfo';
import {
  copyGeneratedImageToFabFile,
  createFabFileOnServerWithUpload,
  deleteFileUtility,
  getFabFileByIdFromServer,
  moderateFabFileNow,
} from '@client/app/utils/filesAPICalls';
import { extractS3KeyFromUrl, isGeneratedImage } from '@client/app/utils/generatedImageUrl';

export type ChatImageSendArgs = {
  /** Prompt */
  params: string;
  currentSession: ISessionDocument | null;
  workBenchFiles: IFabFileDocument[];
  questId?: string;
  queryClient: QueryClient;
  model: ImageModelName;
  tools: B4MLLMTools[];
  organizationId?: string | null;
  /** Message-level (paperclip) attachment ids, i.e. files NOT added as notebook context.
   * Merged into the generation input so an inline-attached image still feeds image-to-image
   * models without requiring the "Add as Notebook Context" toggle. */
  promptFileIds?: string[];
  /** tmpId set by useSendMessage during /new pre-navigation. Must be used to key
   * the optimistic placeholder so the session.created cache migration finds it. */
  optimisticSessionId?: string;
  projectId?: string;
} & GenerateImageToolCall;

export type ChatImageEditArgs = {
  image?: string; // Image to be edited
  /** The FabFile behind `image`, if the chat knows it; reused as the edit source when it is the caller's own. */
  imageFileId?: string;
  userId?: string;
} & ChatImageSendArgs;

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

/** The saved selection fields the send receives; the server maps them onto the job request. */
const SELECTION_FIELDS = [
  'size',
  'quality',
  'style',
  'background',
  'safety_tolerance',
  'prompt_upsampling',
  'seed',
  'output_format',
  'width',
  'height',
  'aspect_ratio',
  'editModel',
] as const satisfies readonly (keyof GenerateImageToolCall)[];

/**
 * The chat's image selection as POST /api/image-jobs takes it. The top-level settings the send path passes win over
 * `imageConfig` (as the legacy route read them), and `model` is the image model actually chosen for the send.
 */
function buildSelection(
  settings: Partial<GenerateImageToolCall>,
  imageConfig: GenerateImageToolCall | undefined,
  model: GenerateImageToolCall['model']
): GenerateImageToolCall {
  const selection: Partial<GenerateImageToolCall> = { ...imageConfig };
  for (const field of SELECTION_FIELDS) {
    const value = settings[field];
    if (value !== undefined) Object.assign(selection, { [field]: value });
  }
  return { ...selection, model };
}

type ImageJobsSend = (cb: () => Promise<ChatImageJobsResponse>) => Promise<unknown>;

/** Updates the retried quest in place, or shows the new turn optimistically until the route answers. */
function optimisticImageSend(params: {
  queryClient: QueryClient;
  questId?: string;
  sessionId: string | undefined;
  optimisticSessionId?: string;
  prompt: string;
  placeholderPrompt?: string;
}): ImageJobsSend {
  const { queryClient, questId, sessionId, prompt } = params;
  // Reuse the tmpId from useSendMessage when present: generating a fresh id here
  // would key the optimistic placeholder under an id that session.created can't
  // migrate, leaving the assistant turn blank when chunks arrive for the realId.
  const placeholderSessionId = sessionId || params.optimisticSessionId || createOptimisticSessionId();
  if (questId) {
    return cb =>
      updateOptimisticQuest(
        queryClient,
        questId,
        sessionId,
        { replies: [], reply: undefined, prompt, timestamp: new Date(), status: undefined },
        cb
      );
  }
  return cb => createOptimisticQuest(queryClient, placeholderSessionId, params.placeholderPrompt ?? prompt, cb);
}

export async function sendChatImageGeneration(args: ChatImageSendArgs): Promise<void> {
  const {
    params,
    currentSession,
    questId,
    queryClient,
    model,
    workBenchFiles,
    promptFileIds,
    tools,
    organizationId,
    imageConfig,
    optimisticSessionId,
    projectId,
    n,
    ...settings
  } = args as ChatImageSendArgs & { imageConfig?: GenerateImageToolCall };

  const isPromptEnhancementEnabled = tools.includes('prompt_enhancement' as B4MLLMTools);
  const send = optimisticImageSend({
    queryClient,
    questId,
    sessionId: currentSession?.id,
    optimisticSessionId,
    prompt: params,
    placeholderPrompt: isPromptEnhancementEnabled ? `${params}\n\n_Enhancing prompt..._ \u2728` : params,
  });

  // Include message-level (paperclip) attachments, not just notebook-context workbench files,
  // so an image attached inline without the "Add as Notebook Context" toggle still feeds
  // image-to-image models (Kontext/Fill). Mirrors the edit path (sendChatImageEdit).
  const fabFileIds = [...workBenchFiles.map(file => file.id), ...(promptFileIds || [])];

  // Use the image model from imageConfig (which has the correct image-specific model),
  // falling back to the model param only if imageConfig is not available
  const effectiveModel = imageConfig?.model ?? model;

  const requestBody: ChatImageJobsBody = {
    mode: 'generate',
    prompt: params,
    sessionId: currentSession?.id,
    questId,
    projectId,
    selection: buildSelection(settings, imageConfig, effectiveModel),
    count: n,
    promptEnhancement: isPromptEnhancementEnabled,
    fileIds: fabFileIds,
    organizationId,
  };

  try {
    await send(async () => {
      const { data } = await api.post<ChatImageJobsResponse>('/api/image-jobs', requestBody);

      // Surface a one-shot hint when the user clearly wanted to continue from the prior image
      // (resolver classified intent='continuation') but their selected model can't take an image
      // input. Skip when a workbench file is attached, since that overrides session carryforward.
      if (data.intent === 'continuation' && fabFileIds.length === 0) {
        const models = getCachedModels(queryClient);
        const modelInfo = models?.find(m => m.id === effectiveModel);
        // Skip required-input models (e.g. Flux Pro Fill): supportsImageVariation is false but
        // they DO carry a prior image forward, so "can't refine prior images" would be wrong.
        if (modelInfo && !modelInfo.supportsImageVariation && !requiresImageInput(effectiveModel)) {
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
            `This model can't refine prior images \u2014 your prompt was treated as a fresh request. ` +
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
  if (status && status >= 500) return `Server error \u2014 could not ${verbPresent} image. Please try again.`;
  return `${verbPast} failed: ${serverMessage}`;
}

/** Thrown when the image to edit cannot be turned into a clean file of the caller's; the message is user-facing. */
class EditSourceUnavailableError extends Error {}

/** The edit's source file; `created` when this send made it, so the server may delete it once the edit ends. */
type EditSource = { fileId: string; created: boolean };

/** Deletes a file this send made for an edit that will not run; a failure is logged, never thrown over the send's own error. */
async function discardEditInputs(fileIds: readonly string[]): Promise<void> {
  for (const fileId of fileIds) {
    try {
      if (!(await deleteFileUtility(fileId))) console.warn('Could not delete an unused edit input file.', fileId);
    } catch (error) {
      console.warn('Could not delete an unused edit input file.', fileId, error);
    }
  }
}

/** The caller's own clean file behind the shown image, if any: the edit reads it directly instead of a copy. */
async function ownCleanFileId(fileId: string | undefined, userId: string | undefined): Promise<string | undefined> {
  if (!fileId || !userId) return undefined;
  try {
    const file = await getFabFileByIdFromServer(fileId);
    return file.userId === userId && file.moderationStatus === 'clean' ? fileId : undefined;
  } catch (error) {
    console.warn('The image file could not be read; the edit uses a copy instead.', error);
    return undefined;
  }
}

/**
 * An edit job reads its source from the caller's Files, scanned clean. The caller's own file behind the image is used
 * as is; otherwise a generated-bucket image is copied server-side (as the Studio edit does) and any other image the
 * chat shows is fetched and uploaded. A copy is scanned now, since the job refuses an input that is still pending.
 */
async function resolveEditSource(imageUrl: string, imageFileId?: string, userId?: string): Promise<EditSource> {
  const ownFileId = await ownCleanFileId(imageFileId, userId);
  if (ownFileId) return { fileId: ownFileId, created: false };

  const fileName = `image_${Date.now()}.png`;
  const generatedKey = isGeneratedImage(imageUrl) ? extractS3KeyFromUrl(imageUrl) : null;
  const { id, created } = generatedKey
    ? await copyGeneratedImageToFabFile(generatedKey, fileName).then(file => ({
        id: file.id,
        created: file.created === true,
      }))
    : await uploadImageFromUrl(imageUrl, fileName).then(file => ({ id: file.id, created: true }));
  // Never the caller's earlier copy of a generated image: only a file this send made.
  const discardCopy = () => (created ? discardEditInputs([id]) : Promise.resolve());
  let scan: Awaited<ReturnType<typeof moderateFabFileNow>>;
  try {
    scan = await moderateFabFileNow(id);
  } catch (error) {
    await discardCopy();
    throw error;
  }
  if (scan === 'blocked') {
    await discardCopy();
    throw new EditSourceUnavailableError('This image cannot be edited.');
  }
  if (scan === 'pending') {
    await discardCopy();
    throw new EditSourceUnavailableError('The image is still being checked. Try the edit again in a moment.');
  }
  return { fileId: id, created };
}

async function uploadImageFromUrl(imageUrl: string, fallbackName: string) {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new EditSourceUnavailableError('The image to edit could not be loaded.');
  const blob = await response.blob();
  const formData: CreateFabFileRequestInputType = {
    type: KnowledgeType.FILE,
    fileName: fallbackName,
    mimeType: blob.type || 'image/png',
    fileSize: blob.size,
  };
  return createFabFileOnServerWithUpload(formData, new File([blob], fallbackName, { type: formData.mimeType }));
}

/** The in-chat masked edit: `image` is the shown image's URL and the mask is the send's one attached file. */
export async function sendChatImageEdit(args: ChatImageEditArgs): Promise<void> {
  const {
    params,
    image,
    imageFileId,
    userId,
    currentSession,
    questId,
    queryClient,
    promptFileIds,
    organizationId,
    imageConfig,
    optimisticSessionId,
    projectId,
    n,
    ...settings
  } = args as ChatImageEditArgs & { imageConfig?: GenerateImageToolCall };

  const send = optimisticImageSend({
    queryClient,
    questId,
    sessionId: currentSession?.id,
    optimisticSessionId,
    prompt: params,
  });

  const maskFileId = promptFileIds?.[0];
  let editSource: EditSource | undefined;
  let requestSent = false;
  try {
    if (!image) throw new EditSourceUnavailableError('There is no image to edit.');
    editSource = await resolveEditSource(image, imageFileId, userId);
    const requestBody: ChatImageJobsBody = {
      mode: 'edit',
      prompt: params,
      sessionId: currentSession?.id,
      questId,
      projectId,
      // The edit renders with the selection's edit model (FLUX Fill unless one is saved), so the generation model only
      // needs to be a valid image model here.
      selection: buildSelection(settings, imageConfig, imageConfig?.model ?? ImageModels.FLUX_PRO_FILL),
      count: n,
      editSourceFileId: editSource.fileId,
      maskFileId,
      // The mask (uploadEditMask) and a source copy exist only for this edit; the server deletes them once it ends.
      temporaryFileIds: [...(maskFileId ? [maskFileId] : []), ...(editSource.created ? [editSource.fileId] : [])],
      organizationId,
    };
    await send(async () => {
      requestSent = true;
      const { data } = await api.post<ChatImageJobsResponse>('/api/image-jobs', requestBody);
      return data;
    });
  } catch (error) {
    // Once the request is out the server owns the inputs (it deletes them when the edit ends or is refused).
    if (!requestSent) {
      await discardEditInputs([
        ...(maskFileId ? [maskFileId] : []),
        ...(editSource?.created ? [editSource.fileId] : []),
      ]);
    }
    console.error('Error editing image:', error);
    toast.error(error instanceof EditSourceUnavailableError ? error.message : formatImageActionError(error, 'edit'));
    throw error;
  }
}

/** Runs a chat image send of the given mode (chatImageSendMode). */
export async function sendChatImage(mode: 'generate' | 'edit', args: ChatImageEditArgs): Promise<void> {
  // A re-run restarts an existing quest in place; its earlier terminal frame must not mark the new run's updates
  // stale (as handleCommand does for a command).
  if (args.questId) terminalQuests.forget(args.questId);
  return mode === 'edit' ? sendChatImageEdit(args) : sendChatImageGeneration(args);
}

/** A send's dispatch: the chat image send `imageSendMode` names (chatImageSendMode), else the command in `args`. */
export function dispatchSend(
  handlers: CommandHandlers,
  imageSendMode: 'generate' | 'edit' | undefined,
  args: CommandArgs
): ReturnType<typeof handleCommand> {
  return imageSendMode ? sendChatImage(imageSendMode, args) : handleCommand(handlers, args);
}
