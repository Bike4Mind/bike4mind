import {
  IFabFileRepository,
  IMessage,
  IResearchDataRepository,
  IResearchTaskJobs,
  IResearchTaskRepository,
  ResearchTaskStatus,
  ResearchTaskType,
} from '@bike4mind/common';
import { NotFoundError, secureParameters, UnprocessableEntityError, FunctionQueueRunner } from '@bike4mind/utils';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import { createSendStatusUpdate } from './utils';
import axios from 'axios';
import { z } from 'zod';
import plimit from 'p-limit';
import pLimit from 'p-limit';

const researchTaskProcessDiscoveredLinksSchema = z.object({
  id: z.string(),
});

type IResearchTaskProcessDiscoveredLinks = z.infer<typeof researchTaskProcessDiscoveredLinksSchema>;

interface IResearchTaskProcessDiscoveredLinksAdapters {
  db: {
    withTransaction: (fn: (session: any) => Promise<void>) => Promise<void>;
    researchTasks: IResearchTaskRepository;
    fabFiles: IFabFileRepository;
    researchDatas: IResearchDataRepository;
  };
  logger?: {
    info: (message: string) => void;
    error: (message: string) => void;
    warn: (message: string) => void;
  };
  llm: ICompletionBackend;
  jobs: {
    researchTasks: IResearchTaskJobs & {
      sendToClient: (
        researchTask: any,
        update: { status: string; currentStep: string; progress: number }
      ) => Promise<void>;
    };
  };
}

// TODO: move BATCH_SIZE / CONCURRENCY_LIMIT to admin settings so they're adjustable.
const BATCH_SIZE = 50;
const CONCURRENCY_LIMIT = 3;

