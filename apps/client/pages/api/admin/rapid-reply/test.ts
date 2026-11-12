import { rapidReplyMappingRepository } from '@bike4mind/database/ai';
import { rapidReplyPromptRepository } from '@bike4mind/database/ai';
import { adminSettingsRepository } from '@bike4mind/database/infra';
import { rapidReplyAuditLogRepository } from '@bike4mind/database/ai';
import { ChatCompletionProcess, featureNames, ChatCompletionFeature } from '@bike4mind/services/llm';
import { adminApi } from '@server/middlewares/adminApi';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { requestTurnAuth } from '@server/auth/turnAuth';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { getDefaultChatCompletionOptions, getSharedTokenizer } from '@server/utils/chatCompletionDefaults';
import { rapidReplyResultRepository, sessionRepository } from '@bike4mind/database';
import { generateRapidReply, saveRapidReplyResult } from '@server/rapidReply/generateRapidReply';
import { createRequestCompletionMeter } from '@server/billing/meterPlatformCompletion';
import { ApiKeyScope, ttfvtState } from '@bike4mind/common';
import { SQSService } from '@bike4mind/utils';

interface TestConfiguration {
  mainModelId: string;
  testInput?: string;
  skipRapidReply?: boolean;
  simulateLatency?: number;
}

