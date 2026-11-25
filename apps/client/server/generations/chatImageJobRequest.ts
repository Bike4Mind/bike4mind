/**
 * Maps a notebook chat image send (POST /api/image-jobs) onto an image job request: which model and mode, which
 * input images, and the saved selection's defaults. The selection mapping itself is the chat image tools'
 * (buildGenerateJobRequest / buildEditJobRequest), so a typed send and a tool call agree on every field.
 */
import {
  BFL_SAFETY_TOLERANCE,
  getImageModelCatalogEntry,
  ImageJobRequestSchema,
  ImageModels,
  isBflImageModel,
  isImageServeable,
  Permission,
  questGenerationJobs,
  resolveLegacyImageModel,
  type GenerateImageToolCall,
  type IChatHistoryItemDocument,
  type ImageModelCatalogEntry,
  type PromptIntent,
} from '@bike4mind/common';
import { FabFile, fabFileRepository, questRepository } from '@bike4mind/database';
import { buildEditJobRequest, buildGenerateJobRequest, type ImageJobRequestDraft } from '@bike4mind/services/llm/tools';
import { resolveImageJobFiles } from '@bike4mind/server-utils/generations/resolveImageJobFiles';
import { copyGeneratedImageToFiles } from '@server/files/copyGeneratedImage';
import { moderateFabFileNow } from '@server/files/moderateFabFileNow';
import type { Request } from 'express';

// Same window the legacy generation path scans for a prior image (ImageGeneration.selectInputImage).
const CARRY_FORWARD_LOOKBACK = 50;

export type ChatImageJobRequest = ImageJobRequestDraft & { safetyTolerance?: number; promptUpsampling?: boolean };

export type ChatImageJobPlan = { ok: true; request: ChatImageJobRequest } | { ok: false; message: string };

type Requester = { id: string; groups?: string[] | null };

/** Turns a legacy generated-bucket image key into a file a job can take as input, or nothing when it cannot. */
export type CarryLegacyImage = (imageS3Key: string) => Promise<string | undefined>;

/**
 * The legacy carry-forward for an image job: the image is saved to the caller's files (with the copy route's
 * permission and access checks and upload budget) and scanned now, since a job refuses an input that is not 'clean'.
 * Carrying is optional, so any failure (no access, over budget or quota, storage) carries nothing rather than failing
 * the send.
 */
export function legacyImageCarrier(req: Request<unknown, unknown, unknown, unknown>): CarryLegacyImage {
  return async imageS3Key => {
    if (!req.ability?.can(Permission.create, FabFile)) return undefined;
    try {
      const { fileId } = await copyGeneratedImageToFiles(req, { imageS3Key });
      const scan = await moderateFabFileNow({ fabFileId: fileId, userId: req.user.id, logger: req.logger });
      if (scan.ok && scan.moderationStatus === 'clean') return fileId;
      req.logger.warn('[image-jobs] legacy image not carried forward', { fileId, scan });
    } catch (error) {
      req.logger.warn('[image-jobs] legacy image could not be carried forward', { imageS3Key, error });
    }
    return undefined;
  };
}

const catalogEntryOf = (model: string): ImageModelCatalogEntry | undefined => {
  const parsed = ImageJobRequestSchema.shape.model.safeParse(model);
  return parsed.success ? getImageModelCatalogEntry(parsed.data) : undefined;
};

const isOwnUsableImage = (
  file: { userId?: string; mimeType?: string | null; moderationStatus?: string | null },
  userId: string
) => file.userId === userId && !!file.mimeType?.startsWith('image') && isImageServeable(file);

/**
 * The images among the send's files, in the order sent. A file the caller cannot read is dropped (as the legacy
 * path drops it); one they can read but do not own is kept, so the job refuses it by name instead of ignoring it.
 */
async function attachedImageIds(fileIds: readonly string[], user: Requester): Promise<string[]> {
  if (fileIds.length === 0) return [];
  const files = await fabFileRepository.findAccessibleInIds([...fileIds], {
    userId: user.id,
    userGroups: user.groups ?? undefined,
  });
  const images = new Set(files.filter(file => file.mimeType?.startsWith('image')).map(file => String(file.id)));
  return [...new Set(fileIds)].filter(id => images.has(id));
}

/**
 * The notebook's newest image a job can take as input, newest turn first: a job-made image, a legacy generated-bucket
 * image (`quest.images`, carried as a file), or an image the caller attached to an earlier turn. The newest image turn
 * decides: one with nothing this caller can use (still running, failed, a collaborator's, or not carriable) ends the
 * search with nothing, since reaching past it would carry forward an older image instead. `excludeQuestId` is a
 * retried turn, whose own previous output must not become its input.
 */
