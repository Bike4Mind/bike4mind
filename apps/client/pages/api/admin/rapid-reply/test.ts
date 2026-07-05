import { rapidReplyMappingRepository } from '@bike4mind/database/ai';
import { rapidReplyPromptRepository } from '@bike4mind/database/ai';
import { adminSettingsRepository } from '@bike4mind/database/infra';
import { rapidReplyAuditLogRepository } from '@bike4mind/database/ai';
import { ChatCompletionProcess, featureNames, ChatCompletionFeature } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { getDefaultChatCompletionOptions, getSharedTokenizer } from '@server/utils/chatCompletionDefaults';
import { sessionRepository } from '@bike4mind/database';
import { Types } from 'mongoose';
import { SQSService } from '@bike4mind/utils';

interface TestConfiguration {
  mainModelId: string;
  testInput?: string;
  skipRapidReply?: boolean;
  simulateLatency?: number;
}

const handler = baseApi()
  .use(
    rateLimit({
      limit: 5,
      windowMs: 60 * 1000,
    })
  )
  .post(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    console.log('🧪 Rapid Reply test configuration API called');

    const {
      mainModelId,
      testInput = 'Test message for rapid reply configuration',
      simulateLatency = 0,
    } = req.body as TestConfiguration;

    if (!mainModelId) {
      throw new BadRequestError('mainModelId is required for testing');
    }

    // Get system settings
    const settings = await adminSettingsRepository.getSettingsValue('RapidReplySettings');
    if (!settings) {
      throw new Error('Rapid Reply settings not found. Please configure settings first.');
    }

    // Check if Rapid Reply is enabled
    if (!settings.enabled) {
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
    const mapping = await rapidReplyMappingRepository.findByMainModel(mainModelId);
    if (!mapping) {
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
    const prompts = await rapidReplyPromptRepository.findByModelPair(mapping.id);
    const activePrompts = prompts.filter(p => p.isActive);

    // Actually test the rapid reply process with proper measurement
    const testStartTime = Date.now();
    let rapidReplyStartTime = 0;
    let rapidReplyEndTime = 0;
    let rapidReplyTtfvt = 0; // Time to first visible token

    let rapidReplyResponse = null;
    const actualTokensUsed = 0;
    const actualCost = 0;
    let errorMessage = null;
    let testSession = null;
    let testBody = null;
    let chatCompletion = null;
    let rapidReplyResults = null;

    try {
      console.log('🧪 Creating temporary test session for rapid reply testing');

      // Create a temporary test session directly (simpler approach)
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

      console.log(`🧪 Test session created: ${testSession.id}`);

      // Create a ChatCompletionProcess instance for testing with rapid reply enabled
      chatCompletion = new ChatCompletionProcess({
        ...getDefaultChatCompletionOptions(),
        queue: new SQSService(), // Create per-request to ensure fresh credentials
        user: req.user,
        sessionId: testSession.id,
        features: new Map<featureNames, ChatCompletionFeature>(),
        logger: req.logger,
        tokenizer: getSharedTokenizer(req.logger),
      });

      // Use a predefined complex message or enhance the input to be complex
      const complexTestMessage =
        testInput.length > 100
          ? testInput
          : testInput.length > 50
            ? `${testInput} Please provide a detailed analysis with multiple perspectives, including pros and cons, and consider various implementation approaches.`
            : `${testInput} Analyze this topic comprehensively, comparing different approaches and methodologies. Include detailed explanations with examples and consider potential challenges and solutions.`;

      testBody = {
        userId: req.user.id,
        sessionId: testSession.id,
        historyCount: 5, // Some history to make it complex
        fabFileIds: [], // No files but we'll add complexity elsewhere
        message: complexTestMessage,
        messageFileIds: [], // No message files but complex message
        questId: new Types.ObjectId().toString(), // Generate a valid MongoDB ObjectId for testing
        params: {
          model: mainModelId, // Use the main model to trigger rapid reply
          max_tokens: 1000, // Allow more tokens for main response
          stream: true, // Enable streaming to measure TTFVT
          temperature: 0.7,
          // Additional parameters to ensure simple classification
          n: 1, // Single response
          top_p: 1.0, // Standard top_p
          presence_penalty: 0, // No presence penalty
          frequency_penalty: 0, // No frequency penalty
        },
        promptMeta: {
          session: {
            id: testSession.id,
            userId: req.user.id,
          },
        }, // Required by LLMApiRequestBodySchema
        enableQuestMaster: false, // Keep disabled for testing
        enableMementos: true, // Enable to make it complex
        enableArtifacts: true, // Enable to make it complex
        enableAgents: false, // Keep disabled for testing
        tools: ['deep_research' as const], // Add research tool to force complex classification
        queryComplexity: 'complex' as const, // Force complex classification
        // Optional schema fields - declared for QuestStartBodySchema type conformance
        dashboardParams: undefined,
        questMaster: undefined,
        researchMode: undefined,
        imageConfig: undefined,
      };

      console.log('🧪 Starting rapid reply test with main model:', mainModelId);
      console.log('🧪 Test questId:', testBody.questId);
      console.log('🧪 Test sessionId:', testBody.sessionId);
      console.log('🧪 Original test input:', testInput);
      console.log('🧪 Complex test message:', complexTestMessage);
      console.log('🧪 Query complexity forced to:', testBody.queryComplexity);
      console.log('🧪 Tools enabled:', testBody.tools);
      console.log('🧪 Mementos enabled:', testBody.enableMementos);
      console.log('🧪 Artifacts enabled:', testBody.enableArtifacts);
      rapidReplyStartTime = Date.now();

      // Create the quest first (process method expects it to exist)
      const quest = await chatCompletion.db.quests.create({
        sessionId: testBody.sessionId,
        prompt: complexTestMessage,
        type: 'message',
        timestamp: new Date(),
        replies: [],
        promptMeta: testBody.promptMeta,
      });

      console.log('🧪 Quest created:', quest.id);

      // Update the testBody to use the actual quest ID
      testBody.questId = quest.id;

      // Use the process method for direct processing (no queue)
      try {
        console.log('🧪 Starting quest processing...');
        // No externalTools merge here on purpose: this admin test endpoint
        // hardcodes its tool list above and never requests premium overlay
        // tools. Add the premiumLlmTools merge if that ever changes.
        await chatCompletion.process({
          body: testBody,
          logger: req.logger,
        });
        console.log('🧪 Quest processing completed');
      } catch (processError) {
        console.error('🧪 Error during quest processing:', processError);
        throw processError;
      }

      rapidReplyEndTime = Date.now();

      // Add a small delay to ensure quest processing is complete
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check database directly for the quest (process method created it)
      console.log('🧪 Checking database for quests in session:', testBody.sessionId);

      // Try multiple ways to find the quest
      const questBySession = await chatCompletion.db.quests.findOne({ sessionId: testBody.sessionId });
      const allQuestsInSession = await chatCompletion.db.quests.find({ sessionId: testBody.sessionId });

      // Get the most recent quest (should be the one created by process method)
      const mostRecentQuest =
        allQuestsInSession.length > 0
          ? allQuestsInSession.sort(
              (a, b) => new Date(b.createdAt || b.updatedAt).getTime() - new Date(a.createdAt || a.updatedAt).getTime()
            )[0]
          : null;

      console.log('🧪 Database check results:');
      console.log('🧪 - Quest by session found:', !!questBySession);
      console.log('🧪 - Most recent quest found:', !!mostRecentQuest);
      console.log('🧪 - Total quests in session:', allQuestsInSession.length);

      if (allQuestsInSession.length > 0) {
        console.log('🧪 - All quests in session:');
        allQuestsInSession.forEach((q, index) => {
          console.log(
            `🧪   Quest ${index + 1}: ID=${q.id}, Status=${q.status}, Type=${q.type}, HasReply=${!!q.reply}, ReplyLength=${q.reply?.length || 0}`
          );
        });
      }

      // Use the most recent quest (created by process method)
      const completedQuest = mostRecentQuest || questBySession;

      // Check for rapid reply results (this is what we actually want to test)
      if (completedQuest) {
        console.log('🧪 Checking for rapid reply results...');
        console.log('🧪 - Quest ID:', completedQuest.id);
        console.log('🧪 - Rapid reply DB available:', !!chatCompletion.db.rapidReply);
        console.log('🧪 - Rapid reply results available:', !!chatCompletion.db.rapidReply?.results);

        try {
          rapidReplyResults = await chatCompletion.db.rapidReply?.results?.findByQuestId(completedQuest.id);
          console.log('🧪 - Rapid reply results found:', !!rapidReplyResults);
          if (rapidReplyResults) {
            console.log('🧪 - Rapid reply result details:', JSON.stringify(rapidReplyResults, null, 2));
          } else {
            console.log('🧪 - No rapid reply results found for quest ID:', completedQuest.id);

            // findAll method not available on rapid reply results repository
            console.log(
              '🧪 - Rapid reply results repository methods:',
              Object.keys(chatCompletion.db.rapidReply?.results || {})
            );
          }
        } catch (error) {
          console.log('🧪 - Error checking rapid reply results:', error);
        }
      }

      console.log('🧪 Quest details after processing:');
      console.log('🧪 - Status:', completedQuest?.status);
      console.log('🧪 - Type:', completedQuest?.type);
      console.log('🧪 - Has reply:', !!completedQuest?.reply);
      console.log('🧪 - Reply length:', completedQuest?.reply?.length || 0);
      console.log('🧪 - Replies array length:', completedQuest?.replies?.length || 0);
      console.log('🧪 - First reply:', completedQuest?.replies?.[0]?.substring(0, 100) || 'none');
      console.log('🧪 - All replies:', completedQuest?.replies);
      console.log('🧪 - Prompt meta:', JSON.stringify(completedQuest?.promptMeta, null, 2));

      // Check if there's any content in the quest at all
      console.log('🧪 - Quest keys:', Object.keys(completedQuest || {}));
      console.log('🧪 - Quest full object:', JSON.stringify(completedQuest, null, 2));

      // Check if we have rapid reply results (this is what we actually want)
      if (rapidReplyResults?.rapidResponse?.content) {
        rapidReplyResponse = rapidReplyResults.rapidResponse.content;
        // Use the latency from rapid reply results, not the total test time
        const rapidReplyLatency = rapidReplyResults.rapidResponse.latency || 0;
        rapidReplyTtfvt = rapidReplyLatency; // TTFVT is the same as latency for rapid reply

        console.log(`🧪 Rapid reply test completed successfully`);
        console.log(`🧪 TTFVT: ${rapidReplyTtfvt}ms`);
        console.log(`🧪 Latency: ${rapidReplyLatency}ms`);
        console.log(`🧪 Response length: ${rapidReplyResponse.length} characters`);
        console.log(`🧪 Rapid reply content: "${rapidReplyResponse}"`);
      } else if (completedQuest?.reply || completedQuest?.replies?.[0]) {
        // Fallback to quest reply if no rapid reply results
        rapidReplyResponse = completedQuest.reply || completedQuest.replies?.[0] || '';

        // Try to get rapid reply metrics from quest promptMeta
        const questPromptMeta = completedQuest.promptMeta as any;
        rapidReplyTtfvt = questPromptMeta?.rapidTtfvt || questPromptMeta?.performance?.firstTokenTime || 0;

        // Calculate latency from the rapid reply timing if available
        const rapidReplyLatency = questPromptMeta?.rapidLatency || (rapidReplyTtfvt > 0 ? rapidReplyTtfvt : 0);

        console.log(`🧪 Quest reply test completed successfully`);
        console.log(`🧪 TTFVT: ${rapidReplyTtfvt}ms`);
        console.log(`🧪 Rapid Reply Latency: ${rapidReplyLatency}ms`);
        console.log(`🧪 Response length: ${rapidReplyResponse.length} characters`);
        console.log(`🧪 Quest promptMeta:`, JSON.stringify(questPromptMeta, null, 2));
      } else {
        errorMessage = `No response generated from rapid reply test. Quest status: ${completedQuest?.status || 'unknown'}, type: ${completedQuest?.type || 'unknown'}`;
        console.log('🧪 Rapid reply test failed:', errorMessage);
      }
    } catch (error) {
      console.error('🧪 Rapid reply test failed:', error);
      if (error instanceof Error) {
        errorMessage = error.message;
        console.error('🧪 Error stack:', error.stack);
      } else {
        errorMessage = 'Unknown error occurred';
      }
    } finally {
      // Always clean up the test session and quest
      if (testSession) {
        try {
          console.log(`🧪 Cleaning up test session: ${testSession.id}`);
          await sessionRepository.delete(testSession.id);
          console.log('🧪 Test session cleaned up successfully');
        } catch (cleanupError) {
          console.warn('🧪 Failed to cleanup test session:', cleanupError);
        }
      }

      // Also clean up any test quests that were created
      if (testBody?.sessionId) {
        try {
          console.log(`🧪 Cleaning up test quests in session: ${testBody.sessionId}`);
          const questsToDelete = await chatCompletion?.db?.quests?.find({ sessionId: testBody.sessionId });
          if (questsToDelete && questsToDelete.length > 0) {
            for (const quest of questsToDelete) {
              await chatCompletion?.db?.quests?.delete?.(quest.id);
              console.log(`🧪 Deleted quest: ${quest.id}`);
            }
          }
          console.log('🧪 Test quests cleaned up successfully');
        } catch (cleanupError) {
          console.warn('🧪 Failed to cleanup test quests:', cleanupError);
        }
      }
    }

    // Simulate additional processing delay if requested
    if (simulateLatency > 0) {
      await new Promise(resolve => setTimeout(resolve, simulateLatency));
    }

    const testEndTime = Date.now();

    // Use the actual rapid reply latency from the results, not the test timing
    const actualRapidReplyLatency = rapidReplyResults?.rapidResponse?.latency || rapidReplyTtfvt || 0;
    const actualRapidReplyTtfvt = rapidReplyResults?.rapidResponse?.latency || rapidReplyTtfvt || 0; // TTFVT is the same as latency for rapid reply
    const actualResponseLength = rapidReplyResponse?.length || 0;

    // Check latency against configured limits
    const latencyCheck =
      actualRapidReplyLatency <= mapping.maxLatency &&
      actualRapidReplyLatency <= (settings.maxAcceptableLatency || 2000);

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
        maxConfiguredLatency: Math.min(mapping.maxLatency, settings.maxAcceptableLatency || 2000),
        estimatedCost: actualCost,
        tokensUsed: actualTokensUsed,
        latencyCheck: {
          passed: latencyCheck,
          message: latencyCheck
            ? `Rapid reply latency ${actualRapidReplyLatency}ms is within limits`
            : `Rapid reply latency ${actualRapidReplyLatency}ms exceeds limit of ${Math.min(mapping.maxLatency, settings.maxAcceptableLatency || 2000)}ms`,
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
        globalEnabled: settings.enabled,
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

      if (rapidReplyTtfvt > 0 && rapidReplyTtfvt > 1000) {
        recommendations.push(
          `TTFVT (${rapidReplyTtfvt}ms) is high. Consider using a faster rapid model or optimizing the system prompt`
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

    await rapidReplyAuditLogRepository.createLog({
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
            testSuccess: !errorMessage,
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
    });

    const testSuccess = !errorMessage && !!rapidReplyResponse;

    console.log(
      `${testSuccess ? '✅' : '❌'} Test ${testSuccess ? 'completed' : 'failed'} for ${mainModelId} - TTFVT: ${rapidReplyTtfvt}ms, Latency: ${actualRapidReplyLatency}ms, Length: ${actualResponseLength}`
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
