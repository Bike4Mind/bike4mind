import {
  ModalModel,
  AdminSettings,
  slackDevWorkspaceRepository,
  apiKeyRepository,
  adminSettingsRepository,
} from '@bike4mind/database';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { WhatsNewHighlightsPayloadSchema } from './whatsNewHighlights.types';
import type { WhatsNewHighlightsConfig, ModalForHighlights } from './whatsNewHighlights.types';
import { buildHighlightsPrompt, createSlackBlocks, formatHighlightsForSlack } from './whatsNewHighlights.prompt';
import { getSettingsByNames } from '@bike4mind/utils';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { apiKeyService } from '@bike4mind/services';
import { ChatModels } from '@bike4mind/common';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { emitModalGenerationMetrics } from '@server/utils/cloudwatch';
import { decryptToken } from '@server/security/tokenEncryption';

const SETTING_NAME = 'whatsNewHighlightsConfig';
const WHATS_NEW_MODAL_TAG = 'whats-new';

// LLM configuration
const MAX_RESPONSE_SIZE = 100000; // 100KB limit for highlights (longer than modals)
const LLM_TIMEOUT_MS = 120000; // 2 minutes timeout for LLM generation
const DEFAULT_LLM_MODEL = ChatModels.GPT4o_MINI;

/**
 * Queue handler for generating What's New weekly highlights and posting to Slack
 */
export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const startTime = Date.now();
  const body = event.Records[0].body;
  const payload = WhatsNewHighlightsPayloadSchema.parse(JSON.parse(body));

  const { correlationId, environment, startDate, endDate, manualTrigger } = payload;

  // Add correlation ID to all logs
  logger.updateMetadata({
    correlationId,
    environment,
    startDate,
    endDate,
    manualTrigger: manualTrigger || false,
  });

  logger.log('====================================');
  logger.log("Started What's New highlights generation");
  logger.log('====================================');

  try {
    await processHighlightsGeneration(payload, logger, startTime);
  } catch (error) {
    const errorType = error instanceof Error ? error.constructor.name : 'UnknownError';
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Highlights generation failed', {
      error: errorMessage,
      errorType,
      stack: error instanceof Error ? error.stack : undefined,
      correlationId,
    });

    await updateSettingsStatus('failed', undefined, correlationId);

    // Emit failure metric
    await emitModalGenerationMetrics([
      {
        name: 'HighlightsFailure',
        value: 1,
        dimensions: {
          environment,
          errorType,
        },
        unit: StandardUnit.Count,
      },
    ]);

    throw error; // Re-throw to trigger DLQ
  }
});

