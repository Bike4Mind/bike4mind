import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { blockedAtZeroTierLimit } from '@server/middlewares/perUserRateLimit';
import { adminSettingsRepository, rapidReplyMappingRepository, questRepository, Connection } from '@bike4mind/database';
import { StatusManager } from '@bike4mind/services/llm/StatusManager';
import { ClientMessageSender } from '@bike4mind/utils';
import {
  generateRapidReply,
  RAPID_REPLY_MAX_MESSAGE_CHARS,
  saveRapidReplyResult,
} from '@server/rapidReply/generateRapidReply';
import { assertSessionAccess } from '@bike4mind/server-utils/utils/sessionAccess';
import { ChatModels, NotFoundError, isTerminalCreditRefusal } from '@bike4mind/common';
import { Resource } from 'sst';
import { z } from 'zod';
import { assertAiAccessAllowed } from '@bike4mind/server-utils/auth/assertAiAccessAllowed';
import { createRequestCompletionMeter } from '@server/billing/meterPlatformCompletion';

const rapidReplyMessageSchema = z.string().transform(m => m.slice(0, RAPID_REPLY_MAX_MESSAGE_CHARS));

// OptiHashi sessions get the instant ack even when RapidReply is globally off. When no DB
// mapping is configured for the main model, fall back to a fast Haiku + this prompt so the
// user sees a quick, request-specific ack while the full briefing loads.
const OPTI_RAPID_SYSTEM_PROMPT =
  'You are a helpful assistant. The user just sent a message. ' +
  'Reply with ONE short sentence that acknowledges their specific request - refer to its actual ' +
  'subject rather than a generic greeting. Vary the phrasing and sentence structure each time; ' +
  'do not reuse the same wording across replies. ' +
  'Do NOT mention searching, the knowledge base, or the data lake unless the user message is ' +
  'explicitly about their own files, documents, or data. ' +
  'Do NOT answer the question itself; the full response is loading separately.';

/**
 * Rapid reply endpoint - generates rapid replies using fast mini models,
 * running in parallel with the main completion for lower TTFVT.
 *
 * This endpoint only saves to the database. The main quest processor
 * handles WebSocket notifications when it detects the rapid reply result.
 */
