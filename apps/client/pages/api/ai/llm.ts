import { userRepository } from '@bike4mind/database';
import {
  ApiKeyScope,
  LLMApiRequestBody,
  LLMApiRequestBodySchema,
  PROMPT_TEXT_MAX,
  UnprocessableEntityError,
  redactSessionForClient,
} from '@bike4mind/common';
import { ChatCompletionInvoke } from '@bike4mind/services/llm';
import { SQSService } from '@bike4mind/utils';
import { getOrCreateSession } from '@server/managers/sessionManager';
import { resolveSessionOrigin } from '@server/managers/sessionOrigin';
import { resolveBillingOrgId } from '@server/utils/orgAccess';
import { dataLakeToolsDeniedFor } from '@server/dataLakes/dataLakeScopes';
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
// so the gate was promised to users before it existed. Polling the reply works with
// `ai:chat` alone (GET /api/v1/quests/{id} accepts AI_CHAT too), but a fresh account also needs
// `notebooks:write` to create the session via POST /api/v1/sessions. Narrower than the [AI_CHAT, AI_GENERATE]
// pair on the contract surfaces (chat.contract.ts, cli/auth.ts DEFAULT_COMPLETION_SCOPES), which
// accept AI_GENERATE only to preserve legacy completions behavior; that rationale does not
// extend here, since this route is in no contract. Scope checks apply only to API-key requests;
// browser/JWT sessions fall through untouched (see apiKeyAuth).
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');

const handler = baseApi({ requiredScopes: [ApiKeyScope.AI_CHAT] })
  .use(
    rateLimit({
      // More permissive rate limiting in development
      limit: process.env.NODE_ENV === 'development' ? 100 : 10, // 100 req/min in dev vs 10 in prod
      windowMs: 60 * 1000,
    })
  )
  .post(async (req: Request<unknown, unknown, LLMApiRequestBody>, res) => {
    // Checked ahead of the full parse below only so these failures keep their specific codes.
    // Thrown rather than returned so errorHandler logs the rejection - a returned status leaves no
    // line carrying one.
    const { systemPrompt } = req.body;
    if (systemPrompt !== undefined && typeof systemPrompt !== 'string') {
      throw new UnprocessableEntityError('systemPrompt must be a string.', { code: 'SYSTEM_PROMPT_INVALID' });
    }
    if (typeof systemPrompt === 'string' && systemPrompt.length > PROMPT_TEXT_MAX) {
      throw new UnprocessableEntityError(`systemPrompt exceeds the ${PROMPT_TEXT_MAX}-character limit.`, {
        code: 'SYSTEM_PROMPT_TOO_LONG',
      });
    }

    const requestedDenials: unknown = req.body.deniedTools;
    if (requestedDenials !== undefined && !isStringArray(requestedDenials)) {
      throw new UnprocessableEntityError('deniedTools must be an array of strings.', {
        code: 'DENIED_TOOLS_INVALID',
      });
    }

    // Agent ids are session-creation input, checked ahead of the full parse so a malformed value
    // keeps its specific code.
    const requestedAgentIds: unknown = req.body.agentIds;
    if (requestedAgentIds !== undefined && !isStringArray(requestedAgentIds)) {
      throw new UnprocessableEntityError('agentIds must be an array of strings.', {
        code: 'AGENT_IDS_INVALID',
      });
    }

    // Everything that can reject the request runs before getOrCreateSession, so a rejected request
    // leaves no session behind. invoke() parses the body again, but only after that write.
    const body = LLMApiRequestBodySchema.parse(req.body);
    // agentIds is destructured out so a session-creation field never rides into the completion body.
    const { sessionId: reqSessionId, sessionName, agentIds, ...invokeParams } = body;

    // Resolve the billing org from the client-supplied value, rejecting any org the caller is
    // not a member of (a bare body value would otherwise let A bill B's credit pool).
    // null = personal account, undefined = fall back to the caller's own org.
    const effectiveOrgId = await resolveBillingOrgId(req, invokeParams.organizationId);

    const { session, sessionId, asyncPromises } = await getOrCreateSession({
      sessionId: reqSessionId,
      sessionName,
      projectId: body.projectId,
      fabFileIds: body.fabFileIds,
      agentIds,
      origin: resolveSessionOrigin(req),
      user: req.user,
      ability: req.ability,
      logger: req.logger,
    });

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

    // Unioned and placed after the spread, so a client value can only ADD denials; the key's own
    // scope gaps always win.
    const deniedTools = [...(isStringArray(requestedDenials) ? requestedDenials : []), ...dataLakeToolsDeniedFor(req)];

    const quest = await chatCompletion.invoke({
      body: {
        ...invokeParams,
        sessionId,
        organizationId: effectiveOrgId,
        ...(deniedTools.length > 0 ? { deniedTools } : {}),
      },
      userId: req.user.id,
      // Attributes a lake write a tool drives this turn to the key rather than its owner.
      apiKeyId: req.apiKeyInfo?.keyId,
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

    // Pushed only once the quest exists, so a failed invoke() does not move the pointer.
    asyncPromises.push(userRepository.update({ id: req.user.id, lastNotebookId: sessionId }));
    await Promise.all(asyncPromises);

    // Redact server-owned systemPromptText AFTER it has been read above (the base-identity
    // gate) and after the engine has been invoked. Shallow copy - never mutate
    // the in-memory session, which is shared with engine reads.
    return res.json({ quest, session: redactSessionForClient(session) });
  });

export default handler;
