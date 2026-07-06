import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

export enum McpServerName {
  LinkedIn = 'linkedin',
  Github = 'github',
  Atlassian = 'atlassian',
  Notion = 'notion',
}

export interface IGitHubRepository {
  fullName: string; // "owner/repo"
  owner: string; // "MillionOnMars"
  repo: string; // "repo"
}

export interface IGitHubWebhookConfig {
  routingToken: string; // Unique token for header routing (X-Webhook-Token)
  secret: string; // HMAC secret for signature validation (REQUIRED)
  subscribedEvents: string[]; // Events to process (e.g., 'pull_request', 'issues')
  repos: string[]; // Repositories in owner/repo format
  createdAt: string; // ISO date string
  lastDeliveryAt?: string; // ISO date string of last successful delivery
}

export interface IMcpServerDocument extends IMongoDocument {
  name: McpServerName;
  userId: string;
  envVariables: { key: string; value: string }[];
  tools: string[];
  toolSchemas?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>;
  enabled: boolean;
  metadata?: {
    githubLogin?: string;
    scope?: string;
    connectedAt?: string;
    disconnectedAt?: string;
    selectedRepositories?: IGitHubRepository[]; // User-selected accessible repositories
    webhooks?: {
      github?: IGitHubWebhookConfig;
    };
  };
}

// API response type - excludes sensitive envVariables
export type IMcpServerResponse = Omit<IMcpServerDocument, 'envVariables'>;

export interface IMcpServerRepository extends IBaseRepository<IMcpServerDocument> {}
