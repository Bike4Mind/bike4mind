import { userRepository } from '@bike4mind/database';
import { ApiKeyScope, LLMApiRequestBody, PROMPT_TEXT_MAX, redactSessionForClient } from '@bike4mind/common';
import { ChatCompletionInvoke } from '@bike4mind/services';
import { SQSService } from '@bike4mind/utils';
import { getOrCreateSession } from '@server/managers/sessionManager';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { getDefaultChatCompletionOptions, getSharedTokenizer } from '@server/utils/chatCompletionDefaults';
import { sessionWillInjectAuthoredPrompt } from '@server/utils/sessionSystemPromptResolver';
import { dispatchQuest } from '@server/utils/dispatchQuest';
import { loadBaseIdentitySystemPromptMessages } from '@server/utils/systemPrompts/loader';
import { Request } from 'express';

// Gate API-key callers on `ai:chat`: this route commissions a billed chat completion
// (ChatCompletionInvoke -> dispatchQuest), so a key minted without chat access must not be able
// to spend here. `apiKeyScopes.ts` already advertises exactly this mapping in the New-Key modal,
// so the gate was promised to users before it existed. An `ai:chat`-only key still drives the
// whole flow - GET /api/quests/{id} accepts AI_CHAT too. Narrower than the [AI_CHAT, AI_GENERATE]
// pair on the contract surfaces (chat.contract.ts, cli/auth.ts DEFAULT_COMPLETION_SCOPES), which
// accept AI_GENERATE only to preserve legacy completions behavior; that rationale does not
// extend here, since this route is in no contract. Scope checks apply only to API-key requests;
// browser/JWT sessions fall through untouched (see apiKeyAuth).
const handler = baseApi({ requiredScopes: [ApiKeyScope.AI_CHAT] })
  .use(
    rateLimit({
      // More permissive rate limiting in development
      limit: process.env.NODE_ENV === 'development' ? 100 : 10, // 100 req/min in dev vs 10 in prod
      windowMs: 60 * 1000,
    })
  )
  .post(async (req: Request<unknown, unknown, LLMApiRequestBody>, res) => {
    const { sessionId: reqSessionId, sessionName, ...invokeParams } = req.body;

    // This route has never parsed its body - it spreads req.body straight into the invoke params.
    // `systemPrompt` reaches the same injection path as POST /api/chat, where the contract rejects
    // an oversized value with a 422 before anything is created. Here the only enforcement is
    // QuestStartBodySchema, which runs AFTER the quest row is written and whose ZodError is caught
    // and turned into an errored quest returned with a 200 - so without this check an oversized
    // value looks like success and leaves a junk row. Checked before getOrCreateSession so a
    // rejected request creates nothing at all.
    if (typeof req.body.systemPrompt === 'string' && req.body.systemPrompt.length > PROMPT_TEXT_MAX) {
      return res.status(422).json({
        error: 'Unprocessable Entity',
        message: `systemPrompt exceeds the ${PROMPT_TEXT_MAX}-character limit.`,
        code: 'SYSTEM_PROMPT_TOO_LONG',
      });
    }

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

    // General chat gets the brand identity so it can pitch the product when asked. A session that
    // carries its OWN authored prompt skips it - either raw `systemPromptText` (e.g. the /opti
    // surface) or a curated registry prompt via `systemPromptId` (e.g. the triage router, which the
    // completion path resolves + injects on every entry point) - so its persona isn't diluted.
    // RESOLVES the id rather than testing membership: an allowlisted id an admin has disabled (or a
    // lake bound to a since-delisted id) would otherwise suppress the identity here while the
    // completion path injects nothing, leaving the session with no system prompt at all.
    // Prepended ahead of any client-sent context.
    if (!(await sessionWillInjectAuthoredPrompt(session))) {
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
