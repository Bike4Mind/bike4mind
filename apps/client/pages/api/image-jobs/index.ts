/**
 * POST /api/image-jobs - a notebook chat send with an image model selected, or the in-chat masked edit: creates the
 * chat turn (quest) and `count` image jobs on it, which the chat renders as job cards (GeneratedJobs ->
 * ImageJobCard, polling GET /api/image-jobs/[id]).
 *
 * Internal: a signed-in session (no API key) and not behind the Studio flag, like GET /api/image-jobs/[id]. The
 * legacy /api/ai/generate-image and /api/ai/edit-image routes stay for API callers. Validation, billing and the job
 * lifecycle live in createImageJobs; a request the model cannot honour answers 422 with every why-not reason.
 */
import { z } from 'zod';
import {
  ChatImageJobsBodySchema,
  IMAGE_JOB_PROMPT_MAX_CHARS,
  TERMINAL_GENERATION_JOB_STATES,
  chatMessageResponseSchema,
  questGenerationJobs,
  redactChatMessageForViewer,
  redactSessionForClient,
  type ChatImageJobsBody,
  type ChatImageJobsResponse,
  type GenerationJobRef,
  type IChatHistoryItemDocument,
  type PromptIntent,
} from '@bike4mind/common';
import { generationJobRepository, questRepository } from '@bike4mind/database';
import { createImageJobs } from '@bike4mind/services/imageJobs';
import { assertAiAccessAllowed } from '@bike4mind/server-utils/auth/assertAiAccessAllowed';
import { getCreateImageJobsDeps } from '@bike4mind/server-utils/generationJobs/wiring';
import { discardJobInputFiles } from '@bike4mind/server-utils/generationJobs/discardJobInputFiles';
import { imageJobRefusalBody } from '@bike4mind/server-utils/generationJobs/studioImageJobResponse';
import { getOrCreateSession } from '@bike4mind/server-utils/managers/sessionManager';
import { assertNoStrayBillingOrgKeys, resolveBillingOrgInput } from '@bike4mind/server-utils/utils/orgAccess';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { resolveMediaBillingOrgId } from '@server/billing/resolveMediaBillingOrgId';
import { resolveSessionOrigin } from '@server/managers/sessionOrigin';
import { clampImageCount } from '@bike4mind/services/llm/tools';
import {
  legacyImageCarrier,
  planChatImageEdit,
  planChatImageGeneration,
  type ChatImageJobPlan,
} from '@server/generations/chatImageJobRequest';
import {
  broadcastChatImageQuest,
  maybeSummarizeAfterChatImage,
  nameNotebookAfterChatImage,
} from '@server/generations/chatImageQuestFollowUps';
import { HISTORY_LOOKBACK, resolveImagePrompt, type PromptResolution } from '@server/utils/resolveImagePrompt';

type ResolvedPrompt = {
  /** What the image model receives. */
  effectivePrompt: string;
  promptWasEnhanced: boolean;
  intent?: PromptIntent;
};

/**
 * The legacy generation route's rules (pages/api/v1/image-generations.ts): a continuation always takes the resolver's
 * rewrite, since the literal text does not carry the subject; a fresh prompt only with prompt_enhancement on. An
 * edit takes its prompt literally, as the legacy edit path did.
 */
async function resolvePrompt(
  body: ChatImageJobsBody,
  context: {
    sessionId: string;
    contextSummary?: string | null;
    userId: string;
    logger: Parameters<typeof resolveImagePrompt>[0]['logger'];
  }
): Promise<ResolvedPrompt> {
  if (body.mode === 'edit') return { effectivePrompt: body.prompt, promptWasEnhanced: false };
  const recentMessages = await questRepository.getMostRecentChatHistory(context.sessionId, HISTORY_LOOKBACK);
  const resolution: PromptResolution = await resolveImagePrompt({
    originalPrompt: body.prompt,
    recentMessages,
    sessionSummary: context.contextSummary ?? null,
    logger: context.logger,
    endUserId: context.userId,
  });
  const useRewrite = resolution.intent === 'continuation' || body.promptEnhancement === true;
  const effectivePrompt = useRewrite ? resolution.rewrittenPrompt : body.prompt;
  return { effectivePrompt, promptWasEnhanced: effectivePrompt !== body.prompt, intent: resolution.intent };
}

const FILE_ID_PATTERN = /^[0-9a-f]{24}$/;