export async function findCarryForwardImageFileId(
  sessionId: string,
  userId: string,
  carryLegacyImage: CarryLegacyImage,
  excludeQuestId?: string
): Promise<string | undefined> {
  const recent: IChatHistoryItemDocument[] = await questRepository.getMostRecentChatHistory(
    sessionId,
    CARRY_FORWARD_LOOKBACK
  );
  const attachedIds = [...new Set(recent.flatMap(quest => quest.fabFileIds ?? []))];
  const usableAttachments = new Set(
    attachedIds.length === 0
      ? []
      : (await fabFileRepository.findAccessibleInIds(attachedIds, { userId }))
          .filter(file => isOwnUsableImage(file, userId))
          .map(file => String(file.id))
  );

  for (const quest of recent) {
    if (quest.type === 'error' || (excludeQuestId && quest.id === excludeQuestId)) continue;
    const imageJobIds = questGenerationJobs(quest)
      .filter(ref => ref.kind === 'image')
      .map(ref => ref.id);
    if (imageJobIds.length > 0) {
      const [made] = await resolveImageJobFiles({ jobIds: imageJobIds, userId });
      return made?.fileId;
    }
    const [legacyImageKey] = quest.images ?? [];
    if (legacyImageKey) return carryLegacyImage(legacyImageKey);
    const attached = (quest.fabFileIds ?? []).find(id => usableAttachments.has(id));
    if (attached) return attached;
  }
  return undefined;
}

/** The saved BFL settings, only for a BFL model; the tolerance is held to the hard cap like BFLImageService does. */
function withBflSettings(request: ImageJobRequestDraft, selection: GenerateImageToolCall): ChatImageJobRequest {
  if (!isBflImageModel(request.model)) return request;
  const tolerance = selection.safety_tolerance;
  return {
    ...request,
    ...(typeof tolerance === 'number' &&
      Number.isFinite(tolerance) && {
        safetyTolerance: Math.min(Math.max(Math.round(tolerance), BFL_SAFETY_TOLERANCE.MIN), BFL_SAFETY_TOLERANCE.MAX),
      }),
    ...(typeof selection.prompt_upsampling === 'boolean' && { promptUpsampling: selection.prompt_upsampling }),
  };
}

/**
 * A typed send. Attached images become references, up to what the model takes; with none attached, a continuation
 * carries the notebook's newest image forward. A model that only edits (FLUX Kontext, Fill) edits that image instead.
 */
export async function planChatImageGeneration(params: {
  selection: GenerateImageToolCall;
  prompt: string;
  fileIds: readonly string[];
  intent: PromptIntent;
  sessionId: string;
  user: Requester;
  carryLegacyImage: CarryLegacyImage;
  /** A retried turn, skipped when looking for the image to carry forward. */
  excludeQuestId?: string;
}): Promise<ChatImageJobPlan> {
  const { selection, prompt, intent, sessionId, user, carryLegacyImage, excludeQuestId } = params;
  const carryForward = () => findCarryForwardImageFileId(sessionId, user.id, carryLegacyImage, excludeQuestId);
  const model = resolveLegacyImageModel(selection.model || ImageModels.GPT_IMAGE_2);
  const modes = catalogEntryOf(model)?.modes;
  const attached = await attachedImageIds(params.fileIds, user);

  if (modes && !modes.generate && modes.edit) {
    const source = attached[0] ?? (await carryForward());
    if (!source) {
      return {
        ok: false,
        message: `${model} edits an existing image: attach one, or generate one in this notebook first.`,
      };
    }
    // The selected model is the edit model here; without a mask, resolveEditJobModel moves Fill to Kontext.
    const request = buildEditJobRequest({ ...selection, editModel: model }, prompt, { image: source }, {});
    return { ok: true, request: withBflSettings(request, selection) };
  }

  const maxReferences = modes?.generate?.inputs.reference?.max ?? 0;
  const carried =
    attached.length === 0 && maxReferences > 0 && intent === 'continuation' ? await carryForward() : undefined;
  const references = attached.length > 0 ? attached.slice(0, maxReferences) : carried ? [carried] : [];
  const request = buildGenerateJobRequest(selection, prompt, {});
  return {
    ok: true,
    request: withBflSettings(
      {
        ...request,
        ...(references.length > 0 && { inputs: references.map(fileId => ({ role: 'reference' as const, fileId })) }),
      },
      selection
    ),
  };
}

/** The in-chat masked edit; with no edit model saved, FLUX Fill, as the legacy edit defaulted to. */
export function planChatImageEdit(params: {
  selection: GenerateImageToolCall;
  prompt: string;
  editSourceFileId: string;
  maskFileId?: string;
}): ChatImageJobPlan {
  const { selection, prompt, editSourceFileId, maskFileId } = params;
  const request = buildEditJobRequest(
    { ...selection, editModel: selection.editModel || ImageModels.FLUX_PRO_FILL },
    prompt,
    { image: editSourceFileId, ...(maskFileId && { mask: maskFileId }) },
    {}
  );
  return { ok: true, request: withBflSettings(request, selection) };
}
