/**
 * Email Analyzer Lambda Handler
 *
 * Queue-based handler that performs AI analysis on ingested emails.
 * Triggered by SQS messages containing { emailId }
 *
 * Flow:
 * 1. Receives emailId from SQS queue
 * 2. Fetches email from IngestedEmailModel
 * 3. Calls emailAnalysisService.analyzeEmail() from b4m-core
 * 4. Updates email document with analysis results
 * 5. Handles errors with DLQ retry logic
 *
 * Architecture:
 * - Decoupled from email ingestion for faster initial response
 * - Uses existing LLM service layer (Claude via Bedrock)
 * - Idempotent: can be re-run safely if it fails
 */

import { z } from 'zod';
import { SQSEvent, SQSHandler } from 'aws-lambda';
import {
  adminSettingsRepository,
  apiKeyRepository,
  ingestedEmailRepository,
  User,
  IngestedEmailModel,
} from '@bike4mind/database';
// @ts-ignore - services may not be exported in types yet
import { emailAnalysisService, apiKeyService } from '@bike4mind/services';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { NotFoundError, getSettingsByNames } from '@bike4mind/utils';
import { getLlmByModel, getAvailableModels } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { ChatModels } from '@bike4mind/common';

/**
 * SQS Message payload schema
 */
const EmailAnalysisPayload = z.object({
  emailId: z.string().min(1, 'emailId is required'),
});

type EmailAnalysisPayload = z.infer<typeof EmailAnalysisPayload>;

/**
 * Calculate estimated cost for LLM API call
 */
function calculateLLMCost(model: string, inputTokens: number, outputTokens: number): number {
  // Pricing per 1M tokens (USD)
  const pricing: Record<string, { input: number; output: number }> = {
    [ChatModels.CLAUDE_4_5_HAIKU_BEDROCK]: { input: 0.8, output: 4.0 },
    [ChatModels.CLAUDE_5_SONNET_BEDROCK]: { input: 3.0, output: 15.0 },
    [ChatModels.CLAUDE_4_6_SONNET_BEDROCK]: { input: 3.0, output: 15.0 },
    [ChatModels.CLAUDE_4_OPUS_BEDROCK]: { input: 15.0, output: 75.0 },
    [ChatModels.GPT4o]: { input: 5.0, output: 15.0 },
  };

  const modelPricing = pricing[model] || { input: 3.0, output: 15.0 };

  const inputCost = (inputTokens / 1_000_000) * modelPricing.input;
  const outputCost = (outputTokens / 1_000_000) * modelPricing.output;

  return inputCost + outputCost;
}

/**
 * Safely parse temperature value from AdminSettings
 * Handles both number and string inputs, with validation
 */
function parseTemperature(value: unknown, logger: Logger): number {
  if (typeof value === 'number') {
    if (value >= 0 && value <= 1) {
      return value;
    }
    logger.warn('Temperature out of valid range [0, 1], using default 0.3', { temperature: value });
    return 0.3;
  }

  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
      return parsed;
    }
    logger.warn('Invalid temperature string value, using default 0.3', { temperature: value });
    return 0.3;
  }

  logger.warn('Invalid temperature value type, using default 0.3', { temperature: value });
  return 0.3;
}

/**
 * Main dispatch function with logger integration
 */
