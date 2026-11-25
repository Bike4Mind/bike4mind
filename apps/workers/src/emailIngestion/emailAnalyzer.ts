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

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SQSEvent, SQSHandler } from 'aws-lambda';
import {
  adminSettingsRepository,
  apiKeyRepository,
  ingestedEmailRepository,
  User,
  IngestedEmailModel,
  emailTriageItemRepository,
  assistantBriefRepository,
  usageEventRepository,
  organizationRepository,
} from '@bike4mind/database';
import { emailAnalysisService, apiKeyService, recordOperationalUsage } from '@bike4mind/services';
import { latchUsage, type CompletionUsage } from '@bike4mind/services/billing/completionMeter';
import { dispatchWithLogger } from '@bike4mind/server-utils/queueHandlers/utils';
import { NotFoundError, getSettingsByNames } from '@bike4mind/utils';
import {
  getLlmByModel,
  getAvailableModels,
  type CompletionInfo,
  type ICompletionBackend,
} from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import {
  ChatModels,
  buildUsagePriceStamp,
  getTextModelCost,
  getTurnsCost,
  type IUserDocument,
  type IOrganizationDocument,
  type ModelInfo,
} from '@bike4mind/common';
import { triageEmail } from './emailTriage';

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

type EmailCompletionUsage = CompletionUsage & Pick<CompletionInfo, 'cacheWrite1hInputTokens' | 'stopReason'>;
type EmailUsageOwner = { user: IUserDocument; organization?: IOrganizationDocument };

async function recordEmailCompletionUsage({
  usage,
  resolveOwner,
  modelInfo,
  providerFailed,
  latencyMs,
  logger,
}: {
  usage: EmailCompletionUsage;
  resolveOwner: () => Promise<EmailUsageOwner | undefined>;
  modelInfo: ModelInfo;
  providerFailed: boolean;
  latencyMs: number;
  logger: Logger;
}): Promise<void> {
  const turns = usage.turnUsage?.some(
    turn => turn.inputTokens || turn.outputTokens || turn.cacheReadInputTokens || turn.cacheCreationInputTokens
  )
    ? usage.turnUsage
    : undefined;
  const zeroTokens = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  const totals = turns?.reduce<typeof zeroTokens>(
    (total, turn) => ({
      inputTokens: total.inputTokens + turn.inputTokens,
      outputTokens: total.outputTokens + turn.outputTokens,
      cacheReadInputTokens: total.cacheReadInputTokens + (turn.cacheReadInputTokens ?? 0),
      cacheCreationInputTokens: total.cacheCreationInputTokens + (turn.cacheCreationInputTokens ?? 0),
    }),
    zeroTokens
  );
  const { inputTokens = 0, outputTokens = 0, cacheReadInputTokens = 0, cacheCreationInputTokens = 0 } = totals ?? usage;
  const promptTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  if (promptTokens + outputTokens <= 0) {
    logger.warn('Email model did not report token usage', { model: modelInfo.id });
    return;
  }

  const owner = await resolveOwner();
  if (!owner) return;

  if (providerFailed) logger.warn('Recording reported usage after email model failure', { model: modelInfo.id });
  const cacheWrite1hTokens = usage.cacheWrite1hInputTokens;
  const costUsd = turns
    ? getTurnsCost(modelInfo, turns)
    : getTextModelCost(
        modelInfo,
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
        promptTokens,
        cacheWrite1hTokens
      );
  await recordOperationalUsage(
    {
      requestId: randomUUID(),
      ...owner,
      feature: 'operations',
      source: 'system',
      bypassCreditBilling: true,
      provider: modelInfo.backend,
      model: modelInfo.id,
      inputTokens,
      outputTokens,
      cachedInputTokens: cacheReadInputTokens,
      cacheWriteTokens: cacheCreationInputTokens,
      costUsd,
      priceStamp: buildUsagePriceStamp(modelInfo, { turns, tierBasisTokens: promptTokens, cacheWrite1hTokens }),
      finishReason: usage.stopReason,
      latencyMs,
    },
    { db: { adminSettings: adminSettingsRepository, usageEvents: usageEventRepository }, logger }
  );
}

