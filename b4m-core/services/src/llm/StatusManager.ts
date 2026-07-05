import {
  IChatHistoryItemDocument,
  PartialExcept,
  StreamedChatCompletionAction,
  StreamedRapidReplyAction,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { ClientMessageSender } from '@bike4mind/utils';
import { z } from 'zod';
import throttle from 'lodash/throttle.js';

interface StatusUpdateOptions {
  /** If true, the status message will not be sent to the client. */
  silent?: boolean;
  /** Skip throttling for immediate updates (like errors or completion) */
  immediate?: boolean;
  statusAt?: Date;
  skipPayloadOptimization?: boolean;
}

export class StatusManager {
  private clientMessageSender: ClientMessageSender;
  private logger: Logger;
  private wsHttpsUrl: string;
  private userId: string;

  // Throttled function for non-critical updates
  private throttledSend: ReturnType<typeof throttle>;

  // Track last sent payload to avoid redundant updates
  private lastSentPayload: string | null = null;

  constructor(clientMessageSender: ClientMessageSender, logger: Logger, wsHttpsUrl: string, userId: string) {
    this.clientMessageSender = clientMessageSender;
    this.logger = logger;
    this.wsHttpsUrl = wsHttpsUrl;
    this.userId = userId;

    // PERFORMANCE FIX: Use very aggressive throttling for streaming to prevent AWS throttling
    const throttleInterval = process.env.NODE_ENV === 'development' ? 5 : 50;
    this.logger.info(`🚀 [StatusManager] Using ${throttleInterval}ms throttling for ${process.env.NODE_ENV} mode`);

    this.throttledSend = throttle((quest: IChatHistoryItemDocument, status: string | null) => {
      return this.doSendStatusUpdate(quest, status);
    }, throttleInterval);
  }

  public async sendStatusUpdate(
    quest: PartialExcept<IChatHistoryItemDocument, 'id' | 'sessionId'>,
    status: string | null,
    options: StatusUpdateOptions = {}
  ): Promise<void> {
    const { silent = false, statusAt, skipPayloadOptimization } = options;
    if (!quest) return;
    if (status) {
      if (quest.promptMeta?.statusLog) {
        quest.promptMeta.statusLog.push({
          status,
          timestamp: statusAt ?? new Date(),
        });
      }
    }
    // If silent only capture status log without sending to the client
    if (silent) return;

    return this.doSendStatusUpdate(quest, status, skipPayloadOptimization);
  }

  private async doSendStatusUpdate(
    quest: PartialExcept<IChatHistoryItemDocument, 'id' | 'sessionId'>,
    status: string | null,
    skipPayloadOptimization?: boolean
  ): Promise<void> {
    try {
      // Create optimized payload with minimal data
      const payload = this.createOptimizedPayload(quest, status, skipPayloadOptimization);

      // Skip sending if payload is identical to last sent (avoid redundant WebSocket traffic)
      const payloadString = JSON.stringify(payload);
      if (payloadString === this.lastSentPayload) {
        return;
      }
      this.lastSentPayload = payloadString;

      // PERFORMANCE FIX: Add retry logic for AWS Lambda container issues
      let retryCount = 0;
      const maxRetries = 2;

      while (retryCount <= maxRetries) {
        try {
          await this.clientMessageSender.sendToClient(this.userId, this.wsHttpsUrl, payload);
          break; // Success, exit retry loop
        } catch (error) {
          retryCount++;
          if (retryCount > maxRetries) {
            throw error; // Re-throw after max retries
          }

          // Log retry attempt
          this.logger.warn(`⚠️ WebSocket send attempt ${retryCount} failed, retrying: ${error}`);

          // Brief delay before retry to handle AWS Lambda container issues
          await new Promise(resolve => setTimeout(resolve, 10 * retryCount));
        }
      }
    } catch (error) {
      this.logger.error('Error sending status update after retries:', error);
      // Don't throw - we want to continue processing even if status updates fail
    }
  }

  private createOptimizedPayload(
    quest: PartialExcept<IChatHistoryItemDocument, 'id' | 'sessionId'>,
    status: string | null,
    skipPayloadOptimization?: boolean
  ): z.infer<typeof StreamedChatCompletionAction> {
    // Defensive validation before creating payload
    if (!quest || typeof quest !== 'object') {
      this.logger.error('Invalid quest object provided to createOptimizedPayload');
      throw new Error('Invalid quest object');
    }

    // Ensure required fields exist with fallbacks
    const questId = quest.id || 'unknown-quest-id';
    const sessionId = quest.sessionId || 'unknown-session';

    // Log if we're using fallbacks
    if (!quest.id || !quest.sessionId) {
      this.logger.warn('Quest missing required fields, using fallbacks:', {
        hasId: !!quest.id,
        hasSessionId: !!quest.sessionId,
        questId,
        sessionId,
      });
    }

    // Create minimal payload - only send essential fields to reduce WebSocket traffic
    const questPayload: Partial<IChatHistoryItemDocument> = skipPayloadOptimization
      ? quest
      : {
          id: questId,
          sessionId: sessionId,
          reply: quest.reply ?? null,
          replies: Array.isArray(quest.replies) ? quest.replies : [],
          creditsUsed: quest.creditsUsed ?? 0,
          type: quest.type || 'message',
          status: quest.status || 'running',
          questMasterPlanId: quest.questMasterPlanId ?? undefined,
          prompt: quest.prompt ?? '',
          updatedAt: quest.updatedAt ?? new Date(),
          ...(quest.deepResearchState
            ? {
                deepResearchState: {
                  ...quest.deepResearchState,
                  findings: [], // Remove findings from payload as this is huge and not needed
                },
              }
            : {}),
          // Include Research Mode results if present
          ...(quest.researchModeResults ? { researchModeResults: quest.researchModeResults } : {}),
          // Include fallback info if present (for backend fallback mechanism)
          ...(quest.fallbackInfo ? { fallbackInfo: quest.fallbackInfo } : {}),
          images: quest.images ?? [],
          // Include pendingAction for MCP button confirmation flow
          ...(quest.pendingAction ? { pendingAction: quest.pendingAction } : {}),
          // Include uiSideEffects so the client can dispatch them when streaming completes
          ...(quest.uiSideEffects?.length ? { uiSideEffects: quest.uiSideEffects } : {}),
          // Include promptMeta when citables or artifacts exist so source chips and
          // tool-generated content (chess boards, etc.) render during streaming
          ...(quest.promptMeta?.citables?.length || quest.promptMeta?.artifacts?.length
            ? {
                promptMeta: {
                  ...(quest.promptMeta?.citables?.length ? { citables: quest.promptMeta.citables } : {}),
                  ...(quest.promptMeta?.artifacts?.length ? { artifacts: quest.promptMeta.artifacts } : {}),
                },
              }
            : {}),
        };

    // Validate the payload has required fields
    if (!questPayload.id || !questPayload.sessionId) {
      this.logger.updateMetadata({ questPayload });
      // Don't throw here - we've already added fallbacks above
      // Just log the issue for monitoring
      this.logger.error('Quest payload validation failed but continuing with fallback values');
    }

    return {
      action: 'streamed_chat_completion',
      quest: questPayload,
      statusMessage: status ?? '',
    };
  }

  /**
   * Force flush any pending throttled updates
   */
  public flush(): void {
    this.throttledSend.flush();
  }

  /**
   * Cancel any pending throttled updates
   */
  public cancel(): void {
    this.throttledSend.cancel();
  }

  /**
   * Send Research Mode streaming update
   */
  public async sendResearchModeUpdate(
    quest: IChatHistoryItemDocument,
    researchData: {
      configurationId: string;
      streamedTexts: string[];
      completionInfo?: any;
    }
  ): Promise<void> {
    try {
      const payload = {
        action: 'streamed_chat_completion' as const,
        quest: {
          id: quest.id,
          sessionId: quest.sessionId,
          type: 'message' as const,
          status: 'running' as const,
          replies: [],
          creditsUsed: 0,
          updatedAt: new Date(),
        },
        statusMessage: `Research Mode: ${researchData.configurationId}`,
        researchMode: {
          configurationId: researchData.configurationId,
          streamedTexts: researchData.streamedTexts,
          completionInfo: researchData.completionInfo,
        },
      };

      await this.clientMessageSender.sendToClient(this.userId, this.wsHttpsUrl, payload);
    } catch (error) {
      this.logger.error('Error sending Research Mode update:', error);
      // Don't throw - continue processing even if updates fail
    }
  }

  /**
   * Send Rapid Reply streaming update
   */
  public async sendRapidReplyUpdate(
    questId: string,
    sessionId: string,
    rapidReplyData: {
      content: string;
      status: 'streaming' | 'completed' | 'replaced';
      ttfvt?: number;
      modelId: string;
      mappingId: string;
    },
    statusMessage?: string | null
  ): Promise<void> {
    try {
      const payload: z.infer<typeof StreamedRapidReplyAction> = {
        action: 'streamed_rapid_reply',
        questId,
        sessionId,
        rapidReply: rapidReplyData,
        statusMessage: statusMessage ?? null,
      };

      await this.clientMessageSender.sendToClient(this.userId, this.wsHttpsUrl, payload);
    } catch (error) {
      this.logger.error('Error sending Rapid Reply update:', error);
      // Don't throw - continue processing even if updates fail
    }
  }
}
