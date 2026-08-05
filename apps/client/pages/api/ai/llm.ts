import { userRepository } from '@bike4mind/database';
import { LLMApiRequestBody, redactSessionForClient } from '@bike4mind/common';
import { ChatCompletionInvoke } from '@bike4mind/services';
import { SQSService } from '@bike4mind/utils';
import { getOrCreateSession } from '@server/managers/sessionManager';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { getDefaultChatCompletionOptions, getSharedTokenizer } from '@server/utils/chatCompletionDefaults';
import { dispatchQuest } from '@server/utils/dispatchQuest';
import {
  loadBaseIdentitySystemPromptMessages,
  loadSystemPromptContent,
  buildSystemPromptMessage,
} from '@server/utils/systemPrompts/loader';
import { Request } from 'express';

// Registry prompts a session may activate via `session.systemPromptId`. An allowlist, not an open
// door: a session must not be able to inject an arbitrary admin/system prompt, so only ids meant to
// be session-scoped modes live here. `triage_router` is the grounding-first request router.
const SESSION_ACTIVATABLE_PROMPT_IDS = new Set<string>(['triage_router']);

const handler = baseApi()
  .use(
    rateLimit({
      // More permissive rate limiting in development
      limit: process.env.NODE_ENV === 'development' ? 100 : 10, // 100 req/min in dev vs 10 in prod
      windowMs: 60 * 1000,
    })
  )
  .post(async (req: Request<unknown, unknown, LLMApiRequestBody>, res) => {
    const { sessionId: reqSessionId, sessionName, ...invokeParams } = req.body;

    const { session, sessionId, asyncPromises } = await getOrCreateSession({
      sessionId: req.body.sessionId,
      sessionName: req.body.sessionName,
      projectId: req.body.projectId,
      fabFileIds: req.body.fabFileIds ?? [],
      user: req.user,
      ability: req.ability,
      logger: req.logger,
    });

    // Update the user's last notebook ID
    asyncPromises.push(userRepository.update({ id: req.user.id, lastNotebookId: sessionId }));

    // A session gets ONE authored voice, prepended ahead of any client-sent context:
    //  - `systemPromptId` -> a curated registry prompt (e.g. the triage router), resolved to its
    //    CURRENT content here so admin edits take effect with no deploy;
    //  - else `systemPromptText` -> a raw server-owned prompt (e.g. the /opti surface), injected by
    //    the completion path itself;
    //  - else the generic brand identity, so plain chat can pitch the product when asked.
    // A session that carries either of its own prompts skips the identity (same as before).
    const activatablePromptId =
      session.systemPromptId && SESSION_ACTIVATABLE_PROMPT_IDS.has(session.systemPromptId)
        ? session.systemPromptId
        : undefined;
    if (activatablePromptId) {
      const resolved = await loadSystemPromptContent(activatablePromptId);
      if (resolved) {
        invokeParams.extraContextMessages = [
          buildSystemPromptMessage(activatablePromptId, resolved.content),
          ...(invokeParams.extraContextMessages ?? []),
        ];
      }
    } else if (!session.systemPromptText) {
      const identityPrompts = await loadBaseIdentitySystemPromptMessages(req.logger);
      if (identityPrompts.length > 0) {
        invokeParams.extraContextMessages = [...identityPrompts, ...(invokeParams.extraContextMessages ?? [])];
      }
    }

    const chatCompletion = new ChatCompletionInvoke({
      ...getDefaultChatCompletionOptions(),
      queue: new SQSService(), // Create per-request to ensure fresh credentials
      tokenizer: getSharedTokenizer(req.logger),
      user: req.user,
      sessionId,
      logger: req.logger,
      invokeLambda: async params => {
        // Hand the quest to the always-on ChatCompletion (HTTP, 202 ACK).
        // Replaces the EventBridge -> Lambda path to eliminate cold starts.
        await dispatchQuest(params, req.logger);
      },
    });

    // Call invoke with the proper structure, matching what the frontend sends
    // organizationId: null means personal account (no org), undefined means not sent (fall back to user's org)
    // Note: req.user.organizationId is a MongoDB ObjectId, must convert to string for Zod validation
    const effectiveOrgId =
      invokeParams.organizationId !== undefined
        ? invokeParams.organizationId
        : (req.user.organizationId?.toString() ?? null);

    const quest = await chatCompletion.invoke({
      body: {
        ...invokeParams,
        sessionId,
        organizationId: effectiveOrgId,
      },
      userId: req.user.id,
    });

    // Handle case where quest creation failed (session or quest not found during invoke)
    if (!quest) {
      req.logger.error('Quest creation failed - invoke returned undefined (session or quest not found)');
      return res.status(404).json({
        error: 'Session not found',
        message: 'The session may have been deleted or expired. Please start a new session.',
        code: 'SESSION_NOT_FOUND',
      });
    }

    await Promise.all(asyncPromises);

    // Redact server-owned systemPromptText AFTER it has been read above (the base-identity
    // gate) and after the engine has been invoked. Shallow copy - never mutate
    // the in-memory session, which is shared with engine reads.
    return res.json({ quest, session: redactSessionForClient(session) });
  });

export default handler;
