import { QuestMasterPlan, Quest, FabFile, apiKeyRepository, adminSettingsRepository } from '@bike4mind/database';
import { secureParameters, getSettingsByNames } from '@bike4mind/utils';
import { getLlmByModel, getAvailableModels } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { sendToClient } from '@server/websocket/utils';
import { getFilesStorage, getGeneratedImageStorage } from '@server/utils/storage';
import { apiKeyService } from '@bike4mind/services';
import { ChatModels, isImageServeable } from '@bike4mind/common';
import { z } from 'zod';
import { Resource } from 'sst';
import { createZipBuffer } from './createZipBuffer';
import path from 'path';

const QuestExportPayload = z.object({
  exportJobId: z.string(),
  planId: z.string(),
  userId: z.string(),
});

type ExportStatus = 'assembling' | 'downloading_images' | 'summarizing' | 'zipping' | 'completed' | 'failed';

// Summary generation constants
const SUMMARY_MODEL = ChatModels.CLAUDE_4_5_HAIKU_BEDROCK;
const SUMMARY_MAX_INPUT_CHARS = 100000; // ~25K tokens - enough for most content
const SUMMARY_MAX_TOKENS = 2000; // Output limit for summary
const SUMMARY_TIMEOUT_MS = 60000; // 1 minute timeout

async function sendProgress(
  userId: string,
  endpoint: string,
  exportJobId: string,
  planId: string,
  status: ExportStatus,
  progress: number,
  detail?: string,
  extras?: { downloadUrl?: string; filename?: string; errorMessage?: string }
) {
  await sendToClient(userId, endpoint, {
    action: 'quest_export_progress',
    exportJobId,
    planId,
    status,
    progress,
    detail,
    ...extras,
  });
}

/**
 * Extracts S3 image URLs from markdown content and images arrays.
 * Returns an array of unique URLs.
 */
function extractImageUrls(content: string, imageArrays: string[][]): string[] {
  const urls = new Set<string>();

  // Match markdown images: ![...](url)
  const mdImageRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdImageRegex.exec(content)) !== null) {
    const url = match[1];
    if (isS3Url(url)) urls.add(url);
  }

  // Match HTML img tags: <img src="url">
  const htmlImgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
  while ((match = htmlImgRegex.exec(content)) !== null) {
    const url = match[1];
    if (isS3Url(url)) urls.add(url);
  }

  // Add images from arrays
  for (const images of imageArrays) {
    for (const url of images) {
      if (isS3Url(url)) urls.add(url);
    }
  }

  return Array.from(urls);
}

function isS3Url(url: string): boolean {
  return url.includes('.amazonaws.com') || url.includes('cloudfront.net');
}

/**
 * Extracts the S3 key from a URL.
 * Handles both direct S3 URLs and CloudFront URLs.
 */
function extractS3Key(url: string): string {
  try {
    const parsed = new URL(url);
    // Strip leading slash and query params (presigned signatures)
    return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    // Fallback: strip everything before the key pattern
    return url.split('?')[0].replace(/^https?:\/\/[^/]+\//, '');
  }
}

/**
 * Determines which storage to use based on the URL.
 */
function getStorageForUrl(url: string): { storage: S3Storage; label: string } {
  if (url.includes('generatedimages') || url.includes('generated-images')) {
    return { storage: getGeneratedImageStorage(), label: 'generatedImages' };
  }
  return { storage: getFilesStorage(), label: 'files' };
}

function getExtensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if (ext && ext.length <= 5) return ext;
  } catch {
    // ignore
  }
  return '.png';
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * Returns the appropriate status icon for a subquest status.
 * ✓ = completed, 🔄 = in_progress, ⏳ = not_started, ⏭ = skipped
 */
function getStatusIcon(status: string): string {
  switch (status) {
    case 'completed':
      return ' ✓';
    case 'in_progress':
      return ' 🔄';
    case 'not_started':
      return ' ⏳';
    case 'skipped':
      return ' ⏭';
    default:
      return '';
  }
}

/**
 * Generates an executive summary of the quest plan using an LLM.
 * Truncates input if too large to fit in context.
 */
