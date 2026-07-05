import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import {
  adminSettingsRepository,
  apiKeyRepository,
  rapidReplyMappingRepository,
  rapidReplyResultRepository,
  Connection,
} from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { StatusManager } from '@bike4mind/services';
import { BadRequestError, ClientMessageSender, getSettingsByNames } from '@bike4mind/utils';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { ChatModels } from '@bike4mind/common';
import { Resource } from 'sst';

// OptiHashi sessions get the instant ack even when RapidReply is globally off. When no DB
// mapping is configured for the main model, fall back to a fast Haiku + this
// prompt so the user sees "digging into the data lake" while the full briefing loads.
const OPTI_RAPID_SYSTEM_PROMPT =
  'You are a helpful data-lake assistant. The user just sent a message. ' +
  'Reply with ONE short, warm sentence acknowledging it and saying you are digging into the ' +
  'knowledge base / data lake to pull the details together — you have tools for that. ' +
  'Do NOT answer the question itself; the full briefing is loading separately. ' +
  'Example tone: "Sure — let me dig into the data lake and pull that together for you."';

/**
 * Rapid reply endpoint - generates rapid replies using fast mini models,
 * running in parallel with the main completion for lower TTFVT.
 *
 * This endpoint only saves to the database. The main quest processor
 * handles WebSocket notifications when it detects the rapid reply result.
 */
const handler = baseApi()
  .use(
    rateLimit({
      limit: process.env.NODE_ENV === 'development' ? 200 : 50,
      windowMs: 60 * 1000,
    })
  )
  .post(async (req, res) => {
    const startTime = Date.now();
    const { questId, sessionId, message, model: mainModel, processStartTime, isOpti: isOptiHint } = req.body;
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
              // Capped to 50 below (Math.min(..., 50)); keep the mapping honest at 50.
              maxTokens: 50,
              maxLatency: 2000,
            }
          : null;
      if (!rapidReplyMapping) {
        req.logger.info('⏭️ [RapidReply] No mapping found');
        return res.json({ success: false, reason: 'no_mapping' });
      }

      // 3. Get API keys and check model availability
      const dbAdapters = {
        db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
        getSettingsByNames,
      };
      const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(userId, dbAdapters);
      const models = await getAvailableModels(apiKeyTable);
      const rapidModelId = rapidReplyMapping.rapidModelId;

      const modelInfo = models.find(m => m.id === rapidModelId);
      if (!modelInfo) {
        throw new BadRequestError(
          `Model "${rapidModelId}" is not available. Please select a different model or check your API keys.`
        );
      }

      const rapidLlm = getLlmByModel(apiKeyTable, { modelInfo, logger: req.logger, endUserId: userId });

      if (!rapidLlm) {
        throw new BadRequestError(
          `Model "${rapidModelId}" is not available. Please select a different model or check your API keys.`
        );
      }

      // 5. Generate rapid reply
      const rapidSystemPrompt =
        rapidReplyMapping.systemPrompt ||
        `IMPORTANT: Provide a quick, friendly acknowledgment (1 sentence max). ` +
          `The main AI is loading full context and will provide the complete answer.`;

      const rapidMessages = [
        { role: 'system' as const, content: rapidSystemPrompt },
        { role: 'user' as const, content: message },
      ];

      const rapidOptions = {
        max_tokens: Math.min(rapidReplyMapping.maxTokens || 50, 50),
        temperature: 0.9,
        stream: false,
      };

      const rapidStartTime = Date.now();

      // 6. Generate completion
      let accumulatedText = '';

      await rapidLlm.complete(
        rapidModelId as any,
        rapidMessages,
        rapidOptions,
        async (rapidStreamedTexts: (string | null | undefined)[]) => {
          const rapidText = rapidStreamedTexts[0];
          if (!rapidText) {
            return;
          }
          accumulatedText = rapidText;
        }
      );

      // 7. Save to database after completion
      // The main quest processor will detect this and handle WebSocket notifications
      if (accumulatedText.trim().length === 0) {
        req.logger.warn('⚠️ [RapidReply] Empty response');
        return res.json({ success: false, reason: 'empty_response' });
      }

      const rapidTtfvt = processStartTime ? Date.now() - processStartTime : Date.now() - startTime;
      const rapidLatency = Date.now() - rapidStartTime;

      req.logger.info(`✅ [RapidReply] Generated in ${rapidLatency}ms (TTFVT: ${rapidTtfvt}ms)`);

      // 8. Stream the rapid reply to the frontend via WebSocket
      try {
        const clientMessageSender = new ClientMessageSender({ connections: Connection }, req.logger);
        const statusManager = new StatusManager(
          clientMessageSender,
          req.logger,
          Resource.websocket.managementEndpoint,
          userId
        );

        await statusManager.sendRapidReplyUpdate(questId, sessionId, {
          content: accumulatedText.trim(),
          status: 'completed',
          ttfvt: rapidTtfvt,
          modelId: rapidModelId,
          mappingId: rapidReplyMapping.id,
        });

        req.logger.info(`✅ [RapidReply] Streamed to frontend for quest ${questId}`);
      } catch (streamError) {
        req.logger.error('⚠️ [RapidReply] Failed to stream to frontend:', streamError);
      }

      // 9. Save to database for persistence
      try {
        await rapidReplyResultRepository.create({
          questId,
          sessionId,
          userId,
          mainModelId: mainModel,
          rapidModelId: rapidModelId,
          mappingId: rapidReplyMapping.id,
          rapidResponse: {
            content: accumulatedText.trim(),
            tokenCount: accumulatedText.length,
            latency: rapidLatency,
            cost: 0,
            ttfvt: rapidTtfvt,
          },
          userInteraction: {
            wasShown: true,
            wasReplaced: false,
          },
          metrics: {
            totalLatency: rapidLatency,
            latencySavings: Math.max(0, (rapidReplyMapping.maxLatency || 2000) - rapidLatency),
            ttfvtSavings: 0,
          },
          status: 'success',
        } as any);

        req.logger.info(`✅ [RapidReply] Saved to database for quest ${questId}`);
      } catch (dbError) {
        // Benign on a "blank" rapid reply (questId null) when the rapidreplyresults
        // questId index isn't sparse on this DB: a prior null already exists. The ack was
        // already streamed to the client (step 8), so swallow the dup-key instead of failing
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
      req.logger.error('⚠️ [RapidReply] Failed:', error);

      return res.json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

export default handler;
