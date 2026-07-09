import { userRepository } from '@bike4mind/database';
import { LLMApiRequestBody, redactSessionForClient } from '@bike4mind/common';
import { ChatCompletionInvoke } from '@bike4mind/services';
import { SQSService } from '@bike4mind/utils';
import { getOrCreateSession } from '@server/managers/sessionManager';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { getDefaultChatCompletionOptions, getSharedTokenizer } from '@server/utils/chatCompletionDefaults';
import { dispatchQuest } from '@server/utils/dispatchQuest';
import { loadBaseIdentitySystemPromptMessages } from '@server/utils/systemPrompts/loader';
import { Request } from 'express';

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

    // General chat: give the assistant Bike4Mind's identity so it can pitch the product
    // when asked instead of disowning it. Sessions that carry their own server-owned system
    // prompt (e.g. the /opti surface) already have a specialized persona and their treatment
    // - toolset, prompt, temperature, tool-call cap, integration isolation - rides on generic
    // session fields applied by the completion path, so they skip the generic identity here.
    // Prepended ahead of any client-sent context.
    if (!session.systemPromptText) {
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
