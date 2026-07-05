import {
  ModalModel,
  withTransaction,
  apiKeyRepository,
  adminSettingsRepository,
  AdminSettings,
  slackDevWorkspaceRepository,
} from '@bike4mind/database';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { WhatsNewGenerationPayloadSchema, WhatsNewGenerationPayload } from '@server/queueHandlers/types';
import { WhatsNewConfigService } from '@client/services/whatsNewConfigService';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { emitModalGenerationMetrics } from '@server/utils/cloudwatch';
import { getSettingsByNames } from '@bike4mind/utils';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import {
  apiKeyService,
  AUDIENCE_VARIANTS,
  buildVariantGuidance,
  scrubInternalReferences,
  isNoVariantContent,
} from '@bike4mind/services';
import { ChatModels } from '@bike4mind/common';
import {
  sanitizeContentForLLM,
  buildWhatsNewPrompt,
  extractJsonFromResponse,
  createWhatsNewModalSchema,
} from './whatsNewGeneration.utils';
import { WhatsNewDistributionService } from '@server/services/whatsNewDistribution';

// Token estimation constants
const CHARS_PER_TOKEN = 4; // Rough estimate: 1 token ≈ 4 characters
const TOKENS_PER_MILLION = 1_000_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// LLM response safety limit
const MAX_RESPONSE_SIZE = 50000; // 50KB limit for LLM responses to prevent unbounded accumulation

const WHATS_NEW_MODAL_TAG = 'whats-new' as const;

// Default LLM model fallback (matches whatsNewHighlights.ts pattern)
const DEFAULT_LLM_MODEL = ChatModels.GPT4o_MINI;

const GENERATION_STATUS_SETTING = 'whatsNewGenerationStatus';

// Highlights config setting name (for Slack channel reuse)
const HIGHLIGHTS_CONFIG_SETTING = 'whatsNewHighlightsConfig';

/**
 * Update generation status in AdminSettings for health monitoring
 */
async function updateGenerationStatus(
  status: 'success' | 'failed' | 'no_changes' | 'skipped',
  details: {
    correlationId?: string;
    modelUsed?: string;
    generatedDate?: string;
    error?: string;
  },
  logger: Logger
): Promise<void> {
  try {
    await AdminSettings.findOneAndUpdate(
      { settingName: GENERATION_STATUS_SETTING },
      {
        $set: {
          'settingValue.lastStatus': status,
          'settingValue.lastCompletedAt': new Date().toISOString(),
          ...(details.correlationId && { 'settingValue.lastCorrelationId': details.correlationId }),
          ...(details.modelUsed && { 'settingValue.lastModelUsed': details.modelUsed }),
          ...(details.generatedDate && { 'settingValue.lastGeneratedDate': details.generatedDate }),
          ...(details.error && { 'settingValue.lastError': details.error }),
          ...(!details.error && { 'settingValue.lastError': null }),
        },
      },
      { upsert: true }
    );
  } catch (err) {
    // Status update failure should never mask the main flow
    logger.warn('Failed to update generation status', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Post Slack notification when modal generation fails
 * Reuses the Slack channel from highlights config (same channel the team monitors)
 */
async function notifyGenerationFailure(
  error: string,
  details: {
    environment: string;
    correlationId: string;
    modelId?: string;
    generatedDate?: string;
  },
  logger: Logger
): Promise<void> {
  try {
    const highlightsSetting = await AdminSettings.findOne({ settingName: HIGHLIGHTS_CONFIG_SETTING });
    const config = highlightsSetting?.settingValue as { slackChannelId?: string; slackTeamId?: string } | undefined;

    if (!config?.slackChannelId || !config?.slackTeamId) {
      logger.warn('No Slack channel configured for failure notifications');
      return;
    }

    const workspace = await slackDevWorkspaceRepository.findBySlackTeamIdWithToken(config.slackTeamId);
    if (!workspace?.slackBotToken) {
      logger.warn('No Slack bot token available for failure notification');
      return;
    }

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: "What's New Modal Generation Failed", emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Environment:*\n${details.environment}` },
          { type: 'mrkdwn', text: `*Date:*\n${details.generatedDate || 'N/A'}` },
          { type: 'mrkdwn', text: `*Model:*\n${details.modelId || 'N/A'}` },
          { type: 'mrkdwn', text: `*Correlation ID:*\n\`${details.correlationId}\`` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Error:*\n\`\`\`${error.substring(0, 500)}\`\`\`` },
      },
    ];

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${workspace.slackBotToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: config.slackChannelId,
        text: `What's New modal generation failed: ${error.substring(0, 200)}`,
        blocks,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });

    const result = (await response.json()) as { ok: boolean; error?: string };
    if (!result.ok) {
      logger.warn('Slack notification failed', { error: result.error });
    }
  } catch (notifyError) {
    // Notification failure should never mask the original error
    logger.warn('Failed to send Slack failure notification', {
      error: notifyError instanceof Error ? notifyError.message : String(notifyError),
    });
  }
}

