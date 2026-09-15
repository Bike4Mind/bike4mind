/**
 * GitHub Webhook Integration - GitHubEvent
 *
 * Wrapper class for GitHub webhook events with deduplication support.
 * Follows the same pattern as SlackEvent for consistency.
 */

import { cacheRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { GitHubEventType, GitHubWebhookPayload } from './types';

/**
 * Deduplication window for GitHub webhook events
 *
 * GitHub doesn't auto-retry like Slack, but webhooks can be:
 * - Manually re-delivered from GitHub UI
 * - Duplicated due to network retries
 * - Replayed by attackers
 *
 * Using 1 hour to handle most legitimate retry scenarios while
 * preventing replay attacks within a reasonable window.
 */
const GITHUB_DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * GitHubEvent wraps a GitHub webhook payload with helper methods
 * for common operations including deduplication.
 */
export class GitHubEvent {
  private payload: GitHubWebhookPayload;
  private eventType: GitHubEventType;
  private deliveryId: string;

  constructor(eventType: GitHubEventType, deliveryId: string, payload: GitHubWebhookPayload) {
    this.eventType = eventType;
    this.deliveryId = deliveryId;
    this.payload = payload;
  }

  // Core properties

  get type(): GitHubEventType {
    return this.eventType;
  }

  get delivery(): string {
    return this.deliveryId;
  }

  get action(): string | undefined {
    return this.payload.action;
  }

  get repository(): GitHubWebhookPayload['repository'] {
    return this.payload.repository;
  }

  get repositoryFullName(): string | undefined {
    return this.payload.repository?.full_name;
  }

  get sender(): GitHubWebhookPayload['sender'] {
    return this.payload.sender;
  }

  get rawPayload(): GitHubWebhookPayload {
    return this.payload;
  }

  // Deduplication

  /**
   * Atomically try to claim this event for processing
   *
   * Uses MongoDB atomic counter to prevent race conditions.
   * Only one request can successfully claim an event.
   *
   * @param logger - Optional logger for debugging
   * @param scope - Optional scope to isolate dedup between independent systems.
   *   GitHub reuses the same deliveryId across all webhook configs (App + repo)
   *   for the same event. Without scope, the first endpoint to claim blocks all others.
   *   Use distinct scopes (e.g., 'sre', 'org') so independent systems can both process.
   * @returns Object with claimed status
   * @throws Error if cache operation fails (fail-closed for security)
   */
  async tryClaimForProcessing(logger?: Logger, scope?: string): Promise<{ claimed: boolean }> {
    const dedupKey = scope ? `github-webhook:${scope}:${this.deliveryId}` : `github-webhook-${this.deliveryId}`;

    // Use atomic counter with limit=1 to claim the event
    // First request gets count=1 (claimed), subsequent requests fail (already claimed)
    const result = await cacheRepository.incrementCounterConditional(dedupKey, 1, GITHUB_DEDUP_WINDOW_MS);

    if (result.success) {
      logger?.debug('[GITHUB-DEDUP] Event claimed for processing', {
        deliveryId: this.deliveryId,
        eventType: this.eventType,
        scope,
      });
      return { claimed: true };
    } else {
      logger?.info('[GITHUB-DEDUP] Event already claimed/processed', {
        deliveryId: this.deliveryId,
        eventType: this.eventType,
        existingCount: result.count,
        scope,
      });
      return { claimed: false };
    }
  }

  // Utility methods

  /**
   * Get a human-readable description of this event
   */
  getDescription(): string {
    const parts: string[] = [`Event: ${this.eventType}`];

    if (this.action) {
      parts.push(`Action: ${this.action}`);
    }

    if (this.repositoryFullName) {
      parts.push(`Repo: ${this.repositoryFullName}`);
    }

    if (this.sender?.login) {
      parts.push(`Sender: ${this.sender.login}`);
    }

    parts.push(`Delivery: ${this.deliveryId}`);

    return parts.join(' | ');
  }
}
