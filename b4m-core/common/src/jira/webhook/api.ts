/**
 * Jira Webhook API Client
 *
 * Manages Jira Cloud webhooks for event notifications.
 *
 * @see https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-webhooks/
 *
 * Important constraints:
 * - Webhooks are tied to the OAuth app that created them
 * - Webhooks expire after 30 days and need refreshing
 * - Maximum of 100 webhooks per OAuth app
 * - JQL filters are applied server-side by Jira
 */

import { JiraConfig } from '../api';
import {
  JiraWebhook,
  JiraWebhookListResponse,
  JiraWebhookRegisterRequest,
  JiraWebhookRegisterResponse,
  JiraWebhookRefreshRequest,
  JiraWebhookRefreshResponse,
  JiraWebhookDeleteRequest,
  FormattedJiraWebhookList,
} from './types';
import { formatWebhookList } from './format';

type QueryParams = Record<string, string | number | boolean | undefined>;

/**
 * Jira Webhook API Client.
 *
 * Provides methods for managing Jira webhooks (create, list, refresh, delete).
 */
export class WebhookApi {
  constructor(private readonly config: JiraConfig) {}

  /**
   * Build URL for webhook API endpoints.
   *
   * Note: Webhooks use a different base URL than other Jira APIs.
   */
  private buildUrl(path: string, query: QueryParams = {}): string {
    const url = new URL(`${this.config.apiBaseUrl}${path}`);

    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.append(key, String(value));
      }
    }

    return url.toString();
  }

  /**
   * Make an authenticated request to the Jira Webhook API.
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { query?: QueryParams; body?: unknown } = {}
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);

    const headers: Record<string, string> = {
      Authorization: this.config.authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Jira Webhook API error (${response.status}): ${errorBody}`);
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    const data = await response.json();
    return data as T;
  }

  // ============================================================================
  // Webhook CRUD Operations
  // ============================================================================

  /**
   * List all webhooks registered by this OAuth app.
   *
   * @param startAt - Pagination start index (default: 0)
   * @param maxResults - Max results per page (default: 50, max: 100)
   */
  async listWebhooks(params: { startAt?: number; maxResults?: number } = {}): Promise<FormattedJiraWebhookList> {
    const { startAt = 0, maxResults = 50 } = params;

    const response = await this.request<JiraWebhookListResponse>('GET', '/webhook', {
      query: { startAt, maxResults },
    });

    return formatWebhookList(response);
  }

  /**
   * Register a new webhook.
   *
   * @param url - The URL where Jira will POST webhook events
   * @param events - Events to subscribe to
   * @param jqlFilter - Optional JQL filter (only matching issues trigger events)
   * @returns The created webhook ID
   */
  async registerWebhook(params: { url: string; events: string[]; jqlFilter?: string }): Promise<{ webhookId: number }> {
    const { url, events, jqlFilter } = params;

    const webhook: JiraWebhookRegisterRequest['webhooks'][number] = {
      // Jira webhook API requires jqlFilter but has limited operator support.
      // "IS NOT EMPTY" and empty strings are rejected. Use a universally-true expression.
      jqlFilter: jqlFilter || 'project != null',
      events: events as JiraWebhookRegisterRequest['webhooks'][number]['events'],
    };

    const body: JiraWebhookRegisterRequest = {
      url,
      webhooks: [webhook],
    };

    const response = await this.request<JiraWebhookRegisterResponse>('POST', '/webhook', {
      body,
    });

    console.log('[JIRA-WEBHOOK-API] registerWebhook raw response:', JSON.stringify(response, null, 2));

    if (!response.webhookRegistrationResult || response.webhookRegistrationResult.length === 0) {
      throw new Error('Failed to register webhook: No registration result returned');
    }

    const result = response.webhookRegistrationResult[0];

    // Jira returns 200 OK but individual registrations can fail with errors
    if (result.errors && result.errors.length > 0) {
      throw new Error(`Failed to register webhook: ${result.errors.join(', ')}`);
    }

    if (result.createdWebhookId === undefined || result.createdWebhookId === null) {
      throw new Error(`Failed to register webhook: No webhook ID in response. Full result: ${JSON.stringify(result)}`);
    }

    return {
      webhookId: result.createdWebhookId,
    };
  }

  /**
   * Refresh webhook expiration dates.
   *
   * Jira webhooks expire after 30 days. Call this to extend expiration.
   *
   * @param webhookIds - IDs of webhooks to refresh
   * @returns New expiration date
   */
  async refreshWebhooks(params: { webhookIds: number[] }): Promise<{ expirationDate: string }> {
    const { webhookIds } = params;

    const body: JiraWebhookRefreshRequest = {
      webhookIds,
    };

    const response = await this.request<JiraWebhookRefreshResponse>('PUT', '/webhook/refresh', {
      body,
    });

    return {
      expirationDate: response.expirationDate,
    };
  }

  /**
   * Delete webhooks by ID.
   *
   * @param webhookIds - IDs of webhooks to delete
   */
  async deleteWebhooks(params: { webhookIds: number[] }): Promise<void> {
    const { webhookIds } = params;

    const body: JiraWebhookDeleteRequest = {
      webhookIds,
    };

    await this.request<void>('DELETE', '/webhook', {
      body,
    });
  }

  /**
   * Get a specific webhook by ID.
   *
   * Note: Jira API doesn't have a direct "get by ID" endpoint,
   * so we list and filter.
   */
  async getWebhook(params: { webhookId: number }): Promise<JiraWebhook | null> {
    const { webhookId } = params;

    // In practice, if you have < 100 webhooks, this is fine
    const response = await this.request<JiraWebhookListResponse>('GET', '/webhook', {
      query: { startAt: 0, maxResults: 100 },
    });

    const webhook = response.values.find(w => w.id === webhookId);
    return webhook || null;
  }
}