/**
 * Calculate estimated cost for LLM API call based on token usage
 * Pricing per 1M tokens (USD)
 */
function calculateLLMCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing: Record<string, { input: number; output: number }> = {
    [ChatModels.CLAUDE_5_SONNET_BEDROCK]: { input: 3.0, output: 15.0 },
    [ChatModels.CLAUDE_4_6_SONNET_BEDROCK]: { input: 3.0, output: 15.0 },
    [ChatModels.CLAUDE_4_5_HAIKU_BEDROCK]: { input: 0.8, output: 4.0 },
    [ChatModels.CLAUDE_4_OPUS_BEDROCK]: { input: 15.0, output: 75.0 },
    [ChatModels.GPT4o]: { input: 5.0, output: 15.0 },
    [ChatModels.GPT4]: { input: 30.0, output: 60.0 },
    [ChatModels.GPT4_TURBO]: { input: 10.0, output: 30.0 },
  };

  const modelPricing = pricing[model] || { input: 3.0, output: 15.0 };

  const inputCost = (inputTokens / TOKENS_PER_MILLION) * modelPricing.input;
  const outputCost = (outputTokens / TOKENS_PER_MILLION) * modelPricing.output;

  return inputCost + outputCost;
}

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const startTime = Date.now();
  const body = event.Records[0].body;
  const payload = WhatsNewGenerationPayloadSchema.parse(JSON.parse(body));

  const { correlationId, environment, generatedDate, releaseTag, releases } = payload;

  // Add correlation ID to all logs
  logger.updateMetadata({
    correlationId,
    environment,
    generatedDate,
    releases: releases ? releases.map(r => r.tag).join(', ') : releaseTag,
  });
  logger.log('====================================');
  logger.log("Started What's New modal generation queue handler");
  logger.log('====================================');

  try {
    await processModalGeneration(payload, logger, startTime);
  } catch (error) {
    const errorType = error instanceof Error ? error.constructor.name : 'UnknownError';
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Modal generation failed', {
      error: errorMessage,
      errorType,
      stack: error instanceof Error ? error.stack : undefined,
      correlationId,
      releaseTag,
      environment,
    });

    await updateGenerationStatus(
      'failed',
      {
        correlationId,
        generatedDate,
        error: errorMessage,
      },
      logger
    );

    // Send Slack failure notification (M7)
    await notifyGenerationFailure(
      errorMessage,
      {
        environment,
        correlationId,
        generatedDate,
      },
      logger
    );

    // Emit failure metric
    await emitModalGenerationMetrics([
      {
        name: 'Failure',
        value: 1,
        dimensions: {
          environment,
          releaseTag: generatedDate,
          errorType,
        },
        unit: StandardUnit.Count,
      },
    ]);

    throw error; // Re-throw to trigger DLQ
  }
});

