import { withEventContext } from '@server/events/utils';
import { SpiderEvents, SessionEvents, NotebookCurationEvents } from '@server/utils/eventBus';
import { sessionRepository } from '@bike4mind/database/auth';
import { Quest } from '@bike4mind/database/content';
import { apiKeyRepository, adminSettingsRepository } from '@bike4mind/database';
import { sendToClient } from '@server/websocket/utils';
import { v4 as uuidv4 } from 'uuid';
import { Resource } from 'sst';
import { getSettingsByNames } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { EmbeddingFactory, getProviderFromModel } from '@bike4mind/fab-pipeline';
import crypto from 'crypto';
import {
  ISessionDocument,
  ISpiderProgressUpdateAction,
  ISpiderCompleteAction,
  ISpiderErrorAction,
  isSupportedEmbeddingModel,
  SupportedEmbeddingModel,
} from '@bike4mind/common';
import { apiKeyService } from '@bike4mind/services';

/**
 * Tuned to prevent MongoDB connection saturation.
 * Reduced from 10/500ms after production testing showed connection issues.
 */
const RATE_LIMIT_CONFIG = {
  BATCH_SIZE: 5,
  // Delay between batches, in ms - lets MongoDB connections settle
  BATCH_DELAY_MS: 1000,
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export type SpiderOperation = 'messageCount' | 'curation' | 'summarize' | 'tags' | 'embeddings';

export interface SpiderJobConfig {
  spiderJobId: string;
  userId: string;
  totalNotebooks: number;
  operations: SpiderOperation[];
  dryRun?: boolean;
}

export interface SpiderStats {
  messageCountsUpdated: number;
  notebooksCurated: number;
  notebooksSummarized: number;
  notebooksTagged: number;
  messagesEmbedded: number;
  errors: number;
  skipped: number;
}

export interface SessionGroomingResult {
  sessionId: string;
  sessionName: string;
  operations: {
    messageCount: boolean;
    curation: boolean;
    summarize: boolean;
    tags: boolean;
    embeddings: boolean;
  };
  messagesEmbedded?: number;
  skipped: boolean;
  error?: string;
}

export interface EmbeddingService {
  generateEmbedding: (text: string) => Promise<number[]>;
}

/** Dependency-injection interface; allows mocking in tests. */
export interface SpiderDependencies {
  sessionRepository: typeof sessionRepository;
  publishCuration: typeof NotebookCurationEvents.Start.publish;
  publishSummarize: typeof SessionEvents.Summarize.publish;
  publishTag: typeof SessionEvents.Tag.publish;
  sendProgress: (data: ISpiderProgressUpdateAction) => Promise<void>;
  logger: Logger;
  embeddingService?: EmbeddingService;
  embeddingModel?: string;
}

/**
 * Pure function, no side effects.
 * Embeddings always run when requested (checked per-message, not per-session).
 */
export function determineSessionOperations(
  session: ISessionDocument,
  requestedOperations: SpiderOperation[]
): SessionGroomingResult['operations'] {
  return {
    messageCount: requestedOperations.includes('messageCount'),
    curation: requestedOperations.includes('curation') && !session.curatedAt,
    summarize: requestedOperations.includes('summarize') && !session.summaryAt,
    tags: requestedOperations.includes('tags') && !session.taggedAt,
    embeddings: requestedOperations.includes('embeddings'), // Always run when requested (per-message check)
  };
}

export function hasOperationsToPerform(operations: SessionGroomingResult['operations']): boolean {
  return Object.values(operations).some(Boolean);
}

async function generateEmbeddingsForSession(
  sessionId: string,
  embeddingService: EmbeddingService,
  embeddingModel: string,
  logger: Logger
): Promise<number> {
  // Find messages in session without embeddings
  const messages = await Quest.find(
    {
      sessionId,
      $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
      'embedding.generatedAt': { $exists: false },
    },
    { _id: 1, prompt: 1, reply: 1 }
  ).lean();

  if (messages.length === 0) {
    return 0;
  }

  logger.debug(`Found ${messages.length} messages without embeddings in session ${sessionId}`);

  let embeddedCount = 0;
  const MAX_CHARS = 30000; // ~7500 tokens for OpenAI ada-002

  for (const message of messages) {
    try {
      let content = [message.prompt, message.reply].filter(Boolean).join('\n\n');

      if (!content || content.trim().length === 0) {
        continue;
      }

      if (content.length > MAX_CHARS) {
        content = content.substring(0, MAX_CHARS) + '...';
      }

      // Hash to detect content changes on future runs
      const contentHash = crypto.createHash('md5').update(content).digest('hex');

      const vector = await embeddingService.generateEmbedding(content);

      await Quest.updateOne(
        { _id: message._id },
        {
          $set: {
            embedding: {
              vector,
              model: embeddingModel,
              generatedAt: new Date(),
              contentHash,
            },
          },
        }
      );

      embeddedCount++;
    } catch (error) {
      logger.warn(`Failed to generate embedding for message ${message._id}:`, error);
    }
  }

  return embeddedCount;
}

interface PendingEvent {
  type: 'curation' | 'summarize' | 'tag';
  sessionId: string;
  sessionName: string;
  payload: Record<string, unknown>;
}

/** Collects events and publishes them in batches with delays, to avoid MongoDB connection saturation. */
export class RateLimitedEventPublisher {
  private pendingEvents: PendingEvent[] = [];
  private publishedCount = 0;

  constructor(
    private deps: SpiderDependencies,
    private config: SpiderJobConfig
  ) {}

  /** Validates that sessionId is present to prevent ZodError on publish. */
  queue(event: PendingEvent): void {
    if (!event.sessionId) {
      this.deps.logger.error(`Cannot queue ${event.type} event: sessionId is null/undefined`);
      return;
    }
    this.pendingEvents.push(event);
  }

  get queuedCount(): number {
    return this.pendingEvents.length;
  }

  get published(): number {
    return this.publishedCount;
  }

  async publishAll(): Promise<{ curation: number; summarize: number; tag: number; errors: number }> {
    const stats = { curation: 0, summarize: 0, tag: 0, errors: 0 };

    if (this.pendingEvents.length === 0) {
      return stats;
    }

    this.deps.logger.info(
      `Starting rate-limited publishing of ${this.pendingEvents.length} events (batch size: ${RATE_LIMIT_CONFIG.BATCH_SIZE}, delay: ${RATE_LIMIT_CONFIG.BATCH_DELAY_MS}ms)`
    );

    for (let i = 0; i < this.pendingEvents.length; i += RATE_LIMIT_CONFIG.BATCH_SIZE) {
      const batch = this.pendingEvents.slice(i, i + RATE_LIMIT_CONFIG.BATCH_SIZE);

      // Parallelism within a batch is fine; the delay between batches is what limits the rate
      const batchResults = await Promise.allSettled(
        batch.map(async event => {
          try {
            switch (event.type) {
              case 'curation':
                await this.deps.publishCuration(event.payload as Parameters<typeof this.deps.publishCuration>[0]);
                break;
              case 'summarize':
                await this.deps.publishSummarize(event.payload as Parameters<typeof this.deps.publishSummarize>[0]);
                break;
              case 'tag':
                await this.deps.publishTag(event.payload as Parameters<typeof this.deps.publishTag>[0]);
                break;
            }
            // Increment stats only after successful publish
            if (event.type === 'curation') {
              stats.curation++;
            } else if (event.type === 'summarize') {
              stats.summarize++;
            } else if (event.type === 'tag') {
              stats.tag++;
            }
            this.publishedCount++;
          } catch (error) {
            this.deps.logger.error(`Failed to publish ${event.type} event for session ${event.sessionId}:`, error);
            stats.errors++;
            throw error;
          }
        })
      );

      const succeeded = batchResults.filter(r => r.status === 'fulfilled').length;
      const failed = batchResults.filter(r => r.status === 'rejected').length;
      this.deps.logger.debug(
        `Published batch ${Math.floor(i / RATE_LIMIT_CONFIG.BATCH_SIZE) + 1}: ${succeeded} succeeded, ${failed} failed`
      );

      // Send progress update - use publishedCount to accurately reflect events published
      await this.deps.sendProgress({
        action: 'spider_progress',
        spiderJobId: this.config.spiderJobId,
        notebooksProcessed: this.publishedCount,
        totalNotebooks: this.config.totalNotebooks,
        currentOperation: `Publishing events (${this.publishedCount}/${this.pendingEvents.length})`,
        dryRun: this.config.dryRun,
      });

      // Delay between batches to allow Lambda invocations to spread out
      if (i + RATE_LIMIT_CONFIG.BATCH_SIZE < this.pendingEvents.length) {
        await sleep(RATE_LIMIT_CONFIG.BATCH_DELAY_MS);
      }
    }

    this.deps.logger.info(
      `Completed publishing: ${stats.curation} curation, ${stats.summarize} summarize, ${stats.tag} tag events (${stats.errors} errors)`
    );

    return stats;
  }
}

/**
 * Extracted for testability. Returns what operations were performed (or would be, in dry-run).
 *
 * When eventPublisher is provided, events are queued for rate-limited publishing instead of
 * published immediately, to prevent MongoDB connection saturation.
 */
export async function processSession(
  session: ISessionDocument,
  config: SpiderJobConfig,
  deps: SpiderDependencies,
  eventPublisher?: RateLimitedEventPublisher
): Promise<SessionGroomingResult> {
  if (!session.id) {
    deps.logger.error(`Session missing id field, skipping. Session name: ${session.name || 'Unknown'}`);
    return {
      sessionId: 'unknown',
      sessionName: session.name || 'Unknown',
      operations: { messageCount: false, curation: false, summarize: false, tags: false, embeddings: false },
      skipped: true,
      error: 'Session missing id field',
    };
  }

  const operations = determineSessionOperations(session, config.operations);
  const result: SessionGroomingResult = {
    sessionId: session.id,
    sessionName: session.name || 'Untitled',
    operations,
    skipped: !hasOperationsToPerform(operations),
  };

  if (result.skipped) {
    return result;
  }

  // In dry-run mode, just return what would be done
  if (config.dryRun) {
    return result;
  }

  try {
    // 1. Message Count - always recalculate if requested (synchronous, no event)
    if (operations.messageCount) {
      await deps.sessionRepository.populateMessageCounts([session]);
    }

    // 2. Curation - trigger if never curated
    if (operations.curation) {
      const curationJobId = uuidv4();
      const payload = {
        sessionId: session.id,
        userId: config.userId,
        curationJobId,
        curationType: 'transcript' as const,
        exportFormat: 'markdown' as const,
      };

      if (eventPublisher) {
        eventPublisher.queue({
          type: 'curation',
          sessionId: session.id,
          sessionName: session.name || 'Untitled',
          payload,
        });
      } else {
        await deps.publishCuration(payload);
        deps.logger.info(`Triggered curation for session ${session.id} (${session.name})`);
      }
    }

    // 3. Summarization - trigger if never summarized
    if (operations.summarize) {
      const payload = {
        sessionId: session.id,
        userId: config.userId,
        trigger: 'manual' as const,
      };

      if (eventPublisher) {
        eventPublisher.queue({
          type: 'summarize',
          sessionId: session.id,
          sessionName: session.name || 'Untitled',
          payload,
        });
      } else {
        await deps.publishSummarize(payload);
        deps.logger.info(`Triggered summarization for session ${session.id} (${session.name})`);
      }
    }

    // 4. Tagging - trigger if never tagged
    if (operations.tags) {
      const payload = {
        sessionId: session.id,
        userId: config.userId,
      };

      if (eventPublisher) {
        eventPublisher.queue({
          type: 'tag',
          sessionId: session.id,
          sessionName: session.name || 'Untitled',
          payload,
        });
      } else {
        await deps.publishTag(payload);
        deps.logger.info(`Triggered tagging for session ${session.id} (${session.name})`);
      }
    }

    // 5. Embeddings - generate embeddings for messages without them (synchronous, no event)
    if (operations.embeddings && deps.embeddingService && deps.embeddingModel) {
      const embeddedCount = await generateEmbeddingsForSession(
        session.id,
        deps.embeddingService,
        deps.embeddingModel,
        deps.logger
      );
      result.messagesEmbedded = embeddedCount;
      if (embeddedCount > 0) {
        deps.logger.info(`Generated ${embeddedCount} embeddings for session ${session.id} (${session.name})`);
      }
    }

    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    return result;
  }
}

/**
 * Core business logic, extracted for testability.
 * Phase 1: scan sessions and queue events. Phase 2: publish queued events with rate limiting
 * to prevent MongoDB saturation.
 */
export async function processAllSessions(
  sessions: ISessionDocument[],
  config: SpiderJobConfig,
  deps: SpiderDependencies,
  batchSize = 50
): Promise<{ stats: SpiderStats; results: SessionGroomingResult[] }> {
  const stats: SpiderStats = {
    messageCountsUpdated: 0,
    notebooksCurated: 0,
    notebooksSummarized: 0,
    notebooksTagged: 0,
    messagesEmbedded: 0,
    errors: 0,
    skipped: 0,
  };

  const results: SessionGroomingResult[] = [];
  let notebooksProcessed = 0;

  // Only used in non-dry-run mode
  const eventPublisher = config.dryRun ? undefined : new RateLimitedEventPublisher(deps, config);

  deps.logger.info(`Phase 1: Scanning ${sessions.length} sessions and queueing events...`);

  for (let i = 0; i < sessions.length; i += batchSize) {
    const batch = sessions.slice(i, i + batchSize);

    for (const session of batch) {
      try {
        const result = await processSession(session, config, deps, eventPublisher);
        results.push(result);

        if (result.error) {
          stats.errors++;
          deps.logger.error(`Error processing session ${session.id}:`, result.error);
        } else if (result.skipped) {
          stats.skipped++;
        } else {
          // Count operations that will be performed (queued or already done)
          if (result.operations.messageCount) stats.messageCountsUpdated++;
          if (result.operations.curation) stats.notebooksCurated++;
          if (result.operations.summarize) stats.notebooksSummarized++;
          if (result.operations.tags) stats.notebooksTagged++;
          if (result.messagesEmbedded) stats.messagesEmbedded += result.messagesEmbedded;
        }

        notebooksProcessed++;

        // Send WebSocket progress every 10 notebooks
        if (notebooksProcessed % 10 === 0) {
          await deps.sendProgress({
            action: 'spider_progress',
            spiderJobId: config.spiderJobId,
            notebooksProcessed,
            totalNotebooks: config.totalNotebooks,
            currentOperation: `Scanning sessions (${eventPublisher?.queuedCount || 0} events queued)`,
            currentNotebookId: session.id,
            currentNotebookName: session.name,
            dryRun: config.dryRun,
          });
        }
      } catch (error) {
        stats.errors++;
        deps.logger.error(`Error processing session ${session.id}:`, error);
        results.push({
          sessionId: session.id,
          sessionName: session.name || 'Untitled',
          operations: { messageCount: false, curation: false, summarize: false, tags: false, embeddings: false },
          skipped: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    // Send WebSocket progress after each batch
    await deps.sendProgress({
      action: 'spider_progress',
      spiderJobId: config.spiderJobId,
      notebooksProcessed,
      totalNotebooks: config.totalNotebooks,
      currentOperation: `Scanned batch ${Math.floor(i / batchSize) + 1} (${eventPublisher?.queuedCount || 0} events queued)`,
      dryRun: config.dryRun,
    });
  }

  // Phase 2: Publish queued events with rate limiting (only in non-dry-run mode)
  if (eventPublisher && eventPublisher.queuedCount > 0) {
    deps.logger.info(`Phase 2: Publishing ${eventPublisher.queuedCount} queued events with rate limiting...`);

    await deps.sendProgress({
      action: 'spider_progress',
      spiderJobId: config.spiderJobId,
      notebooksProcessed: sessions.length,
      totalNotebooks: config.totalNotebooks,
      currentOperation: `Publishing ${eventPublisher.queuedCount} events with rate limiting...`,
      dryRun: config.dryRun,
    });

    const publishStats = await eventPublisher.publishAll();

    stats.errors += publishStats.errors;

    deps.logger.info(
      `Phase 2 complete: Published ${publishStats.curation + publishStats.summarize + publishStats.tag} events`
    );
  }

  return { stats, results };
}

/**
 * Walks all notebooks and grooms them: message counts, curation, summarization, tagging.
 * Supports dry-run mode; publishes progress via WebSocket for the UI.
 */
export const handler = withEventContext(async (event, logger) => {
  const {
    spiderJobId,
    userId,
    totalNotebooks,
    operations,
    dryRun = false,
  } = SpiderEvents.Start.schema.parse(event.properties);

  const config: SpiderJobConfig = {
    spiderJobId,
    userId,
    totalNotebooks,
    operations: operations as SpiderOperation[],
    dryRun,
  };

  logger.updateMetadata({
    spiderJobId,
    userId,
    totalNotebooks,
    operations: operations.join(','),
    dryRun,
  });
  logger.info(
    `Starting Spider job ${spiderJobId} for ${totalNotebooks} notebooks with operations: ${operations.join(', ')}${dryRun ? ' (DRY RUN)' : ''}`
  );

  const websocketEndpoint = Resource.websocket?.managementEndpoint;

  const deps: SpiderDependencies = {
    sessionRepository,
    publishCuration: NotebookCurationEvents.Start.publish.bind(NotebookCurationEvents.Start),
    publishSummarize: SessionEvents.Summarize.publish.bind(SessionEvents.Summarize),
    publishTag: SessionEvents.Tag.publish.bind(SessionEvents.Tag),
    sendProgress: async (data: ISpiderProgressUpdateAction) => {
      await sendToClient(userId, websocketEndpoint, data);
    },
    logger,
  };

  // Set up embedding service if embeddings operation is requested
  if (operations.includes('embeddings') && !dryRun) {
    try {
      logger.info('Setting up embedding service for embeddings operation');

      const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(
        userId,
        {
          db: {
            apiKeys: apiKeyRepository,
            adminSettings: adminSettingsRepository,
          },
          getSettingsByNames,
        },
        { logger }
      );

      // Get embedding model from admin settings
      const defaultEmbeddingModel = await adminSettingsRepository.getSettingsValue('defaultEmbeddingModel');

      if (defaultEmbeddingModel && isSupportedEmbeddingModel(defaultEmbeddingModel)) {
        const embeddingModel = defaultEmbeddingModel as SupportedEmbeddingModel;
        const requiredProvider = getProviderFromModel(embeddingModel);

        const embeddingConfig: {
          openaiApiKey?: string | null;
          voyageApiKey?: string | null;
          ollamaBaseUrl?: string | null;
        } = {};

        if (requiredProvider === 'openai' && apiKeyTable?.openai) {
          embeddingConfig.openaiApiKey = apiKeyTable.openai;
        } else if (requiredProvider === 'voyageai' && apiKeyTable?.voyageai) {
          embeddingConfig.voyageApiKey = apiKeyTable.voyageai;
        } else if (requiredProvider === 'ollama' && apiKeyTable?.ollama) {
          // apiKeyTable.ollama carries the Ollama base URL (no secret) in self-host.
          embeddingConfig.ollamaBaseUrl = apiKeyTable.ollama;
        }

        if (embeddingConfig.openaiApiKey || embeddingConfig.voyageApiKey || embeddingConfig.ollamaBaseUrl) {
          const embeddingFactory = new EmbeddingFactory(embeddingConfig);
          deps.embeddingService = embeddingFactory.createEmbeddingService(embeddingModel);
          deps.embeddingModel = embeddingModel;
          logger.info(`Embedding service configured with model: ${embeddingModel}`);
        } else {
          logger.warn(
            `Embedding operation requested but no API key available for provider: ${requiredProvider}. Skipping embeddings.`
          );
        }
      } else {
        logger.warn('Embedding operation requested but no valid embedding model configured. Skipping embeddings.');
      }
    } catch (error) {
      logger.error('Failed to set up embedding service:', error);
      // Continue without embeddings - don't fail the whole job
    }
  }

  try {
    const allSessions = await sessionRepository.find(
      {
        userId,
        $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
      },
      {
        sort: { lastUpdated: -1 },
      }
    );

    logger.info(`Found ${allSessions.length} sessions to process`);

    const { stats, results } = await processAllSessions(allSessions, config, deps);

    if (dryRun) {
      const preview = {
        wouldUpdate: stats.messageCountsUpdated,
        wouldCurate: stats.notebooksCurated,
        wouldSummarize: stats.notebooksSummarized,
        wouldTag: stats.notebooksTagged,
        wouldEmbed: stats.messagesEmbedded,
        wouldSkip: stats.skipped,
        sampleResults: results.slice(0, 10).map(r => ({
          name: r.sessionName,
          operations: r.operations,
          skipped: r.skipped,
        })),
      };
      logger.info(`DRY RUN PREVIEW:`, preview);
    }

    const completeAction: ISpiderCompleteAction = {
      action: 'spider_complete',
      spiderJobId,
      totalNotebooks,
      stats,
      dryRun,
    };
    await sendToClient(userId, websocketEndpoint, completeAction);

    logger.info(`Spider job ${spiderJobId} completed successfully${dryRun ? ' (DRY RUN)' : ''}:`, stats);
  } catch (error) {
    logger.error(`Spider job ${spiderJobId} failed:`, error);

    const errorAction: ISpiderErrorAction = {
      action: 'spider_error',
      spiderJobId,
      error: error instanceof Error ? error.message : 'Unknown error',
      totalNotebooks,
      dryRun,
    };
    await sendToClient(userId, websocketEndpoint, errorAction);

    throw error;
  }
});
