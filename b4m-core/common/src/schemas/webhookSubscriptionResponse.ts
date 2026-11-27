import * as z from 'zod';
import type { IWebhookSubscriptionResponse } from '../types/entities/WebhookSubscriptionTypes';
import type { IJiraWebhookSubscriptionResponse } from '../types/entities/JiraWebhookSubscriptionTypes';
import { passthroughShape } from './responseShape';

// Held to the response interface: a new field fails the build here until it is listed. Key
// boundary only - it strips keys it does not list, it never withholds one.
const WEBHOOK_SUBSCRIPTION_RESPONSE_FIELDS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  userId: true,
  organizationId: true,
  repos: true,
  events: true,
  mcpServerId: true,
  enabled: true,
  consecutiveFailures: true,
  circuitBreakerOpenedAt: true,
  autoDisabledAt: true,
  autoDisabledReason: true,
  organizationName: true,
  lastEventAt: true,
} as const satisfies Record<keyof IWebhookSubscriptionResponse, true>;

/** A GitHub webhook subscription as returned by /api/webhooks/github/subscriptions. */
export const webhookSubscriptionResponseSchema = z.object(passthroughShape(WEBHOOK_SUBSCRIPTION_RESPONSE_FIELDS));

export const webhookSubscriptionListResponseSchema = z.array(webhookSubscriptionResponseSchema);

const JIRA_WEBHOOK_SUBSCRIPTION_RESPONSE_FIELDS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  userId: true,
  webhookConfigId: true,
  atlassianCloudId: true,
  slackTarget: true,
  projectFilter: true,
  priorityFilter: true,
  issueTypeFilter: true,
  name: true,
  enabled: true,
  consecutiveFailures: true,
  circuitBreakerOpenedAt: true,
  autoDisabledAt: true,
  autoDisabledReason: true,
  atlassianSiteName: true,
  lastEventAt: true,
} as const satisfies Record<keyof IJiraWebhookSubscriptionResponse, true>;

/** A Jira webhook subscription as returned by /api/webhooks/jira/subscriptions. */
export const jiraWebhookSubscriptionResponseSchema = z.object(
  passthroughShape(JIRA_WEBHOOK_SUBSCRIPTION_RESPONSE_FIELDS)
);

export const jiraWebhookSubscriptionListResponseSchema = z.array(jiraWebhookSubscriptionResponseSchema);