/** Only the fields that name an edit's inputs, so they stay readable from a body the full schema rejects. */
const EditInputIdsSchema = z.object({
  mode: z.literal('edit'),
  editSourceFileId: z.string().regex(FILE_ID_PATTERN),
  maskFileId: z.string().regex(FILE_ID_PATTERN).optional(),
  temporaryFileIds: z.array(z.string().regex(FILE_ID_PATTERN)).max(2).optional(),
});

/**
 * The edit's inputs the send made only for this edit; any other id the body lists is ignored, so a send can only
 * mark its own two inputs, and discardJobInputFiles deletes only what the caller owns. Reads the raw body, so the
 * inputs of a request refused before or after validation are still found.
 */
function temporaryInputIds(rawBody: unknown): string[] {
  const parsed = EditInputIdsSchema.safeParse(rawBody);
  if (!parsed.success) return [];
  const { editSourceFileId, maskFileId, temporaryFileIds } = parsed.data;
  const inputs = new Set([editSourceFileId, ...(maskFileId ? [maskFileId] : [])]);
  return [...new Set(temporaryFileIds ?? [])].filter(id => inputs.has(id));
}

/** Whether any job the retried turn started is still running; a retry then would leave it orphaned. */
async function hasUnfinishedJobs(quest: IChatHistoryItemDocument): Promise<boolean> {
  const jobs = await Promise.all(questGenerationJobs(quest).map(ref => generationJobRepository.findById(ref.id)));
  return jobs.some(job => job && !TERMINAL_GENERATION_JOB_STATES.includes(job.state));
}

/** A retried quest must be a turn of the session the caller just passed the access check for. */
async function findRetriedQuest(questId: string, sessionId: string): Promise<IChatHistoryItemDocument> {
  const quest = await questRepository.findById(questId);
  if (!quest || quest.sessionId !== sessionId) throw new NotFoundError('Quest not found');
  return quest;
}