export const dispatch: SQSHandler = dispatchWithLogger(async (event: SQSEvent, context, logger: Logger) => {
  const body = event.Records[0].body;
  const payload = EmailAnalysisPayload.parse(JSON.parse(body));

  logger.updateMetadata({
    emailId: payload.emailId,
  });

  logger.log('====================================');
  logger.log('Started email AI analysis queue handler');
  logger.log('====================================');

  try {
    // 1. Fetch email from database
    const email = await ingestedEmailRepository.findById(payload.emailId);

    if (!email) {
      logger.warn(`Email not found: ${payload.emailId}, skipping analysis`);
      return; // Email may have been deleted
    }

    logger.info('Email fetched for analysis', {
      from: email.from,
      subject: email.subject,
      userId: email.userId,
    });

    // 2. Check if analysis already exists (idempotency)
    if (email.aiAnalysis?.summary) {
      logger.info('Email already analyzed, skipping re-analysis');
      return;
    }

    // 3. Fetch user for LLM API keys
    const user = await User.findById(email.userId);
    if (!user) {
      throw new NotFoundError(`User not found: ${email.userId}`);
    }

    // 4. Check rate limiting before processing
    const dailyAnalysisLimit = Number(
      (await adminSettingsRepository.getSettingsValue('MaxDailyEmailAnalyses')) || '100'
    );

    const analysisCount = await IngestedEmailModel.countDocuments({
      userId: email.userId,
      'aiAnalysis.summary': { $exists: true },
      ingestedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // Last 24h
    });

    if (analysisCount >= dailyAnalysisLimit) {
      logger.warn('Daily analysis limit reached', {
        userId: email.userId,
        count: analysisCount,
        limit: dailyAnalysisLimit,
      });
      return; // Skip analysis without failing
    }

    logger.info('Rate limit check passed', {
      analysisCount,
      limit: dailyAnalysisLimit,
    });

    // 5. Get effective LLM API keys
    const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(
      email.userId,
      { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames },
      { logger }
    );

    if (!apiKeyTable) {
      throw new Error('No API keys available for LLM analysis');
    }

    // 6. Get available models
    const availableModels = await getAvailableModels(apiKeyTable);

    // 7. Get email analysis configuration from AdminSettings
    const emailAnalysisEnabled = await adminSettingsRepository.getSettingsValue('EnableEmailAnalysis');
    if (!emailAnalysisEnabled) {
      logger.info('Email analysis disabled in AdminSettings, skipping');
      return;
    }

    // Get model configuration (default to Claude 4.5 Haiku via Bedrock)
    const emailAnalysisModel =
      (await adminSettingsRepository.getSettingsValue('EmailAnalysisModel')) || ChatModels.CLAUDE_4_5_HAIKU_BEDROCK;

    const temperature = (await adminSettingsRepository.getSettingsValue('EmailAnalysisTemperature')) || 0.3;

    // Get custom meta-prompt if configured
    const customMetaPrompt = await adminSettingsRepository.getSettingsValue('EmailAnalysisPrompt');

    logger.info('Email analysis configuration loaded', {
      model: emailAnalysisModel,
      temperature,
      hasCustomPrompt: !!customMetaPrompt,
    });

    // 8. Create LLM backend
    const modelInfo = availableModels.find(m => m.id === emailAnalysisModel);
    if (!modelInfo) {
      throw new Error(`Model not available: ${emailAnalysisModel}`);
    }

    const llmBackend = getLlmByModel(apiKeyTable, { modelInfo, logger, endUserId: email.userId });
    if (!llmBackend) {
      throw new Error(`Failed to create LLM backend for model: ${emailAnalysisModel}`);
    }

    // 9. Prepare email input for analysis
    const emailInput = emailAnalysisService.emailDocumentToAnalysisInput(email);

    // 10. Call AI analysis service
    logger.info('Starting AI analysis...');

    const analysisResult = await emailAnalysisService.analyzeEmail(
      emailInput,
      {
        llm: {
          backend: llmBackend,
        },
      },
      {
        model: emailAnalysisModel,
        temperature: parseTemperature(temperature, logger),
        metaPrompt: typeof customMetaPrompt === 'string' ? customMetaPrompt : undefined,
        context: {
          userEmail: email.to[0],
        },
      }
    );

    logger.info('AI analysis completed', {
      summary: analysisResult.summary.substring(0, 100),
      sentiment: analysisResult.sentiment,
      entityCount:
        analysisResult.entities.companies.length +
        analysisResult.entities.people.length +
        analysisResult.entities.products.length +
        analysisResult.entities.technologies.length,
      actionItemCount: analysisResult.actionItems.length,
      tagCount: analysisResult.suggestedTags.length,
    });

    // 11. Calculate cost
    const inputTokens = analysisResult.tokensUsed?.input || 0;
    const outputTokens = analysisResult.tokensUsed?.output || 0;
    const estimatedCost = calculateLLMCost(emailAnalysisModel, inputTokens, outputTokens);

    logger.info('Analysis cost calculated', {
      emailId: payload.emailId,
      model: emailAnalysisModel,
      inputTokens,
      outputTokens,
      costUSD: estimatedCost,
    });

    // 12. Update email with analysis results and metadata
    await ingestedEmailRepository.update({
      id: payload.emailId,
      aiAnalysis: {
        ...analysisResult,
        analyzedAt: new Date(),
        model: emailAnalysisModel,
        tokensUsed: {
          input: inputTokens,
          output: outputTokens,
        },
        costUSD: estimatedCost,
      },
    });

    logger.info('Email analysis saved to database');

    // 13. Send real-time update to client via WebSocket (if needed in future)
    // Note: Skipping WebSocket notification for now - would need to add 'email_analysis_completed'
    // to WebSocket action types first
    logger.info('Email analysis completed successfully', {
      emailId: payload.emailId,
      userId: email.userId,
      sentiment: analysisResult.sentiment,
      tagCount: analysisResult.suggestedTags.length,
      actionItemCount: analysisResult.actionItems.length,
    });

    logger.log('====================================');
    logger.log('Completed email AI analysis queue handler');
    logger.log('====================================');
  } catch (error) {
    logger.error('Email analysis failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Re-throw to trigger DLQ retry
    throw error;
  }
});