function meterEmailBackend(
  backend: ICompletionBackend,
  modelInfo: ModelInfo,
  user: IUserDocument,
  logger: Logger
): ICompletionBackend {
  let ownerPromise: Promise<EmailUsageOwner | undefined> | undefined;
  const resolveOwner = () =>
    (ownerPromise ??= (async () => {
      if (!user.organizationId) return { user };
      try {
        const organization = await organizationRepository.findById(user.organizationId);
        if (!organization) {
          logger.warn('Email model usage organization is missing');
          return undefined;
        }
        return { user, organization };
      } catch {
        logger.warn('Could not look up email model usage organization');
        return undefined;
      }
    })());
  const complete: ICompletionBackend['complete'] = async (model, messages, options, callback) => {
    const usage: EmailCompletionUsage = {};
    const startedAt = Date.now();
    let providerFailed = false;
    try {
      await backend.complete(model, messages, options, async (chunks, info) => {
        latchUsage(usage, info);
        if (info?.cacheWrite1hInputTokens !== undefined) usage.cacheWrite1hInputTokens = info.cacheWrite1hInputTokens;
        if (info?.stopReason !== undefined) usage.stopReason = info.stopReason;
        await callback(chunks, info);
      });
    } catch (error) {
      providerFailed = true;
      throw error;
    } finally {
      await recordEmailCompletionUsage({
        usage,
        resolveOwner,
        modelInfo,
        providerFailed,
        latencyMs: Date.now() - startedAt,
        logger,
      }).catch(error => logger.warn('Could not record email model usage', error));
    }
  };

  return new Proxy(backend, {
    get(target, property) {
      if (property === 'complete') return complete;
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const TRIAGE_MAX_TOKENS = 1200;

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
      emailId: payload.emailId,
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

    const backend = getLlmByModel(apiKeyTable, { modelInfo, logger, endUserId: email.userId });
    if (!backend) {
      throw new Error(`Failed to create LLM backend for model: ${emailAnalysisModel}`);
    }

    const llmBackend = meterEmailBackend(backend, modelInfo, user, logger);

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

    // 12b. Triage for the owner's assistant brief. triageEmail never throws, so the analysis above stands.
    await triageEmail(
      {
        enabled: async () => Boolean(await adminSettingsRepository.getSettingsValue('EnableEmailTriage')),
        items: emailTriageItemRepository,
        emailExists: async emailId => (await ingestedEmailRepository.findById(emailId)) !== null,
        removeBriefItems: (userId, ids) => assistantBriefRepository.removeEmailSourcedItems(userId, ids),
        complete: async prompt => {
          let reply = '';
          let tokensUsed: number | null = null;
          await llmBackend.complete(
            emailAnalysisModel,
            [{ role: 'user', content: prompt }],
            { maxTokens: TRIAGE_MAX_TOKENS, temperature: parseTemperature(temperature, logger) },
            async (chunks: (string | null | undefined)[], info?: CompletionInfo) => {
              // Reasoning and tool chunks carry a channel; only the reply text is parsed.
              if (!info?.channel) reply += chunks.filter(Boolean).join('');
              if (info?.inputTokens !== undefined || info?.outputTokens !== undefined) {
                tokensUsed = (info.inputTokens ?? 0) + (info.outputTokens ?? 0);
              }
            }
          );
          return { reply, model: emailAnalysisModel, tokensUsed };
        },
        logger,
      },
      {
        email: {
          id: payload.emailId,
          userId: email.userId,
          from: email.from,
          subject: email.subject,
          date: email.date,
          bodyText: email.bodyText,
        },
        analysis: analysisResult,
      }
    );

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