async function processModalGeneration(
  payload: WhatsNewGenerationPayload,
  logger: Logger,
  startTime: number
): Promise<void> {
  const { correlationId, releaseTag, environment, generatedDate, releases } = payload;

  // Log generation context for fork tracking
  const repositoryName = payload.repositoryUrl.split('/').pop() || 'unknown';
  const isMainRepository = payload.repositoryUrl.includes('MillionOnMars/lumina5');

  logger.log('Modal generation context', {
    repository: repositoryName,
    repositoryUrl: payload.repositoryUrl,
    isMainRepository,
    releaseTag,
    environment,
    correlationId,
    commitsCount: payload.commits?.length || 0,
    pullRequestsCount: payload.pullRequests?.length || 0,
  });

  // 0. FETCH CONFIGURATION
  logger.log("Fetching What's New configuration...");
  const config = await WhatsNewConfigService.getConfig();
  logger.log('Configuration loaded', {
    modelId: config.modelId,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    modalPriority: config.modalPriority,
  });

  // 1. IDEMPOTENCY CHECK (atomic to prevent race conditions)
  // Uses findOne for check - the unique partial indexes will catch any race conditions at insert time
  // Note: "dev" is the SST stage name for staging environment
  // Generation metadata is now embedded directly in the Modal document
  const idempotencyQuery = {
    'generationMetadata.generatedDate': generatedDate,
    'generationMetadata.environment': environment,
  };

  const existing = await ModalModel.findOne(idempotencyQuery);

  if (existing) {
    logger.log('Modal already exists, skipping (duplicate prevention)', {
      generatedDate,
      modalId: existing._id?.toString(),
      existingGeneratedDate: existing.generationMetadata?.generatedDate,
      environment,
    });

    // Emit skip metric
    await emitModalGenerationMetrics([
      {
        name: 'Skipped',
        value: 1,
        dimensions: {
          environment,
          checkKey: generatedDate,
          reason: 'duplicate_modal',
        },
        unit: StandardUnit.Count,
      },
    ]);

    await updateGenerationStatus('skipped', { correlationId, generatedDate }, logger);
    return;
  }

  // 2. FETCH STYLE EXAMPLES FROM PREVIOUS MODALS
  logger.log("Fetching previous What's New modals for style learning...");
  const previousModals = await ModalModel.find({ tags: WHATS_NEW_MODAL_TAG, enabled: true })
    .sort({ startDate: -1 })
    .limit(config.maxPreviousModals)
    .select('title subtitle description')
    .lean();

  if (previousModals.length === 0) {
    logger.log('No previous modals found for style learning, using default template');
  } else {
    logger.log(`Found ${previousModals.length} previous modals for style reference`);
  }

  // 3. BUILD PROMPT WITH SANITIZATION
  logger.log('Sanitizing release content...');

  // Determine release body: use single releaseBody or combine releases array
  // Use distinctive delimiter to help AI distinguish between releases
  const releaseBodyText =
    payload.releaseBody || payload.releases?.map(r => `## Release ${r.tag}\n${r.body || ''}`).join('\n\n---\n\n') || '';

  const sanitizedContent = sanitizeContentForLLM({
    releaseBody: releaseBodyText,
    commits: payload.commits ?? [],
    pullRequests: payload.pullRequests ?? [],
    changelogExcerpt: payload.changelogExcerpt,
  });

  logger.log('Building prompt for LLM...', {
    commitsProcessed: sanitizedContent.commits.length,
    prsProcessed: sanitizedContent.pullRequests.length,
    hasChangelogData: !!payload.changelogData,
    releasesCount: payload.releases?.length || (payload.releaseTag ? 1 : 0),
  });

  const prompt = buildWhatsNewPrompt(
    {
      styleExamples: previousModals,
      releaseData: sanitizedContent,
      // NEW: Support for daily batching
      releaseTag: payload.releaseTag,
      changelogData: payload.changelogData,
      releases: payload.releases,
      generatedDate: payload.generatedDate,
    },
    config.promptTemplate, // Optional custom template
    logger
  );

  // 4. GET LLM SERVICE
  logger.log('Getting LLM for modal generation...');

  // Get API keys for system
  const dbAdapters = { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames };
  const coreKeys = await apiKeyService.getEffectiveLLMApiKeys('system', dbAdapters);
  const apiKeyTable = {
    openai: coreKeys.openai || undefined,
    anthropic: coreKeys.anthropic || undefined,
    gemini: coreKeys.gemini || undefined,
    bfl: coreKeys.bfl || undefined,
    ollama: coreKeys.ollama || undefined,
    xai: coreKeys.xai || undefined,
  };

  // Get available models with fallback (M5)
  const models = await getAvailableModels(apiKeyTable);
  let resolvedModelId = config.modelId;

  // Validate configured model against ChatModels enum
  const validModels = Object.values(ChatModels) as string[];
  if (!validModels.includes(resolvedModelId)) {
    logger.warn('Invalid LLM model configured, falling back to default', {
      configuredModel: resolvedModelId,
      defaultModel: DEFAULT_LLM_MODEL,
    });
    resolvedModelId = DEFAULT_LLM_MODEL;
  }

  let modelInfo = models.find(m => m.id === resolvedModelId);

  // If configured model not available, try falling back to default
  if (!modelInfo && resolvedModelId !== DEFAULT_LLM_MODEL) {
    logger.warn('Configured model not available, trying default', {
      configuredModel: resolvedModelId,
      defaultModel: DEFAULT_LLM_MODEL,
    });
    modelInfo = models.find(m => m.id === DEFAULT_LLM_MODEL);
    if (modelInfo) {
      resolvedModelId = DEFAULT_LLM_MODEL;
    }
  }

  if (!modelInfo) {
    throw new Error(
      `Neither configured model (${config.modelId}) nor default model (${DEFAULT_LLM_MODEL}) is available`
    );
  }

  // Initialize LLM
  const llm = getLlmByModel(apiKeyTable, {
    modelInfo,
    logger,
  });

  if (!llm) {
    throw new Error(`Failed to initialize LLM for model ${resolvedModelId}`);
  }

  logger.log('Calling LLM for modal generation', {
    modelId: resolvedModelId,
    modelName: modelInfo.name,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    promptLength: prompt.length,
  });

  // 5. GENERATE EACH AUDIENCE VARIANT (per-variant prompt scoping)
  // One scoped LLM call per registry key. The customer variant is the primary,
  // least-privileged content and gates the modal; the internal variant is
  // best-effort and falls back to the customer floor so internal viewers always
  // see at least the public content. All results are persisted in one atomic
  // write below - a failed/empty variant is an absent slice, never a partial doc.
  const modalSchema = createWhatsNewModalSchema({
    titleMaxLength: config.titleMaxLength,
    subtitleMaxLength: config.subtitleMaxLength,
    descriptionMaxLength: config.descriptionMaxLength,
  });

  type VariantFields = { title: string; subtitle: string; description: string };
  type VariantOutcome =
    | { status: 'ok'; content: VariantFields; inputTokens: number; outputTokens: number }
    | { status: 'no_changes' | 'failed' };

  const generateVariant = async (variant: (typeof AUDIENCE_VARIANTS)[number]): Promise<VariantOutcome> => {
    // Customer (least-privileged) variant gets scoping guidance to exclude internal-only changes.
    // Internal variant uses the base prompt unchanged - equivalent to the pre-variant behavior.
    const scopedPrompt = variant.audienceType === 'customer' ? `${buildVariantGuidance(variant)}\n\n${prompt}` : prompt;
    const messages = [{ role: 'user' as const, content: scopedPrompt }];
    let responseText = '';

    try {
      await Promise.race([
        llm.complete(
          resolvedModelId,
          messages,
          { temperature: config.temperature, maxTokens: config.maxTokens, stream: false },
          async texts => {
            if (texts && texts.length > 0) {
              const chunk = texts.join('');
              if (responseText.length + chunk.length > MAX_RESPONSE_SIZE) {
                throw new Error(`LLM response exceeded maximum size limit of ${MAX_RESPONSE_SIZE} characters`);
              }
              responseText += chunk;
            }
          }
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`LLM timeout after ${config.timeoutMs}ms`)), config.timeoutMs)
        ),
      ]);
    } catch (error) {
      logger.error('LLM generation failed for variant', {
        audience: variant.key,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 'failed' };
    }

    // Blank/whitespace-only output is ambiguous -> treat as a failure, NOT as the
    // empty-result sentinel.
    if (!responseText.trim()) {
      logger.warn('Empty LLM output for variant', { audience: variant.key });
      return { status: 'failed' };
    }

    try {
      const parsed = JSON.parse(extractJsonFromResponse(responseText));
      // Empty-result sentinel: exact match after trim (not a substring check).
      if (isNoVariantContent(parsed?.title)) {
        return { status: 'no_changes' };
      }
      const content = modalSchema.parse(parsed) as VariantFields;
      return {
        status: 'ok',
        content,
        inputTokens: Math.ceil(scopedPrompt.length / CHARS_PER_TOKEN),
        outputTokens: Math.ceil(responseText.length / CHARS_PER_TOKEN),
      };
    } catch (error) {
      logger.error('Failed to parse/validate variant output', {
        audience: variant.key,
        error: error instanceof Error ? error.message : String(error),
        responsePreview: responseText.substring(0, 500),
      });
      return { status: 'failed' };
    }
  };

  logger.log('Generating audience variants...', { variants: AUDIENCE_VARIANTS.map(v => v.key) });

  let inputTokens = 0;
  let outputTokens = 0;

  // Run both variant LLM calls concurrently - halves wall-clock vs sequential
  // await and keeps total well within the Lambda timeout budget.
  // DLQ note: a hard customer-variant failure throws -> SQS retry (maxReceiveCount: 3).
  // Each retry re-executes both variants, so a sustained Bedrock outage costs up to
  // 3 retries x 2 variants = 6 Bedrock calls per failed message.
  const variantResults = await Promise.all(AUDIENCE_VARIANTS.map(v => generateVariant(v)));
  const variantOutcomes: Record<string, VariantOutcome> = Object.fromEntries(
    variantResults.map((outcome, i) => [AUDIENCE_VARIANTS[i].key, outcome])
  );
  for (const [i, outcome] of variantResults.entries()) {
    const variant = AUDIENCE_VARIANTS[i];
    if (outcome.status === 'ok') {
      inputTokens += outcome.inputTokens;
      outputTokens += outcome.outputTokens;
    }
    // Per-variant outcome metering - success / no_changes / failed are DISTINCT
    // states so a silent per-audience failure can't look like "nothing qualified".
    await emitModalGenerationMetrics([
      {
        name:
          outcome.status === 'ok'
            ? 'VariantSuccess'
            : outcome.status === 'no_changes'
              ? 'VariantNoChanges'
              : 'VariantFailed',
        value: 1,
        dimensions: { environment, audience: variant.key, releaseTag: generatedDate },
        unit: StandardUnit.Count,
      },
    ]);
  }

  const customerVariant = AUDIENCE_VARIANTS.find(v => v.audienceType === 'customer') ?? AUDIENCE_VARIANTS[0];
  const internalVariant = AUDIENCE_VARIANTS.find(v => v.audienceType === 'internal');
  const customerOutcome = variantOutcomes[customerVariant.key];
  const internalOutcome = internalVariant ? variantOutcomes[internalVariant.key] : undefined;

  const scrubFields = (c: VariantFields, v: (typeof AUDIENCE_VARIANTS)[number]): VariantFields => ({
    title: scrubInternalReferences(c.title, v),
    subtitle: scrubInternalReferences(c.subtitle, v),
    description: scrubInternalReferences(c.description, v),
  });

  let variants: Record<string, VariantFields>;
  let modalData: VariantFields;

  if (customerOutcome.status === 'no_changes') {
    await emitModalGenerationMetrics([
      {
        name: 'NoUserFacingChanges',
        value: 1,
        dimensions: { environment, releaseTag: generatedDate },
        unit: StandardUnit.Count,
      },
    ]);

    // Engineering/infra-only release: no customer-facing changes but the internal
    // variant has content, so admins should still see what shipped. Persist a
    // modal with only the internal key. extractVariantForViewer returns null for
    // the absent customer key, so non-admin viewers never receive this modal.
    if (internalVariant && internalOutcome?.status === 'ok') {
      logger.log('No customer-facing changes; internal content exists — creating internal-only modal', {
        correlationId,
        environment,
        generatedDate,
      });
      // scrubFields is a no-op for internal variants by design (scrubInternalReferences
      // only strips denylist tokens from less-privileged audiences). The call is kept
      // for structural consistency with the normal path; it does no harm.
      variants = { [internalVariant.key]: scrubFields(internalOutcome.content, internalVariant) };
      modalData = variants[internalVariant.key];
    } else {
      logger.log('No user-facing changes for any audience - skipping modal creation', {
        correlationId,
        environment,
        generatedDate,
      });
      logger.log('====================================');
      logger.log('Processing completed - no modal needed');
      logger.log('====================================');
      await updateGenerationStatus('no_changes', { correlationId, generatedDate, modelUsed: resolvedModelId }, logger);
      return; // Graceful exit - message acknowledged, no retry
    }
  } else {
    // A hard failure of the primary variant should retry (DLQ).
    if (customerOutcome.status !== 'ok') {
      throw new Error('Customer variant generation failed - no user-facing content produced');
    }
    const customerContent = customerOutcome.content;

    // Build the variants map. Less-privileged (customer) fields are scrubbed of
    // internal references (write-side leak defense); a variant that failed or
    // returned no_changes falls back to the customer floor so every audience sees
    // at least the public content.
    variants = {};
    for (const variant of AUDIENCE_VARIANTS) {
      const outcome = variantOutcomes[variant.key];
      if (outcome.status === 'no_changes') {
        // Internal returning no_changes on a customer-ok release is unexpected -
        // the internal prompt is a superset of customer content. Flag for ops.
        logger.warn('Non-customer variant returned no_changes unexpectedly — falling back to customer floor', {
          audience: variant.key,
          correlationId,
        });
      }
      const content = outcome.status === 'ok' ? outcome.content : customerContent;
      variants[variant.key] = scrubFields(content, variant);
    }

    // Top-level base = the scrubbed customer (least-privileged) slice. The serve
    // guard overrides this per viewer or drops the doc, so storing the least-
    // privileged slice at top level keeps any legacy/unclassified read leak-safe.
    modalData = variants[customerVariant.key];
  }

  // POST-PROCESS: Ensure title uses correct generated date for PR-based updates
  // The AI may incorrectly use commit/PR dates instead of the generatedDate
  const isPRMode = !releases || releases.length === 0;
  if (generatedDate && isPRMode) {
    try {
      // Format the correct date (e.g., "December 4, 2025")
      const dateObj = new Date(generatedDate + 'T00:00:00Z'); // Parse as UTC
      const correctDateStr = dateObj.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      });

      // Apply date correction to every variant title - internal title was
      // previously skipped, leaving admins with a potentially wrong date.
      const datePattern = /What's New - [A-Za-z]+ \d{1,2}, \d{4}/i;
      const expectedTitle = `What's New - ${correctDateStr}`;
      let anyTitleMatched = false;
      for (const vKey of Object.keys(variants)) {
        const vData = variants[vKey];
        if (datePattern.test(vData.title)) {
          anyTitleMatched = true;
          if (vData.title !== expectedTitle) {
            logger.log('Correcting AI-generated title date', {
              variant: vKey,
              original: vData.title,
              corrected: expectedTitle,
              generatedDate,
            });
            vData.title = expectedTitle;
          }
        }
      }
      if (!anyTitleMatched) {
        logger.warn('Title does not match expected date pattern', {
          title: modalData.title,
          expectedPattern: "What's New - [Month Day, Year]",
        });
      }
    } catch (error) {
      logger.error('Failed to correct title date', {
        error: error instanceof Error ? error.message : String(error),
        generatedDate,
      });
      // Don't throw - use AI's title as fallback
    }
  }

  // Cost from the per-variant token totals accumulated above.
  const estimatedCost = calculateLLMCost(resolvedModelId, inputTokens, outputTokens);

  logger.log('LLM generation successful', {
    titleLength: modalData.title.length,
    subtitleLength: modalData.subtitle.length,
    descriptionLength: modalData.description.length,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCost: `$${estimatedCost.toFixed(6)}`,
  });

  // 7. CREATE MODAL IN TRANSACTION
  logger.log('Creating modal in database...');
  let modal: InstanceType<typeof ModalModel> | undefined;

  try {
    await withTransaction(async session => {
      // Create modal with embedded generation metadata
      // The generationMetadata field is only populated for auto-generated modals
      // Manual modals created via admin UI will have generationMetadata: null
      const createdModals = await ModalModel.create(
        [
          {
            title: modalData.title,
            subtitle: modalData.subtitle,
            description: modalData.description,
            // Per-audience content map. The serve-time guard extracts one slice
            // per viewer and strips this field before any response.
            variants,
            tags: [WHATS_NEW_MODAL_TAG],
            priority: config.modalPriority,
            closeButton: true,
            agreeButton: true,
            enabled: true,
            isBanner: false,
            // Set createdAt to generatedDate so admin UI sorting matches the date the modal represents
            createdAt: new Date(generatedDate + 'T00:00:00Z'),
            startDate: new Date().toISOString(),
            endDate: new Date(Date.now() + config.modalExpiryDays * MS_PER_DAY).toISOString(),
            numberOfViews: {
              type: 'firstTimeView',
              value: 0,
              threshold: 1,
              tags: [WHATS_NEW_MODAL_TAG],
            },
            // Embedded generation metadata for idempotency and tracking
            generationMetadata: {
              generatedDate,
              // Array of release tags (for daily batching)
              releases: releases ? releases.map(r => r.tag) : releaseTag ? [releaseTag] : [],
              // Single release tag (backward compatibility)
              releaseTag: releaseTag || (releases && releases[0]?.tag),
              generatedAt: new Date(),
              correlationId,
              modelUsed: resolvedModelId,
              environment,
            },
          },
        ],
        { session }
      );

      // Verify modal was created successfully before proceeding
      if (!createdModals?.[0]?._id) {
        throw new Error('Modal creation returned empty or invalid result');
      }
      modal = createdModals[0];

      // Skip analytics logging for system-generated events (no user context)
      // The logEvent function requires a userId, but automated modal generation
      // happens via GitHub Actions without a user session.
      logger.log('Skipping analytics event logging for system-generated modal');
    });
  } catch (error) {
    // Handle duplicate key error (race condition - another process created the modal)
    const isDuplicateKeyError =
      error instanceof Error && (error.message.includes('E11000') || error.message.includes('duplicate key'));

    if (isDuplicateKeyError) {
      logger.log('Modal was created by another process, skipping (race condition)', {
        generatedDate,
        releaseTag,
        environment,
      });

      // Emit skip metric for race condition case
      await emitModalGenerationMetrics([
        {
          name: 'Skipped',
          value: 1,
          dimensions: {
            environment,
            checkKey: generatedDate,
            reason: 'race_condition_duplicate',
          },
          unit: StandardUnit.Count,
        },
      ]);

      await updateGenerationStatus('skipped', { correlationId, generatedDate }, logger);
      return; // Gracefully exit - another process handled this
    }

    logger.error('Failed to create modal in database', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  if (!modal) {
    throw new Error('Modal creation failed - modal is undefined');
  }

  const duration = Date.now() - startTime;

  logger.log('====================================');
  logger.log('Modal generation completed successfully');
  logger.log('====================================');
  logger.log('Summary:', {
    modalId: modal._id?.toString() ?? 'unknown',
    releaseTag,
    environment,
    duration: `${duration}ms`,
    title: modalData.title,
  });

  // Update generation status with success (M6)
  await updateGenerationStatus(
    'success',
    {
      correlationId,
      generatedDate,
      modelUsed: resolvedModelId,
    },
    logger
  );

  // Upload to S3 distribution bucket for fork environments.
  // Skip internal-only modals (no customer variant): forks store the flat
  // top-level fields with no variants map, so every fork viewer would see
  // internal text via the legacy-passthrough branch of extractVariantForViewer.
  if (variants[customerVariant.key]) {
    try {
      await WhatsNewDistributionService.uploadModal({
        modalId: modal._id?.toString() ?? '',
        title: modalData.title,
        subtitle: modalData.subtitle,
        description: modalData.description,
        generatedDate,
        releaseTag,
        releases: releases?.map(r => r.tag),
        environment,
        createdAt: new Date(generatedDate + 'T00:00:00Z').toISOString(),
        metadata: {
          modelUsed: resolvedModelId,
          correlationId,
          repositoryUrl: payload.repositoryUrl,
        },
      });
      logger.log('Modal uploaded to S3 distribution bucket');
    } catch (s3Error) {
      // Log but don't fail - S3 distribution is supplementary
      logger.warn('Failed to upload modal to S3 distribution bucket (non-critical)', {
        error: s3Error instanceof Error ? s3Error.message : String(s3Error),
      });
    }
  } else {
    logger.log('Skipping S3 distribution — internal-only modal has no customer content for fork environments');
  }

  // Emit success metrics to CloudWatch
  // Note: Token estimation uses char/CHARS_PER_TOKEN approximation. Actual Bedrock tokenization differs.
  // This provides order-of-magnitude cost tracking until precise token counts are available.
  const totalTokens = inputTokens + outputTokens;

  await emitModalGenerationMetrics([
    {
      name: 'Success',
      value: 1,
      dimensions: {
        environment,
        releaseTag: generatedDate,
        repository: payload.repositoryUrl.split('/').pop() || 'unknown',
      },
      unit: StandardUnit.Count,
    },
    {
      name: 'Duration',
      value: duration,
      dimensions: {
        environment,
        releaseTag: generatedDate,
      },
      unit: StandardUnit.Milliseconds,
    },
    {
      name: 'InputTokens',
      value: inputTokens,
      dimensions: {
        environment,
        modelId: resolvedModelId,
      },
      unit: StandardUnit.Count,
    },
    {
      name: 'OutputTokens',
      value: outputTokens,
      dimensions: {
        environment,
        modelId: resolvedModelId,
      },
      unit: StandardUnit.Count,
    },
    {
      name: 'TokensUsed',
      value: totalTokens,
      dimensions: {
        environment,
        modelId: resolvedModelId,
      },
      unit: StandardUnit.Count,
    },
    {
      name: 'EstimatedCost',
      value: estimatedCost,
      dimensions: {
        environment,
        modelId: resolvedModelId,
      },
      unit: StandardUnit.None, // Dollars
    },
  ]);
}