const handler = adminApi({
  adminPermissions: { POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .use(
    rateLimit({
      limit: 5,
      windowMs: 60 * 1000,
    })
  )
  .post(async (req, res) => {
    const {
      mainModelId,
      testInput = 'Test message for rapid reply configuration',
      simulateLatency = 0,
    } = req.body as TestConfiguration;

    if (!mainModelId) {
      throw new BadRequestError('mainModelId is required for testing');
    }

    // mainModelId comes straight from the body, so bound it before it lands in the audit entry.
    const auditModelId = String(mainModelId).slice(0, 200);
    const recordTestRun = async (success: boolean) =>
      recordAdminActionFromRequest(req, {
        action: 'settings.rapid_reply.test_run',
        target: { kind: 'settings', id: auditModelId, displayName: `Rapid reply test for ${auditModelId}` },
        summary: `ran rapid reply test for ${auditModelId}`,
        details: {
          mainModelId: auditModelId,
          success,
          simulateLatencyMs: Number.isFinite(simulateLatency) ? simulateLatency : undefined,
        },
      });
    const recordFailedRunAndRethrow = async (error: unknown): Promise<never> => {
      await recordTestRun(false);
      throw error;
    };

    const [settings, enableRapidReply] = await Promise.all([
      adminSettingsRepository.getSettingsValue('RapidReplySettings'),
      adminSettingsRepository.getSettingsValue('EnableRapidReply'),
    ]).catch(recordFailedRunAndRethrow);
    if (!settings) {
      return recordFailedRunAndRethrow(new Error('Rapid Reply settings not found. Please configure settings first.'));
    }

    // Same toggle chat reads in pages/api/ai/rapid-reply.ts; RapidReplySettings.enabled is never written.
    const globalEnabled = enableRapidReply === true;
    if (!globalEnabled) {
      await recordTestRun(false);
      return res.json({
        success: false,
        message: 'Rapid Reply is currently disabled in settings',
        testResults: {
          enabled: false,
          reason: 'System disabled',
        },
        recommendations: ['Enable Rapid Reply in settings to test functionality'],
      });
    }

    // Find mapping for the main model
    const mapping = await rapidReplyMappingRepository.findByMainModel(mainModelId).catch(recordFailedRunAndRethrow);
    if (!mapping) {
      await recordTestRun(false);
      return res.json({
        success: false,
        message: `No Rapid Reply mapping found for model: ${mainModelId}`,
        testResults: {
          enabled: false,
          reason: 'No mapping configured',
          mainModelId,
        },
        recommendations: [
          `Create a Rapid Reply mapping for ${mainModelId}`,
          'Configure a rapid model (e.g., gpt-4o-mini, claude-3-5-haiku)',
        ],
      });
    }

    // Check if mapping is enabled
    if (!mapping.enabled) {
      await recordTestRun(false);
      return res.json({
        success: false,
        message: `Rapid Reply mapping for ${mainModelId} is disabled`,
        testResults: {
          enabled: false,
          reason: 'Mapping disabled',
          mapping: {
            id: mapping.id,
            mainModelId: mapping.mainModelId,
            rapidModelId: mapping.rapidModelId,
            enabled: mapping.enabled,
          },
        },
        recommendations: [`Enable the mapping for ${mainModelId} → ${mapping.rapidModelId}`],
      });
    }

    // Find applicable prompts
    const prompts = await rapidReplyPromptRepository.findByModelPair(mapping.id).catch(recordFailedRunAndRethrow);
    const activePrompts = prompts.filter(p => p.isActive);

    // Run the rapid model the way chat does (generate, then save the result for the quest), then
    // the main turn, which picks that result up. Every rapid figure reported below comes from the
    // saved rapid reply result; the main model's timing is reported separately.
    const testStartTime = Date.now();
    let rapidReplyStartTime = 0;
    let rapidReplyEndTime = 0;

    let rapidReplyResponse: string | null = null;
    let rapidReplyLatency = 0;
    let rapidReplyTtfvt = 0;
    let mainModelTtfvt: number | undefined;
    // 0 means "not measured" as well as "measured as 0"; the state says which case a 0 is.
    let mainModelTtfvtState: ReturnType<typeof ttfvtState> = 'unknown';
    let mainModelError: string | null = null;
    const actualTokensUsed = 0;
    const actualCost = 0;
    let errorMessage: string | null = null;
    let testSession = null;
    let chatCompletion = null;

    try {
      testSession = await sessionRepository.create({
        userId: req.user.id,
        name: `Rapid Reply Test - ${new Date().toISOString()}`,
        knowledgeIds: [],
        lastUpdated: new Date(),
        firstCreated: new Date(),
        groups: [],
        isGlobalRead: false,
        isGlobalWrite: false,
        users: [],
        // Mark as test session for easy cleanup
        tags: [
          { name: 'rapid-reply-test', strength: 10 },
          { name: 'temporary', strength: 10 },
        ],
      });

      chatCompletion = new ChatCompletionProcess({
        ...getDefaultChatCompletionOptions(),
        queue: new SQSService(), // Create per-request to ensure fresh credentials
        user: req.user,
        sessionId: testSession.id,
        features: new Map<featureNames, ChatCompletionFeature>(),
        logger: req.logger,
        tokenizer: getSharedTokenizer(req.logger),
      });

      const promptMeta = { session: { id: testSession.id, userId: req.user.id } };
      // process() expects the quest to exist already.
      const quest = await chatCompletion.db.quests.create({
        sessionId: testSession.id,
        prompt: testInput,
        type: 'message',
        timestamp: new Date(),
        replies: [],
        promptMeta,
      });

      rapidReplyStartTime = Date.now();
      const generation = await generateRapidReply({
        mapping,
        message: testInput,
        userId: req.user.id,
        logger: req.logger,
        meter: createRequestCompletionMeter(req, 'rapid reply test', { systemModel: true }),
      });
      rapidReplyEndTime = Date.now();

      if (generation.status === 'skipped') {
        errorMessage =
          generation.reason === 'model_unavailable'
            ? `Rapid model ${mapping.rapidModelId} is not available and no fallback model could run`
            : `Rapid model ${mapping.rapidModelId} returned an empty response`;
      } else {
        // Non-streaming call, so the first visible token arrives with the whole reply.
        await saveRapidReplyResult({
          questId: quest.id,
          sessionId: testSession.id,
          userId: req.user.id,
          mainModelId,
          mapping,
          generation,
          ttfvt: generation.latency,
        });

        const testBody = {
          userId: req.user.id,
          sessionId: testSession.id,
          historyCount: 5,
          fabFileIds: [],
          message: testInput,
          messageFileIds: [],
          questId: quest.id,
          params: {
            model: mainModelId,
            max_tokens: 1000,
            stream: true, // Streaming, so the main model's TTFVT is measured
            temperature: 0.7,
            n: 1,
            top_p: 1.0,
            presence_penalty: 0,
            frequency_penalty: 0,
          },
          promptMeta,
          enableQuestMaster: false,
          enableMementos: true,
          enableArtifacts: true,
          enableAgents: false,
          tools: ['deep_research' as const],
          queryComplexity: 'complex' as const,
          // The route also accepts an admin-scoped key, so the turn's auth comes from the request.
          ...requestTurnAuth(req),
          // Optional schema fields - declared for QuestStartBodySchema type conformance
          dashboardParams: undefined,
          questMaster: undefined,
          researchMode: undefined,
          imageConfig: undefined,
        };

        // A main-model failure is reported on its own; it does not change what the rapid model did.
        try {
          // No externalTools merge here on purpose: this admin test endpoint
          // hardcodes its tool list above and never requests premium overlay
          // tools. Add the premiumLlmTools merge if that ever changes.
          await chatCompletion.process({ body: testBody, logger: req.logger });
          const completedQuest = await chatCompletion.db.quests.findById(quest.id);
          const performance = (
            completedQuest?.promptMeta as { performance?: { firstTokenTime?: number; firstChunkTime?: number } }
          )?.performance;
          mainModelTtfvt = performance?.firstTokenTime;
          mainModelTtfvtState = ttfvtState(performance?.firstTokenTime, performance?.firstChunkTime);
        } catch (processError) {
          req.logger.warn('[RapidReplyTest] Main model run failed:', processError);
          mainModelError = processError instanceof Error ? processError.message : String(processError);
        }

        // Read back what was saved, as chat's hand-off does, rather than the in-memory generation.
        const rapidReplyResult = await rapidReplyResultRepository.findByQuestId(quest.id);
        if (rapidReplyResult?.rapidResponse?.content) {
          rapidReplyResponse = rapidReplyResult.rapidResponse.content;
          rapidReplyLatency = rapidReplyResult.rapidResponse.latency || 0;
          rapidReplyTtfvt = rapidReplyResult.rapidResponse.ttfvt || rapidReplyLatency;
        } else {
          errorMessage = 'No rapid reply result was saved for the test quest';
        }
      }
    } catch (error) {
      req.logger.error('[RapidReplyTest] Test run failed:', error);
      errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    } finally {
      if (testSession) {
        const sessionId = testSession.id;
        try {
          const results = await rapidReplyResultRepository.findBySessionId(sessionId);
          for (const result of results) {
            await rapidReplyResultRepository.delete(result.id);
          }
        } catch (cleanupError) {
          req.logger.warn('[RapidReplyTest] Failed to clean up test rapid reply results:', cleanupError);
        }
        try {
          const questsToDelete = (await chatCompletion?.db?.quests?.find({ sessionId })) ?? [];
          for (const quest of questsToDelete) {
            await chatCompletion?.db?.quests?.delete?.(quest.id);
          }
        } catch (cleanupError) {
          req.logger.warn('[RapidReplyTest] Failed to clean up test quests:', cleanupError);
        }
        try {
          await sessionRepository.delete(sessionId);
        } catch (cleanupError) {
          req.logger.warn('[RapidReplyTest] Failed to clean up test session:', cleanupError);
        }
      }
    }

    // Simulate additional processing delay if requested
    if (simulateLatency > 0) {
      await new Promise(resolve => setTimeout(resolve, simulateLatency));
    }

    const testEndTime = Date.now();

    const actualRapidReplyLatency = rapidReplyLatency;
    const actualRapidReplyTtfvt = rapidReplyTtfvt;
    const maxConfiguredLatency = Math.min(mapping.maxLatency, settings.maxAcceptableLatency || 2000);
    const actualResponseLength = rapidReplyResponse?.length || 0;

    // Check latency against configured limits
    // No rapid reply means nothing was measured, which must not read as "within limits".
    const latencyCheck = !!rapidReplyResponse && actualRapidReplyLatency <= maxConfiguredLatency;

    // Prepare test results
    const testResults = {
      enabled: true,
      configuration: {
        mainModel: mapping.mainModelId,
        rapidModel: mapping.rapidModelId,
        maxTokens: mapping.maxTokens,
        responseStyle: mapping.responseStyle,
        systemPrompt: mapping.systemPrompt.substring(0, 100) + (mapping.systemPrompt.length > 100 ? '...' : ''),
        maxLatency: mapping.maxLatency,
      },
      performance: {
        // Key metrics: TTFVT, Latency, Length
        ttfvt: actualRapidReplyTtfvt,
        latency: actualRapidReplyLatency,
        responseLength: actualResponseLength,
        maxConfiguredLatency,
        // The main model's own timing, kept apart so it is never read as the rapid model's.
        mainModelTtfvt,
        mainModelError,
        estimatedCost: actualCost,
        tokensUsed: actualTokensUsed,
        latencyCheck: {
          passed: latencyCheck,
          message: !rapidReplyResponse
            ? 'No rapid reply was generated, so latency was not measured'
            : latencyCheck
              ? `Rapid reply latency ${actualRapidReplyLatency}ms is within limits`
              : `Rapid reply latency ${actualRapidReplyLatency}ms exceeds limit of ${maxConfiguredLatency}ms`,
        },
      },
      rapidReplyTest: {
        success: !errorMessage,
        testInput: testInput,
        response: rapidReplyResponse,
        error: errorMessage,
        responseLength: actualResponseLength,
        responseWordCount: rapidReplyResponse ? rapidReplyResponse.split(/\s+/).length : 0,
      },
      prompts: {
        total: prompts.length,
        active: activePrompts.length,
        applicable:
          activePrompts.length > 0
            ? activePrompts.map(p => ({
                id: p.id,
                name: p.name,
                domains: p.domains,
              }))
            : [],
      },
      settings: {
        globalEnabled,
        allowedUserTags: settings.allowedUserTags,
        transitionMode: settings.transitionMode,
        showIndicator: settings.showIndicator,
        fallbackBehavior: settings.fallbackBehavior,
      },
    };

    // Generate recommendations
    const recommendations = [];

    if (errorMessage) {
      recommendations.push(`Test failed: ${errorMessage}. Check model configuration and availability.`);
    } else if (rapidReplyResponse) {
      if (!latencyCheck) {
        recommendations.push(
          `Rapid reply latency ${actualRapidReplyLatency}ms exceeds limits. Consider increasing max latency or optimizing configuration`
        );
      }

      if (rapidReplyTtfvt > 1000) {
        recommendations.push(
          `TTFVT (${rapidReplyTtfvt}ms) is high. Consider using a faster rapid model or optimizing the system prompt`
        );
      }

      if (mainModelError) {
        recommendations.push(
          `The main model run failed: ${mainModelError}. The rapid reply result above is unaffected.`
        );
      } else if (mainModelTtfvtState === 'never-rendered') {
        recommendations.push(
          'The main model streamed but nothing ever became visible to the user. This is a frozen turn, not a slow one - check its system prompt for a response the model hides entirely.'
        );
      }

      if (rapidReplyResponse.length < 10) {
        recommendations.push(
          'Response is very short. Consider adjusting the system prompt for more detailed responses.'
        );
      }

      if (rapidReplyResponse.length > 500) {
        recommendations.push(
          'Response is quite long for a rapid reply. Consider optimizing the system prompt for brevity.'
        );
      }

      if (actualTokensUsed > mapping.maxTokens * 0.9) {
        recommendations.push('Token usage is near the limit. Consider increasing max_tokens or optimizing the prompt.');
      }

      if (actualCost > 0.01) {
        recommendations.push(`Cost per rapid reply is $${actualCost.toFixed(4)}. Monitor costs for high-volume usage.`);
      }
    }

    if (activePrompts.length === 0) {
      recommendations.push('Create and activate system prompts for better rapid reply quality');
    }

    if (mapping.usageCount === 0) {
      recommendations.push('This mapping has not been used yet. Monitor usage after deployment.');
    }

    if (mapping.maxTokens > (settings.defaultMaxTokens || 150)) {
      recommendations.push('Mapping max tokens exceeds default setting. Consider adjusting for consistency.');
    }

    const testSuccess = !errorMessage && !!rapidReplyResponse;

    await rapidReplyAuditLogRepository
      .createLog({
        entityType: 'settings',
        entityId: 'test',
        action: 'update',
        changes: {
          testConfiguration: {
            after: {
              mainModelId,
              testInput: testInput.substring(0, 50) + (testInput.length > 50 ? '...' : ''),
              actualRapidReplyLatency,
              actualRapidReplyTtfvt,
              actualResponseLength,
              latencyCheck,
              mappingFound: true,
              promptsAvailable: activePrompts.length,
              testSuccess,
              tokensUsed: actualTokensUsed,
              estimatedCost: actualCost,
              responseGenerated: !!rapidReplyResponse,
              timing: {
                testStartTime,
                rapidReplyStartTime,
                rapidReplyEndTime,
                testEndTime,
              },
            },
          },
        },
        userId: req.user!.id,
        userEmail: req.user!.email || undefined,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        metadata: {
          testRun: true,
          simulatedLatency: simulateLatency,
        },
      })
      .catch(async (error: unknown) => {
        await recordTestRun(testSuccess);
        throw error;
      });

    await recordTestRun(testSuccess);

    req.logger.info(
      `[RapidReplyTest] Test ${testSuccess ? 'completed' : 'failed'} for ${mainModelId} - TTFVT: ${rapidReplyTtfvt}ms, Latency: ${actualRapidReplyLatency}ms, Length: ${actualResponseLength}`
    );

    return res.json({
      success: testSuccess,
      message: testSuccess
        ? 'Rapid Reply configuration test completed successfully'
        : `Rapid Reply test failed: ${errorMessage}`,
      testResults,
      recommendations:
        recommendations.length > 0
          ? recommendations
          : testSuccess
            ? ['Configuration looks good!']
            : ['Fix the above issues and try again'],
      timestamp: new Date().toISOString(),
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