async function processHighlightsGeneration(
  payload: ReturnType<typeof WhatsNewHighlightsPayloadSchema.parse>,
  logger: Logger,
  startTime: number
): Promise<void> {
  const { correlationId, environment, slackChannelId, slackTeamId } = payload;

  // 1. CALCULATE DATE RANGE
  const endDate = payload.endDate ? new Date(payload.endDate) : new Date();
  const startDate = payload.startDate
    ? new Date(payload.startDate)
    : new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

  const dateRange = {
    start: startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    end: endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
  };

  logger.log('Date range for highlights', { startDate: dateRange.start, endDate: dateRange.end });

  // 2. FETCH MODALS FROM DATABASE
  logger.log("Fetching What's New modals from database...");

  const modals = await ModalModel.find({
    tags: { $in: [WHATS_NEW_MODAL_TAG, 'whatsNew'] },
    enabled: true,
    createdAt: { $gte: startDate, $lte: endDate },
  })
    .sort({ createdAt: -1 })
    .select('title subtitle description createdAt startDate priority')
    .lean<ModalForHighlights[]>();

  logger.log(`Found ${modals.length} What's New modals`, {
    modalIds: modals.map(m => m._id.toString()),
  });

  if (modals.length === 0) {
    logger.log('No modals found for the date range - posting warning to Slack');
    await updateSettingsStatus('no_modals', undefined, correlationId);

    // Post warning to Slack so the team always gets a Saturday message (M8)
    if (slackChannelId && slackTeamId) {
      try {
        const workspace = await slackDevWorkspaceRepository.findBySlackTeamIdWithToken(slackTeamId);
        if (workspace?.slackBotToken) {
          const warningBlocks = [
            {
              type: 'header',
              text: { type: 'plain_text', text: "What's New Weekly Highlights", emoji: true },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*No What's New modals found* for ${dateRange.start} — ${dateRange.end}.\n\nThis may indicate daily modal generation is not running. Check the admin panel for generation health status.`,
              },
            },
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: `Correlation ID: \`${correlationId}\`` }],
            },
          ];

          const response = await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${workspace.slackBotToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              channel: slackChannelId,
              text: `No What's New modals found for ${dateRange.start} — ${dateRange.end}. Daily generation may not be running.`,
              blocks: warningBlocks,
              unfurl_links: false,
              unfurl_media: false,
            }),
          });

          const result = (await response.json()) as { ok: boolean; error?: string };
          if (result.ok) {
            logger.log('Posted no-modals warning to Slack');
          } else {
            logger.warn('Failed to post no-modals warning to Slack', { error: result.error });
          }
        }
      } catch (slackError) {
        logger.warn('Failed to send no-modals Slack warning', {
          error: slackError instanceof Error ? slackError.message : String(slackError),
        });
      }
    }

    return;
  }

  // 3. GET LLM CONFIGURATION
  const config = await getHighlightsConfig();
  let llmModel = config?.llmModel || DEFAULT_LLM_MODEL;

  // Validate model is a known ChatModels value, fallback to default if not
  const validModels = Object.values(ChatModels) as string[];
  if (!validModels.includes(llmModel)) {
    logger.warn('Invalid LLM model configured, falling back to default', {
      configuredModel: llmModel,
      defaultModel: DEFAULT_LLM_MODEL,
    });
    llmModel = DEFAULT_LLM_MODEL;
  }

  logger.log('Using LLM model for highlights', { llmModel });

  // 4. BUILD PROMPT
  const customTemplate = config?.promptTemplate;
  const prompt = buildHighlightsPrompt(modals, dateRange, customTemplate);

  logger.log('Built highlights prompt', {
    promptLength: prompt.length,
    modalCount: modals.length,
    usingCustomTemplate: !!customTemplate,
  });

  // 5. GET LLM SERVICE
  logger.log('Initializing LLM service...');

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

  const models = await getAvailableModels(apiKeyTable);
  let modelInfo = models.find(m => m.id === llmModel);

  // If configured model not available, try falling back to default
  if (!modelInfo) {
    logger.warn('Configured model not available, trying default', {
      configuredModel: llmModel,
      defaultModel: DEFAULT_LLM_MODEL,
    });
    modelInfo = models.find(m => m.id === DEFAULT_LLM_MODEL);
    if (!modelInfo) {
      throw new Error(`Neither configured model (${llmModel}) nor default model (${DEFAULT_LLM_MODEL}) is available`);
    }
    llmModel = DEFAULT_LLM_MODEL;
  }

  const llm = getLlmByModel(apiKeyTable, {
    modelInfo,
    logger,
  });

  if (!llm) {
    throw new Error(`Failed to initialize LLM for model ${llmModel}`);
  }

  // 6. CALL LLM
  logger.log('Calling LLM for highlights generation...');

  let responseText = '';
  const messages = [{ role: 'user' as const, content: prompt }];

  try {
    await Promise.race([
      llm.complete(
        llmModel,
        messages,
        {
          temperature: 0.7,
          maxTokens: 4000,
          stream: false,
        },
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
        setTimeout(() => reject(new Error(`LLM timeout after ${LLM_TIMEOUT_MS}ms`)), LLM_TIMEOUT_MS)
      ),
    ]);
  } catch (error) {
    logger.error('LLM generation failed', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }

  logger.log('LLM generation successful', {
    responseLength: responseText.length,
  });

  // 7. POST TO SLACK
  if (slackChannelId && slackTeamId) {
    logger.log('Posting highlights to Slack...', { slackChannelId, slackTeamId });

    const attachMarkdownFile = config?.attachMarkdownFile !== false; // Default to true
    await postToSlack(responseText, dateRange, slackChannelId, slackTeamId, attachMarkdownFile, logger);

    logger.log('Successfully posted highlights to Slack');
  } else {
    logger.log('No Slack channel configured - skipping Slack post');
  }

  // 8. UPDATE SETTINGS WITH SUCCESS
  await updateSettingsStatus('success', responseText, correlationId);

  const duration = Date.now() - startTime;

  logger.log('====================================');
  logger.log('Highlights generation completed successfully!');
  logger.log('====================================');
  logger.log('Summary:', {
    duration: `${duration}ms`,
    modalsProcessed: modals.length,
    highlightsLength: responseText.length,
    postedToSlack: !!(slackChannelId && slackTeamId),
  });

  // Emit success metric
  await emitModalGenerationMetrics([
    {
      name: 'HighlightsSuccess',
      value: 1,
      dimensions: { environment },
      unit: StandardUnit.Count,
    },
    {
      name: 'HighlightsDuration',
      value: duration,
      dimensions: { environment },
      unit: StandardUnit.Milliseconds,
    },
  ]);
}

/**
 * Slack chat.postMessage API response
 */
interface SlackPostMessageResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
}

/**
 * Slack files.getUploadURLExternal API response
 */
interface SlackGetUploadUrlResponse {
  ok: boolean;
  error?: string;
  upload_url?: string;
  file_id?: string;
}

/**
 * Slack files.completeUploadExternal API response
 */
interface SlackCompleteUploadResponse {
  ok: boolean;
  error?: string;
  files?: Array<{
    id: string;
    name: string;
  }>;
}

/**
 * Post highlights to Slack channel using bot token
 */