// SPA-only, so it stays off the API-key surface.
const handler = baseApi({ auth: 'jwtOnly' })
  .use(
    rateLimit({
      limit: blockedAtZeroTierLimit(process.env.NODE_ENV === 'development' ? 200 : 50),
      windowMs: 60 * 1000,
    })
  )
  .post(async (req, res) => {
    assertAiAccessAllowed(req.user);
    const startTime = Date.now();
    const { questId, sessionId, model: mainModel, processStartTime, isOpti: isOptiHint } = req.body;
    // Security: never trust a body-supplied userId - it drives API-key resolution, websocket
    // routing, and DB persistence, so a spoofed id could consume another user's keys or send
    // updates to the wrong user. Always use the authenticated user.
    const userId = req.user.id;
    // The OptiHashi bypass of the global RapidReply toggle must be gated on a real server-side
    // signal, not just the client hint - otherwise any caller could opt in by sending isOpti:true.
    const normalizedTags = (req.user.tags || []).map((t: string) => t.toLowerCase());
    const hasOptiAccess =
      req.user.isAdmin || normalizedTags.some((t: string) => ['opti', 'developer', 'developers', 'dev'].includes(t));
    const isOpti = isOptiHint === true && hasOptiAccess;

    req.logger.info(`🚀 [RapidReply] Endpoint invoked for quest ${questId || 'new quest'}${isOpti ? ' (opti)' : ''}`);

    // Object-level authz: bind the caller-supplied ids to the caller before we persist a
    // rapid-reply row or stream it over the websocket. Resolve the quest first so a supplied
    // questId is always validated - even when sessionId is omitted, because the row persisted below
    // is keyed on questId and a spoofed one would otherwise be a cross-tenant write. The session
    // gate falls back to the quest's own session, so dropping sessionId from the body cannot skip
    // it. Outside the try below so a cross-tenant attempt surfaces as a real 403/404 rather than a
    // soft {success:false}.
    const quest = questId ? await questRepository.findById(questId) : null;
    if (questId && !quest) {
      // Uniform message with the session gate below: quest existence must not be an oracle (a
      // nonexistent vs an existing-but-forbidden questId would otherwise return different bodies).
      throw new NotFoundError('Session not found');
    }
    // Write-level: this persists a rapid-reply row keyed on questId that surfaces in the session's
    // history, so a read-only sharee (or any user on an isGlobalRead session) must not reach it -
    // matching the update-level gate the main completion path uses (canUpdateShareable). Skip the
    // gate ONLY for the genuinely id-less blank ack (a brand-new session with no questId): with
    // neither id there is nothing to bind, and no persisted row that could be cross-tenant.
    const boundSessionId = sessionId ?? quest?.sessionId;
    if (boundSessionId || questId) {
      await assertSessionAccess(boundSessionId, userId, 'write', req.user.groups ?? []);
    }
    if (quest && sessionId && quest.sessionId !== sessionId) {
      throw new NotFoundError('Session not found');
    }

    try {
      // 1. Feature toggle - OptiHashi sessions bypass the global toggle (scoped enablement)
      // so the sales surface gets the instant ack without turning RapidReply on platform-wide.
      const adminSettings = await adminSettingsRepository.getSettingsValue('EnableRapidReply');
      const rapidReplyEnabled = adminSettings === true;
      const userPreference = (req.user as any).preferences?.experimentalFeatures?.rapidReply !== false;

      if (!isOpti && (!rapidReplyEnabled || !userPreference)) {
        req.logger.info('⏭️ [RapidReply] Feature disabled');
        return res.json({ success: false, reason: 'disabled' });
      }

      // 2. Resolve mapping - OptiHashi falls back to a fast Haiku + sales ack prompt when no
      // DB mapping is configured for the main model (e.g. Opus 4.8 has no seeded mapping).
      const dbMapping = await rapidReplyMappingRepository.findByMainModel(mainModel);
      const rapidReplyMapping = dbMapping?.enabled
        ? dbMapping
        : isOpti
          ? {
              id: 'opti-fallback',
              rapidModelId: ChatModels.CLAUDE_4_5_HAIKU_BEDROCK,
              systemPrompt: OPTI_RAPID_SYSTEM_PROMPT,
              // generateRapidReply caps at 50 anyway; keep the mapping honest at 50.
              maxTokens: 50,
              maxLatency: 2000,
            }
          : null;
      if (!rapidReplyMapping) {
        req.logger.info('⏭️ [RapidReply] No mapping found');
        return res.json({ success: false, reason: 'no_mapping' });
      }

      const parsedMessage = rapidReplyMessageSchema.safeParse(req.body.message);
      if (!parsedMessage.success) {
        return res.json({ success: false, reason: 'invalid_message' });
      }

      // 3. Resolve the rapid model and generate the ack
      const generation = await generateRapidReply({
        mapping: rapidReplyMapping,
        message: parsedMessage.data,
        userId,
        logger: req.logger,
        meter: createRequestCompletionMeter(req, 'rapid reply', { systemModel: true }),
      });
      if (generation.status === 'skipped') {
        if (generation.reason === 'empty_response') {
          req.logger.warn('[RapidReply] Empty response');
        }
        return res.json({ success: false, reason: generation.reason });
      }
      const { modelId: rapidModelId, latency: rapidLatency, content: rapidContent } = generation;

      const rapidTtfvt = processStartTime ? Date.now() - processStartTime : Date.now() - startTime;

      req.logger.info(`✅ [RapidReply] Generated in ${rapidLatency}ms (TTFVT: ${rapidTtfvt}ms)`);

      // 4. Stream the rapid reply to the frontend via WebSocket
      try {
        const clientMessageSender = new ClientMessageSender({ connections: Connection }, req.logger);
        const statusManager = new StatusManager(
          clientMessageSender,
          req.logger,
          Resource.websocket.managementEndpoint,
          userId
        );

        await statusManager.sendRapidReplyUpdate(questId, sessionId, {
          content: rapidContent,
          status: 'completed',
          ttfvt: rapidTtfvt,
          modelId: rapidModelId,
          mappingId: rapidReplyMapping.id,
        });

        req.logger.info(`✅ [RapidReply] Streamed to frontend for quest ${questId}`);
      } catch (streamError) {
        req.logger.error('⚠️ [RapidReply] Failed to stream to frontend:', streamError);
      }

      // 5. Save to database for persistence
      try {
        await saveRapidReplyResult({
          questId,
          sessionId,
          userId,
          mainModelId: mainModel,
          mapping: rapidReplyMapping,
          generation,
          ttfvt: rapidTtfvt,
        });

        req.logger.info(`✅ [RapidReply] Saved to database for quest ${questId}`);
      } catch (dbError) {
        // Benign on a "blank" rapid reply (questId null) when the rapidreplyresults
        // questId index isn't sparse on this DB: a prior null already exists. The ack was
        // already streamed to the client (step 4), so swallow the dup-key instead of failing
        // the request. Proper fix is the sparse-index migration. Only swallow for the blank
        // (questId-less) case; a dup-key on a real quest-scoped reply is a genuine
        // persistence bug and must surface.
        const code = (dbError as { code?: number })?.code;
        if (code === 11000 && !questId) {
          req.logger.info('ℹ️ [RapidReply] Skipped duplicate blank rapid-reply (questId null) — non-fatal');
        } else {
          req.logger.error('⚠️ [RapidReply] DB save failed:', dbError);
          throw dbError;
        }
      }

      return res.json({
        success: true,
        latency: Date.now() - startTime,
      });
    } catch (error) {
      // Best-effort like every other refusal here: the chat proceeds without the ack.
      if (isTerminalCreditRefusal(error)) {
        const reason = (error as { additionalInfo: { errorCode: string } }).additionalInfo.errorCode;
        req.logger.info(`[RapidReply] Credit refusal (${reason}), skipping`);
        return res.json({ success: false, reason });
      }

      // Deliberately error-severity: everything routinely-degradable (no mapping, a sunset or
      // disabled rapid model, no reachable fallback) now returns early at info/warn above, so
      // only genuine faults reach here - a DB write failure, an unexpected throw from the
      // provider. Do not downgrade this to hide a noisy model-availability case; fix the case.
      req.logger.error('⚠️ [RapidReply] Failed:', error);

      return res.json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

export default handler;