export const processDiscoveredLinks = async (
  parameters: IResearchTaskProcessDiscoveredLinks,
  adapters: IResearchTaskProcessDiscoveredLinksAdapters
) => {
  const { db, logger, llm, jobs } = adapters;
  const { id } = secureParameters(parameters, researchTaskProcessDiscoveredLinksSchema);

  const researchTask = await db.researchTasks.findById(id);

  if (!researchTask) throw new NotFoundError(`Research Task Process Discovered Links - Research Task ${id} not found`);

  if (researchTask.type !== ResearchTaskType.SCRAPE)
    throw new UnprocessableEntityError(`Research Task Process Discovered Links`);

  logger?.info(`🔍 [PROCESS_DISCOVERED_LINKS] Processing ${researchTask.urls.length} URLs`);

  const queueRunner = new FunctionQueueRunner(2000);
  const { sendToClient } = jobs.researchTasks || {};

  const currentProgressTracker = { value: 0 };
  const sendStatusUpdate = createSendStatusUpdate(researchTask, queueRunner, sendToClient, logger, {
    baseProgress: 41,
    maxProgress: 70, // Process discovered links phase: 41-70%
    currentProgress: currentProgressTracker,
  });

  const totalPendingLinks = researchTask.discoveredLinks?.filter(l => l.status === 'pending').length || 0;

  const processLinks = async (url: string, urlIndex: number) => {
    const links = researchTask.discoveredLinks?.filter(l => l.status === 'pending' && l.sourceUrl === url);

    if (!links || links.length === 0) return;

    const researchData = researchTask.organizationId
      ? await db.researchDatas.findByUrlAndOrganizationId(url, researchTask.organizationId)
      : await db.researchDatas.findByUrlAndUserId(url, researchTask.userId);

    if (!researchData)
      throw new NotFoundError(
        `Research Task Process Discovered Links - Research Data for ${url} not found for task ${researchTask.id}`
      );

    const fabFile = await db.fabFiles.findById(researchData.fabFileId);

    if (!fabFile)
      throw new NotFoundError(`Research Task Process Discovered Links - Fab File ${researchData.fabFileId} not found`);
    if (!fabFile.fileUrl)
      throw new UnprocessableEntityError(
        `Research Task Process Discovered Links - Fab File ${fabFile.id} has no file url`
      );

    let content: string;
    try {
      const response = await axios.get(fabFile.fileUrl);
      content = response.data;
    } catch (error) {
      throw new UnprocessableEntityError(
        `Research Task Process Discovered Links - Failed to get content from Fab File ${fabFile.id} at ${fabFile.fileUrl}`
      );
    }
    const { prompt } = researchTask;

    await sendStatusUpdate(
      `🔍 [${urlIndex}/${researchTask.urls.length}] Analyzing ${url} - ${links.length} discovered links...`,
      3
    );

    const batches = [];
    const uniqueLinks = Array.from(new Set(links));
    for (let i = 0; i < uniqueLinks.length; i += BATCH_SIZE) {
      batches.push(uniqueLinks.slice(i, i + BATCH_SIZE));
    }

    const concurrencyLimit = plimit(CONCURRENCY_LIMIT);
    const stats = {
      updated: 0,
      failed: 0,
    };

    const batchStats = {
      processing: 0,
      completed: 0,
      failed: 0,
    };

    await sendStatusUpdate(
      `🧠 [${urlIndex}/${researchTask.urls.length}] Tracking batch process - Pending: ${batches.length}, Processing: ${batchStats.processing}, Completed: ${batchStats.completed}, Failed: ${batchStats.failed}`,
      0
    );

    await Promise.allSettled(
      batches.map((batch, batchIndex) =>
        concurrencyLimit(async () => {
          const index = batchIndex + 1;
          logger?.info(`** RUNNING BATCH ${index}/${batches.length}**`);

          batchStats.processing += 1;

          sendStatusUpdate(
            `🧠 [${urlIndex}/${researchTask.urls.length}] Tracking batch process - Pending: ${
              batches.length - batchStats.processing - batchStats.failed
            }, Processing: ${batchStats.processing}, Completed: ${batchStats.completed}, Failed: ${batchStats.failed}`,
            Math.floor(10 / totalPendingLinks / batches.length)
          );

          let retry = 0;
          while (retry < 2) {
            try {
              const linkExtractionPrompt: IMessage[] = [
                {
                  role: 'user',
                  content: `Below you will find a markdown content and a list of links that were extracted from it. Analyze these links in the context of the markdown content's main topic and the user's prompt. This may or may not be related to the current task.

        CRITICAL: You MUST process ALL links provided in the Input Links section. Each link MUST have an entry in the output.

        First, analyze the main context and themes of the markdown content:
        1. Identify the primary topic/subject matter
        2. Extract key themes, concepts, and focus areas
        3. Understand the content's purpose and target audience
        4. Note any specific methodologies, technologies, or frameworks mentioned

        Then, for each link in the Input Links array (${batch.length} total links), provide:
        1. Generate a descriptive text value for the URL that:
           - Uses the surrounding markdown context where the URL appears
           - Describes the relationship between the URL and the content's main themes
           - If no context is available, extract meaning from the URL itself (e.g., file name, path structure)
           - Keep descriptions concise but informative (max 10 words)
        2. A relevance score (0-1) based on:
           - How well it relates to the user's specific prompt and intent (0.4)
           - How well it aligns with the content's main topic and themes (0.3)
           - The depth and quality of information it likely provides (0.2)  
           - The credibility of the source (0.1)
           - If context is unclear or unrelated to main themes, default to 0.1
        3. The expected MIME type based on URL extension or structure
           - Default to "text/html" for web pages
           - Use appropriate MIME types for files (pdf, doc, etc.)
        4. Whether it's a downloadable file (true for PDFs, DOCs, etc.; false for web pages)
        5. Whether you recommend following this link (true/false)
           - Recommend if it enhances understanding of the main context or user prompt
           - Consider if it provides valuable supplementary information
           - Contact links like email addresses and social media share links are not recommended
           - Links with relevance score 0.5 and below are generally not recommended
           - Prioritize links that directly support the content's main themes

        IMPORTANT: Your response MUST:
        - Include EXACTLY ${batch.length} items in the array
        - Process EVERY link from the Input Links array
        - Return ONLY the JSON array with no additional text:
        IE.
        [
          {
            "url": "https://example.com",
            "text": "Example",
            "relevance": 0.5,
            "fileType": "text/markdown",
            "isDownloadable": true,
            "isRecommended": true
          }
        ]

        User Prompt (analyze this to understand user intent):
        ${prompt || 'No specific prompt provided - analyze based on content themes'}

        Markdown Content (identify main context and themes):
        ${content}

        Input Links:
        ${JSON.stringify(batch, null, 2)}
`,
                },
              ];

              let extractedLinks: string = '';
              await llm.complete(
                llm.currentModel,
                linkExtractionPrompt,
                { stream: false, temperature: 0.2, topP: 0.1, maxTokens: Infinity },
                async text => {
                  if (text && text[0]) {
                    extractedLinks = text[0];
                  }
                }
              );

              let result: {
                url: string;
                text: string;
                relevance: number;
                fileType: string;
                isDownloadable: boolean;
                isRecommended: boolean;
              }[] = [];
              try {
                result = JSON.parse(extractedLinks);
                logger?.info(`***TOTAL LINKS EXTRACTED: ${result.length}/${batch.length}***`);
              } catch {
                try {
                  const matches = extractedLinks.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                  if (!matches?.[1]) throw new Error('No JSON content found in code block');
                  result = JSON.parse(matches[1].trim());

                  logger?.info(`***TOTAL LINKS EXTRACTED: ${result.length}/${batch.length}***`);
                } catch {
                  throw new Error(`Failed to parse extracted links for batch ${index}/${batches.length}`);
                }
              }

              result.forEach(l => {
                const existingLink = researchTask.discoveredLinks?.find(ll => ll.url === l.url);
                if (existingLink) {
                  existingLink.status = 'completed';
                  existingLink.text = l.text;
                  existingLink.relevance = l.relevance;
                  existingLink.fileType = l.fileType;
                  existingLink.isDownloadable = l.isDownloadable;
                  existingLink.isRecommended = l.isRecommended;
                }
              });

              stats.updated += result.length;

              batchStats.completed += 1;

              break;
            } catch (e) {
              retry += 1;
              logger?.info(`RETRY: Failed to extract links for batch ${index}/${batches.length}`);

              if (retry === 2) {
                logger?.info(`Failed to extract links for batch ${index}/${batches.length}: ${(e as Error).message}`);

                batch.forEach(b => {
                  const existingLink = researchTask.discoveredLinks?.find(ll => ll.url === b.url);
                  if (existingLink) {
                    existingLink.status = 'failed';
                  }
                });

                stats.failed += batch.length;
                batchStats.failed += 1;

                logger?.warn(
                  `Failed to extract links for batch ${index}/${
                    batches.length
                  } - Timestamp: ${new Date().toISOString()}`
                );
              }

              const backoffDelay = Math.pow(2, retry - 1) * 1000;
              await new Promise(resolve => setTimeout(resolve, backoffDelay));
            }
          }

          batchStats.processing -= 1;

          sendStatusUpdate(
            `🧠 [${urlIndex}/${researchTask.urls.length}] Tracking batch process - Pending: ${
              batches.length - (batchStats.processing + batchStats.failed + batchStats.completed)
            }, Processing: ${batchStats.processing}, Completed: ${batchStats.completed}, Failed: ${batchStats.failed}`,
            Math.floor(10 / totalPendingLinks / batches.length)
          );
        })
      )
    );

    logger?.info(`***OVERALL TOTAL LINKS EXTRACTED: ${stats.updated}/${links.length}***`);
    if (stats.failed > 0) {
      logger?.warn(`***OVERALL TOTAL LINKS FAILED: ${stats.failed}/${links.length}***`);
    }

    await sendStatusUpdate(
      `✅ [${urlIndex}/${researchTask.urls.length}] Completed processing ${stats.updated} links`,
      10
    );
  };

  const sequencial = pLimit(1);

  try {
    await Promise.all(
      researchTask.urls.map((url, index) =>
        sequencial(async () => {
          await processLinks(url, index + 1);
        })
      )
    );
    await queueRunner.close();

    logger?.info(`🔍 [PROCESS_DISCOVERED_LINKS] Updating research task ${id}`);
    await db.researchTasks.update(researchTask);

    await jobs.researchTasks.downloadRelevantLinks(id, researchTask.userId);
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof UnprocessableEntityError) {
      researchTask.status = ResearchTaskStatus.FAILED;
      researchTask.statusFailedMessage = e.message;
      researchTask.statusFailedAt = new Date();
      db.researchTasks.update(researchTask);
    } else {
      throw e;
    }
  }
};