async function generateSummary(
  markdown: string,
  goal: string,
  logger: Logger,
  userId?: string
): Promise<string | null> {
  try {
    // Truncate if too large
    let content = markdown;
    let truncated = false;
    if (content.length > SUMMARY_MAX_INPUT_CHARS) {
      content = content.slice(0, SUMMARY_MAX_INPUT_CHARS);
      truncated = true;
      logger.info(`Content truncated for summary: ${markdown.length} -> ${SUMMARY_MAX_INPUT_CHARS} chars`);
    }

    // Get API keys
    const dbAdapters = {
      db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
      getSettingsByNames,
    };
    const coreKeys = await apiKeyService.getEffectiveLLMApiKeys('system', dbAdapters);
    const apiKeyTable = {
      openai: coreKeys.openai || undefined,
      anthropic: coreKeys.anthropic || undefined,
      gemini: coreKeys.gemini || undefined,
      bfl: coreKeys.bfl || undefined,
      ollama: coreKeys.ollama || undefined,
      xai: coreKeys.xai || undefined,
    };

    // Get available models and find our target model
    const models = await getAvailableModels(apiKeyTable);
    const modelInfo = models.find(m => m.id === SUMMARY_MODEL);

    if (!modelInfo) {
      logger.warn(`Summary model ${SUMMARY_MODEL} not available, skipping summary generation`);
      return null;
    }

    // Initialize LLM
    const llm = getLlmByModel(apiKeyTable, { modelInfo, logger, endUserId: userId });
    if (!llm) {
      logger.warn('Failed to initialize LLM for summary, skipping');
      return null;
    }

    const systemPrompt = `You are an expert at creating executive summaries. Your task is to create a polished, professional summary of a QuestMaster project plan.

The summary should:
- Be 1-2 pages (roughly 500-800 words)
- Start with a clear statement of the project goal
- Highlight the key phases/quests and their objectives
- Note major accomplishments and deliverables
- Mention any notable challenges or decisions made
- End with the current status and any next steps

Write in a clear, professional tone suitable for stakeholders or team members who need a quick overview.${truncated ? '\n\nNote: The full content was truncated for processing. Summarize what is provided.' : ''}`;

    const userPrompt = `Please create an executive summary for this QuestMaster project:

**Project Goal:** ${goal}

**Full Content:**
${content}`;

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userPrompt },
    ];

    let responseText = '';

    await Promise.race([
      llm.complete(
        SUMMARY_MODEL,
        messages,
        {
          temperature: 0.3, // Lower temperature for more consistent output
          maxTokens: SUMMARY_MAX_TOKENS,
          stream: false,
        },
        async (texts: (string | null | undefined)[]) => {
          if (texts && texts.length > 0) {
            responseText += texts.filter(Boolean).join('');
          }
        }
      ),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Summary generation timeout after ${SUMMARY_TIMEOUT_MS}ms`)),
          SUMMARY_TIMEOUT_MS
        )
      ),
    ]);

    if (!responseText.trim()) {
      logger.warn('Empty summary response from LLM');
      return null;
    }

    logger.info(`Summary generated: ${responseText.length} chars`);
    return responseText;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Summary generation failed: ${errorMsg}`);
    // Don't throw - summary is optional, export should still succeed
    return null;
  }
}

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const body = event.Records[0].body;
  const { exportJobId, planId, userId } = secureParameters(JSON.parse(body), QuestExportPayload);

  logger.updateMetadata({ exportJobId, planId, userId });

  const websocketEndpoint = Resource.websocket.managementEndpoint;
  const appFiles = new S3Storage(Resource.appFilesBucket.name);
  const dateStr = new Date().toISOString().split('T')[0];

  try {
    // Phase 1: Assembling markdown
    await sendProgress(userId, websocketEndpoint, exportJobId, planId, 'assembling', 10, 'Loading quest plan...');

    const plan = await QuestMasterPlan.findById(planId);
    if (!plan) {
      throw new Error(`Quest plan ${planId} not found`);
    }

    // Verify ownership
    if (plan.userId !== userId && !plan.sharedWith?.includes(userId)) {
      throw new Error('Access denied');
    }

    // Idempotency check: skip if ZIP already exists (must be after plan load to get slug)
    const slug = slugify(plan.goal);
    const finalZipKey = `exports/quest/${exportJobId}/questmaster-${slug}-${dateStr}.zip`;

    try {
      await appFiles.getMetadata(finalZipKey);
      logger.info(`ZIP already exists at ${finalZipKey}, emitting completed event for idempotent retry`);

      // Generate presigned URL and emit completed event so client receives download URL on retry
      const filename = `questmaster-${slug}-${dateStr}.zip`;
      const downloadUrl = await appFiles.getSignedUrl(finalZipKey, 'get', {
        expiresIn: 3600,
        ResponseContentDisposition: `attachment; filename="${filename}"`,
      });
      await sendProgress(userId, websocketEndpoint, exportJobId, planId, 'completed', 100, 'Export complete!', {
        downloadUrl,
        filename,
      });
      return;
    } catch {
      // File doesn't exist, proceed
    }

    // Collect all questIds from subQuests
    const questIds: string[] = [];
    for (const quest of plan.quests) {
      for (const subQuest of quest.subQuests) {
        if (subQuest.questId) {
          questIds.push(subQuest.questId);
        }
      }
    }

    await sendProgress(userId, websocketEndpoint, exportJobId, planId, 'assembling', 20, 'Loading responses...');

    // Batch fetch all ChatHistoryItems
    const chatItems = questIds.length > 0 ? await Quest.find({ _id: { $in: questIds } }).lean() : [];
    const chatItemMap = new Map<string, Record<string, unknown>>();
    for (const item of chatItems) {
      chatItemMap.set((item._id as { toString(): string }).toString(), item as Record<string, unknown>);
    }

    await sendProgress(userId, websocketEndpoint, exportJobId, planId, 'assembling', 40, 'Building document...');

    // Build markdown
    const imageArrays: string[][] = [];
    let markdown = '';

    // Title and metadata
    const totalSubQuests = plan.quests.reduce(
      (sum: number, q: { subQuests: unknown[] }) => sum + q.subQuests.length,
      0
    );
    const completedSubQuests = plan.quests.reduce(
      (sum: number, q: { subQuests: Array<{ status: string }> }) =>
        sum + q.subQuests.filter(sq => sq.status === 'completed').length,
      0
    );

    markdown += `# ${plan.goal}\n\n`;
    markdown += `> Exported from QuestMaster on ${dateStr}\n`;
    markdown += `> Status: ${plan.state} (${completedSubQuests}/${totalSubQuests} tasks)\n\n`;
    markdown += `---\n\n`;

    // Table of Contents
    markdown += `## Table of Contents\n\n`;
    let questNum = 0;
    for (const quest of plan.quests) {
      questNum++;
      markdown += `- Quest ${questNum}: ${quest.title}\n`;
      let subQuestNum = 0;
      for (const subQuest of quest.subQuests) {
        subQuestNum++;
        const statusIcon = getStatusIcon(subQuest.status);
        markdown += `  - ${questNum}.${subQuestNum}: ${subQuest.title}${statusIcon}\n`;
      }
    }
    markdown += `\n---\n\n`;

    // Quest sections
    questNum = 0;
    for (const quest of plan.quests) {
      questNum++;
      markdown += `## Quest ${questNum}: ${quest.title} — ${quest.complexity}\n\n`;
      markdown += `> ${quest.description}\n\n`;

      let subQuestNum = 0;
      for (const subQuest of quest.subQuests) {
        subQuestNum++;
        const statusIcon = getStatusIcon(subQuest.status);
        markdown += `### ${questNum}.${subQuestNum}: ${subQuest.title}${statusIcon}\n\n`;

        if (subQuest.status === 'not_started') {
          markdown += `_This task has not been started yet._\n\n`;
        } else if (subQuest.status === 'skipped') {
          markdown += `_This task was skipped._\n\n`;
        } else if (!subQuest.questId) {
          markdown += `_No linked response found._\n\n`;
        } else {
          const chatItem = chatItemMap.get(subQuest.questId);
          if (!chatItem) {
            markdown += `_Response content unavailable._\n\n`;
          } else {
            const reply = (chatItem.reply as string) || '';
            markdown += `${reply}\n\n`;

            // Collect images from this chat item
            const images = (chatItem.images as string[]) || [];
            if (images.length > 0) {
              imageArrays.push(images);
            }
          }
        }
      }

      markdown += `---\n\n`;
    }

    await sendProgress(userId, websocketEndpoint, exportJobId, planId, 'assembling', 60, 'Document assembled');

    // Phase 2: Download images
    const allImageUrls = extractImageUrls(markdown, imageArrays);
    const imageBuffers: Array<{ filename: string; buffer: Buffer }> = [];
    const urlToFilename = new Map<string, string>();

    if (allImageUrls.length > 0) {
      await sendProgress(
        userId,
        websocketEndpoint,
        exportJobId,
        planId,
        'downloading_images',
        65,
        `Downloading ${allImageUrls.length} images...`
      );

      let figNum = 0;
      for (const url of allImageUrls) {
        figNum++;
        const ext = getExtensionFromUrl(url);
        const filename = `images/fig-${figNum}${ext}`;
        urlToFilename.set(url, filename);

        try {
          const { storage } = getStorageForUrl(url);
          const key = extractS3Key(url);

          // A held/blocked uploaded image must not be included in the export zip. Look up
          // a matching FabFile by the extracted storage key; if it exists and isn't
          // serveable yet, skip it via the same breadcrumb path as a download failure below.
          // Fail-closed on lookup error (skip) - no FabFile match (external/generated image
          // URL) falls through unaffected.
          let fabFile;
          try {
            fabFile = await FabFile.findOne({ filePath: key });
          } catch {
            throw new Error('Failed to verify image moderation status');
          }
          if (fabFile && !isImageServeable(fabFile)) {
            throw new Error('Image is pending moderation review and is not available');
          }

          const buffer = await storage.download(key);
          imageBuffers.push({ filename, buffer });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error';
          logger.warn(`Failed to download image ${url}: ${errorMsg}`);
          // Replace with breadcrumb in markdown
          const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const breadcrumb = `> ⚠️ Image unavailable: ${path.basename(extractS3Key(url))}. Reason: ${errorMsg}.\n\n`;

          // Replace all references to this URL with the breadcrumb
          markdown = markdown.replace(new RegExp(`!\\[[^\\]]*\\]\\(${escapedUrl}\\)`, 'g'), breadcrumb);
          markdown = markdown.replace(new RegExp(`<img[^>]+src=["']${escapedUrl}["'][^>]*>`, 'gi'), breadcrumb);
          // Remove from the filename map since download failed
          urlToFilename.delete(url);
        }

        // Update progress
        const imgProgress = 65 + Math.round((figNum / allImageUrls.length) * 15);
        if (figNum % 5 === 0 || figNum === allImageUrls.length) {
          await sendProgress(
            userId,
            websocketEndpoint,
            exportJobId,
            planId,
            'downloading_images',
            imgProgress,
            `Downloaded ${figNum}/${allImageUrls.length} images`
          );
        }
      }

      // Replace URLs with relative paths in markdown
      for (const [url, filename] of urlToFilename.entries()) {
        const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        markdown = markdown.replace(new RegExp(escapedUrl, 'g'), filename);
      }
    }

    // Phase 3: Generate Summary
    await sendProgress(
      userId,
      websocketEndpoint,
      exportJobId,
      planId,
      'summarizing',
      82,
      'Generating executive summary...'
    );

    const summary = await generateSummary(markdown, plan.goal, logger, userId);
    if (summary) {
      logger.info('Executive summary generated successfully');
    } else {
      logger.info('Skipping executive summary (generation failed or unavailable)');
    }

    // Phase 4: Create ZIP
    await sendProgress(userId, websocketEndpoint, exportJobId, planId, 'zipping', 88, 'Creating ZIP archive...');

    const zipBuffer = await createZipBuffer(markdown, imageBuffers, `${slug}.md`, summary);

    await sendProgress(userId, websocketEndpoint, exportJobId, planId, 'zipping', 90, 'Uploading ZIP...');
    await appFiles.upload(zipBuffer, finalZipKey, { ContentType: 'application/zip' });

    // Generate presigned download URL (1 hour expiry)
    const filename = `questmaster-${slug}-${dateStr}.zip`;
    const downloadUrl = await appFiles.getSignedUrl(finalZipKey, 'get', {
      expiresIn: 3600,
      ResponseContentDisposition: `attachment; filename="${filename}"`,
    });

    // Phase 4: Complete
    await sendProgress(userId, websocketEndpoint, exportJobId, planId, 'completed', 100, 'Export complete!', {
      downloadUrl,
      filename,
    });

    logger.info(
      `Quest export completed: ${finalZipKey} (${imageBuffers.length} images, summary: ${summary ? 'yes' : 'no'})`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Quest export failed for plan ${planId}:`, error);

    await sendProgress(userId, websocketEndpoint, exportJobId, planId, 'failed', 0, undefined, { errorMessage });

    throw error;
  }
});
