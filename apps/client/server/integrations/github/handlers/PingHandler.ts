/**
 * GitHub Webhook Integration - Ping Event Handler
 *
 * Handles the 'ping' event that GitHub sends when a webhook is first configured.
 * This validates that the webhook is properly set up and updates the lastDeliveryAt timestamp.
 */

import { IMcpServerDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  GitHubEventHandler,
  GitHubHandlerContext,
  GitHubHandlerResult,
  GitHubPingPayload,
  GitHubWebhookPayload,
} from '../types';

export class PingHandler implements GitHubEventHandler {
  eventType = 'ping' as const;
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  async handle(
    payload: GitHubWebhookPayload,
    mcpServer?: IMcpServerDocument,
    _context?: GitHubHandlerContext
  ): Promise<GitHubHandlerResult> {
    const pingPayload = payload as GitHubPingPayload;

    this.logger?.info('[GITHUB-PING] Webhook ping received', {
      zen: pingPayload.zen,
      hookId: pingPayload.hook_id,
      hookEvents: pingPayload.hook?.events,
      mcpServerId: mcpServer?.id,
      userId: mcpServer?.userId,
    });

    // Ping just confirms the webhook is configured; lastDeliveryAt is updated by the main handler.
    return { notifiedUserIds: [] };
  }
}