async function postToSlack(
  highlights: string,
  dateRange: { start: string; end: string },
  channelId: string,
  teamId: string,
  attachMarkdownFile: boolean,
  logger: Logger
): Promise<void> {
  const workspace = await slackDevWorkspaceRepository.findBySlackTeamIdWithToken(teamId);

  if (!workspace) {
    throw new Error(`Slack workspace not found for team ID: ${teamId}`);
  }

  if (!workspace.slackBotToken) {
    throw new Error(`No bot token found for Slack workspace: ${teamId}`);
  }

  const blocks = createSlackBlocks(highlights, dateRange);

  // Fallback text for notifications
  const fallbackText = formatHighlightsForSlack(highlights).substring(0, 500) + '...';

  let result: SlackPostMessageResponse;
  try {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${decryptToken(workspace.slackBotToken)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: channelId,
        text: fallbackText,
        blocks,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    result = await response.json();
  } catch (error) {
    throw new Error(`Slack chat.postMessage request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!result.ok) {
    logger.error('Slack API error', { error: result.error });
    throw new Error(`Slack API error: ${result.error}`);
  }

  logger.log('Slack message posted', {
    ts: result.ts,
    channel: result.channel,
  });

  // Upload raw markdown as a snippet for easy copy/paste (if enabled)
  if (attachMarkdownFile) {
    await uploadMarkdownSnippet(highlights, dateRange, channelId, decryptToken(workspace.slackBotToken) ?? '', logger);
  } else {
    logger.log('Markdown file attachment disabled - skipping snippet upload');
  }
}

/**
 * Upload the raw markdown as a text snippet for easy copy/paste
 * Uses Slack's V2 upload API (files.getUploadURLExternal + files.completeUploadExternal)
 */
async function uploadMarkdownSnippet(
  highlights: string,
  dateRange: { start: string; end: string },
  channelId: string,
  botToken: string,
  logger: Logger
): Promise<void> {
  const filename = `weekly-highlights-${dateRange.start.replace(/,?\s+/g, '-')}-to-${dateRange.end.replace(/,?\s+/g, '-')}.md`;
  const fileContent = Buffer.from(highlights, 'utf-8');

  // Step 1: Get upload URL from Slack
  const getUrlParams = new URLSearchParams({
    filename,
    length: fileContent.length.toString(),
  });

  let getUrlResult: SlackGetUploadUrlResponse;
  try {
    const getUrlResponse = await fetch(`https://slack.com/api/files.getUploadURLExternal?${getUrlParams}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${botToken}`,
      },
    });
    getUrlResult = await getUrlResponse.json();
  } catch (error) {
    logger.warn('Failed to request upload URL for markdown snippet', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (!getUrlResult.ok || !getUrlResult.upload_url || !getUrlResult.file_id) {
    logger.warn('Failed to get upload URL for markdown snippet', { error: getUrlResult.error });
    return;
  }

  logger.log('Got upload URL from Slack', { fileId: getUrlResult.file_id });

  // Step 2: Upload file content to the provided URL
  try {
    const uploadResponse = await fetch(getUrlResult.upload_url, {
      method: 'POST',
      body: fileContent,
    });

    if (!uploadResponse.ok) {
      logger.warn('Failed to upload file content', { status: uploadResponse.status });
      return;
    }
  } catch (error) {
    logger.warn('Failed to upload file content to Slack', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  logger.log('File content uploaded successfully');

  // Step 3: Complete the upload and share to channel
  let completeResult: SlackCompleteUploadResponse;
  try {
    const completeResponse = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: [
          {
            id: getUrlResult.file_id,
            title: `Weekly Highlights - ${dateRange.start} to ${dateRange.end}`,
          },
        ],
        channel_id: channelId,
        initial_comment: 'Raw markdown version for easy copy/paste:',
      }),
    });
    completeResult = await completeResponse.json();
  } catch (error) {
    logger.warn('Failed to complete Slack upload', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (!completeResult.ok) {
    logger.warn('Failed to complete markdown snippet upload', { error: completeResult.error });
    return;
  }

  logger.log('Markdown snippet uploaded', {
    fileId: completeResult.files?.[0]?.id,
    filename: completeResult.files?.[0]?.name,
  });
}

/**
 * Get highlights configuration from AdminSettings
 */
async function getHighlightsConfig(): Promise<WhatsNewHighlightsConfig | null> {
  const setting = await AdminSettings.findOne({ settingName: SETTING_NAME });
  if (!setting?.settingValue) return null;
  return setting.settingValue as unknown as WhatsNewHighlightsConfig;
}

/**
 * Update settings with generation status
 */
async function updateSettingsStatus(
  status: 'success' | 'failed' | 'no_modals',
  highlights: string | undefined,
  correlationId: string
): Promise<void> {
  await AdminSettings.findOneAndUpdate(
    { settingName: SETTING_NAME },
    {
      $set: {
        'settingValue.lastStatus': status,
        'settingValue.lastHighlights': highlights,
        'settingValue.lastCorrelationId': correlationId,
        'settingValue.lastCompletedAt': new Date().toISOString(),
      },
    },
    { upsert: true }
  );
}