const handler = baseApi({ auth: 'jwtOnly' }).post(
  perUserRateLimit('POST /api/image-jobs'),
  asyncHandler(async (req, res) => {
    // The mask and a source copy were uploaded before this request, so every exit that does not hand them to the
    // job engine deletes them.
    const temporaryInputs = temporaryInputIds(req.body);
    let inputsHandedToJobs = false;
    try {
      assertAiAccessAllowed(req.user);
      // Loud rejection before any session or billing work, as on the legacy route.
      assertNoStrayBillingOrgKeys(req.body);
      const parsed = ChatImageJobsBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'Invalid request' });
      }
      const body = parsed.data;

      // Before getOrCreateSession, so a refused payer never leaves behind a new, empty notebook.
      const organizationId = await resolveMediaBillingOrgId(req, resolveBillingOrgInput(body));
      const { sessionId, asyncPromises, session } = await getOrCreateSession({
        sessionId: body.sessionId,
        projectId: body.projectId,
        user: req.user,
        ability: req.ability,
        logger: req.logger,
        origin: resolveSessionOrigin(req),
      });
      const retried = body.questId ? await findRetriedQuest(body.questId, sessionId) : undefined;
      if (retried && (await hasUnfinishedJobs(retried))) {
        return res.status(409).json({
          error: 'jobs_still_running',
          message: 'This turn is still generating. Retry it once its images have finished.',
        });
      }

      const { effectivePrompt, promptWasEnhanced, intent } = await resolvePrompt(body, {
        sessionId,
        contextSummary: session?.contextSummary || session?.summary,
        userId: req.user.id,
        logger: req.logger,
      });
      const jobPrompt = effectivePrompt.slice(0, IMAGE_JOB_PROMPT_MAX_CHARS);
      const plan: ChatImageJobPlan =
        body.mode === 'edit'
          ? planChatImageEdit({
              selection: body.selection,
              prompt: jobPrompt,
              editSourceFileId: body.editSourceFileId,
              maskFileId: body.maskFileId,
            })
          : await planChatImageGeneration({
              selection: body.selection,
              prompt: jobPrompt,
              fileIds: body.fileIds ?? [],
              intent: intent ?? 'fresh',
              sessionId,
              user: req.user,
              carryLegacyImage: legacyImageCarrier(req),
              excludeQuestId: retried?.id,
            });
      if (!plan.ok) return res.status(422).json({ error: 'missing_input_image', message: plan.message });

      const promptEnhancement = {
        originalPrompt: body.prompt,
        enhancedPrompt: effectivePrompt,
        promptWasEnhanced,
        ...(intent && { intent }),
      };
      const promptMeta = {
        model: { name: plan.request.model, type: 'image' as const },
        session: { id: sessionId, userId: req.user.id },
        prompt: jobPrompt,
      };
      // A new turn exists before its jobs (each job carries the quest id), so a refusal removes it again.
      const quest =
        retried ??
        (await questRepository.create({
          sessionId,
          prompt: body.prompt,
          type: 'message',
          timestamp: new Date(),
          replies: [],
          promptMeta,
          promptEnhancement,
        }));

      const result = await createImageJobs(
        {
          user: { id: req.user.id, organizationId },
          request: plan.request,
          count: clampImageCount(body.count).count,
          // Chat-made, like the chat image tools' jobs: no Studio completion notice or Studio group push.
          source: 'agent',
          questId: quest.id,
          ...(temporaryInputs.length > 0 && { discardInputFileIds: temporaryInputs }),
        },
        getCreateImageJobsDeps()
      ).catch(async (error: unknown) => {
        if (!retried) await questRepository.delete(quest.id);
        throw error;
      });
      if (!result.ok) {
        if (!retried) await questRepository.delete(quest.id);
        return res.status(result.status).json(imageJobRefusalBody(result));
      }

      inputsHandedToJobs = true;
      const generationJobs: GenerationJobRef[] = result.jobs.map(job => ({ id: job.id, kind: 'image' }));
      // Settled at once: the job cards carry the progress, so the turn itself shows no spinner. A retry replaces the
      // previous run's jobs and output rather than adding to them.
      const settle = () =>
        questRepository.update(
          {
            id: quest.id,
            status: 'done',
            type: 'message',
            prompt: body.prompt,
            images: [],
            replies: [],
            generationJobs,
            promptMeta,
            promptEnhancement,
          },
          { unset: ['errorCode', 'reply'] }
        );
      // The jobs are started and billed, so a failed write must not fail the send: the response still carries the turn
      // with its jobs, which the requester's chat renders.
      const updated = await settle()
        .catch(() => settle())
        .catch((error: unknown) => {
          req.logger.error('[image-jobs] could not link the started jobs to their turn', {
            questId: quest.id,
            jobIds: generationJobs.map(ref => ref.id),
            error,
          });
          return null;
        });
      const settledQuest: IChatHistoryItemDocument = updated ?? {
        ...quest,
        status: 'done',
        prompt: body.prompt,
        images: [],
        replies: [],
        generationJobs,
      };

      // A retry can settle the owner's turn for an edit-share user, so the turn goes out as every other chat
      // route sends it: response fields only, owner-only data withheld from a non-owner.
      const response: ChatImageJobsResponse = {
        quest: chatMessageResponseSchema.parse(
          redactChatMessageForViewer(settledQuest, session.userId === req.user.id)
        ) as IChatHistoryItemDocument,
        session: redactSessionForClient(session),
        originalPrompt: body.prompt,
        enhancedPrompt: effectivePrompt,
        promptWasEnhanced,
        ...(intent && { intent }),
        groupId: result.groupId,
        jobs: result.jobs.map(job => ({ id: job.id, groupId: job.payload.groupId ?? null, state: job.state })),
      };

      // Best-effort, after the response is fixed: none of these may turn a started, billed job into an error.
      const followUps = await Promise.allSettled([
        ...asyncPromises,
        broadcastChatImageQuest(req.user.id, settledQuest, req.logger),
        // The legacy edit neither named nor summarised the notebook, so only a generation does.
        ...(body.mode === 'generate'
          ? [
              nameNotebookAfterChatImage(sessionId, req.user.id, req.logger),
              maybeSummarizeAfterChatImage(session, req.user.id, req.logger),
            ]
          : []),
      ]);
      for (const outcome of followUps) {
        if (outcome.status === 'rejected') {
          req.logger.warn('[image-jobs] a follow-up after the send failed', {
            questId: quest.id,
            error: outcome.reason,
          });
        }
      }

      return res.status(result.created ? 202 : 200).json(response);
    } finally {
      if (!inputsHandedToJobs) await discardJobInputFiles(req.user.id, temporaryInputs, req.logger);
    }
  })
);

export const config = {
  api: { externalResolver: true },
};

export default handler;
