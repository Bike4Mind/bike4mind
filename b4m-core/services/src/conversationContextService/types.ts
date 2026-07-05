import {
  IConversationContext,
  IGitHubRepoEntity,
  IGitHubPREntity,
  IGitHubIssueEntity,
  IJiraProjectEntity,
  IJiraIssueEntity,
  IConfluenceSpaceEntity,
  IConfluencePageEntity,
  EntityMentionSource,
  ISessionRepository,
  ISessionDocument,
} from '@bike4mind/common';

/**
 * Minimal session repository interface needed for conversation context operations.
 * This allows the service to work with Pick types from ChatCompletionProcess.
 */
export interface MinimalSessionRepository {
  findById(id: string): Promise<ISessionDocument | null>;
  update(data: { id: string; conversationContext?: IConversationContext }): Promise<ISessionDocument | null>;
}

/**
 * Adapters for conversation context service
 */
export interface ConversationContextAdapters {
  db: {
    sessions: MinimalSessionRepository | ISessionRepository;
  };
}

/**
 * Options for adding entities to context
 */
export interface AddEntityOptions {
  /** Maximum number of entities to keep per type (default: 20) */
  maxEntitiesPerType?: number;
  /** TTL in milliseconds for entities (default: 1 hour) */
  entityTTLMs?: number;
}

/**
 * Default configuration for conversation context
 */
export const CONVERSATION_CONTEXT_DEFAULTS = {
  maxEntitiesPerType: 20,
  entityTTLMs: 60 * 60 * 1000, // 1 hour
} as const;

/**
 * Union type for all entity types
 */
export type ConversationEntity =
  | { type: 'github_repo'; entity: Omit<IGitHubRepoEntity, 'mentionedAt' | 'source'> }
  | { type: 'github_pr'; entity: Omit<IGitHubPREntity, 'mentionedAt' | 'source'> }
  | { type: 'github_issue'; entity: Omit<IGitHubIssueEntity, 'mentionedAt' | 'source'> }
  | { type: 'jira_project'; entity: Omit<IJiraProjectEntity, 'mentionedAt' | 'source'> }
  | { type: 'jira_issue'; entity: Omit<IJiraIssueEntity, 'mentionedAt' | 'source'> }
  | { type: 'confluence_space'; entity: Omit<IConfluenceSpaceEntity, 'mentionedAt' | 'source'> }
  | { type: 'confluence_page'; entity: Omit<IConfluencePageEntity, 'mentionedAt' | 'source'> };

/**
 * Re-export types for convenience
 */
export type {
  IConversationContext,
  IGitHubRepoEntity,
  IGitHubPREntity,
  IGitHubIssueEntity,
  IJiraProjectEntity,
  IJiraIssueEntity,
  IConfluenceSpaceEntity,
  IConfluencePageEntity,
  EntityMentionSource,
};
