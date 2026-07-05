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
} from '@bike4mind/common';
import {
  ConversationContextAdapters,
  ConversationEntity,
  AddEntityOptions,
  CONVERSATION_CONTEXT_DEFAULTS,
} from './types';
import { getOrCreate } from './get';

/**
 * Helper to clean expired entities and enforce max limit
 * @param entities - Array of entities with mentionedAt timestamps
 * @param maxCount - Maximum number of entities to keep
 * @param ttlCutoff - Cutoff date for TTL (entities older than this are removed)
 * @returns Cleaned and limited array of entities
 */
function cleanAndLimit<T extends { mentionedAt: Date }>(entities: T[], maxCount: number, ttlCutoff: Date): T[] {
  const valid = entities.filter(e => e.mentionedAt > ttlCutoff);
  valid.sort((a, b) => b.mentionedAt.getTime() - a.mentionedAt.getTime());
  return valid.slice(0, maxCount);
}

/**
 * Add an entity to the conversation context.
 * Updates existing entity if found (refreshes mentionedAt), otherwise adds new.
 * Enforces max entities per type and TTL cleanup.
 *
 * @param sessionId - The session ID
 * @param entity - The entity to add (type-discriminated union)
 * @param source - Where the entity was mentioned
 * @param adapters - Database adapters
 * @param options - Optional configuration
 * @returns The updated conversation context
 */
export async function addEntity(
  sessionId: string,
  entity: ConversationEntity,
  source: EntityMentionSource,
  adapters: ConversationContextAdapters,
  options: AddEntityOptions = {}
): Promise<IConversationContext> {
  const { db } = adapters;
  const {
    maxEntitiesPerType = CONVERSATION_CONTEXT_DEFAULTS.maxEntitiesPerType,
    entityTTLMs = CONVERSATION_CONTEXT_DEFAULTS.entityTTLMs,
  } = options;

  const context = await getOrCreate(sessionId, adapters);
  const now = new Date();
  const ttlCutoff = new Date(now.getTime() - entityTTLMs);

  if (!context.github) {
    context.github = { repos: [], prs: [], issues: [] };
  }
  if (!context.jira) {
    context.jira = { projects: [], issues: [] };
  }
  if (!context.confluence) {
    context.confluence = { spaces: [], pages: [] };
  }

  switch (entity.type) {
    case 'github_repo': {
      const newEntity: IGitHubRepoEntity = {
        ...entity.entity,
        mentionedAt: now,
        source,
      };
      // Check if entity already exists (same owner/repo)
      const existingIndex = context.github.repos.findIndex(
        e => e.owner === newEntity.owner && e.repo === newEntity.repo
      );
      if (existingIndex >= 0) {
        context.github.repos[existingIndex] = newEntity;
      } else {
        context.github.repos.push(newEntity);
      }
      context.github.repos = cleanAndLimit(context.github.repos, maxEntitiesPerType, ttlCutoff);
      break;
    }

    case 'github_pr': {
      const newEntity: IGitHubPREntity = {
        ...entity.entity,
        mentionedAt: now,
        source,
      };
      const existingIndex = context.github.prs.findIndex(
        e => e.owner === newEntity.owner && e.repo === newEntity.repo && e.number === newEntity.number
      );
      if (existingIndex >= 0) {
        context.github.prs[existingIndex] = newEntity;
      } else {
        context.github.prs.push(newEntity);
      }
      context.github.prs = cleanAndLimit(context.github.prs, maxEntitiesPerType, ttlCutoff);
      break;
    }

    case 'github_issue': {
      const newEntity: IGitHubIssueEntity = {
        ...entity.entity,
        mentionedAt: now,
        source,
      };
      const existingIndex = context.github.issues.findIndex(
        e => e.owner === newEntity.owner && e.repo === newEntity.repo && e.number === newEntity.number
      );
      if (existingIndex >= 0) {
        context.github.issues[existingIndex] = newEntity;
      } else {
        context.github.issues.push(newEntity);
      }
      context.github.issues = cleanAndLimit(context.github.issues, maxEntitiesPerType, ttlCutoff);
      break;
    }

    case 'jira_project': {
      const newEntity: IJiraProjectEntity = {
        ...entity.entity,
        mentionedAt: now,
        source,
      };
      const existingIndex = context.jira.projects.findIndex(e => e.key === newEntity.key);
      if (existingIndex >= 0) {
        context.jira.projects[existingIndex] = newEntity;
      } else {
        context.jira.projects.push(newEntity);
      }
      context.jira.projects = cleanAndLimit(context.jira.projects, maxEntitiesPerType, ttlCutoff);
      break;
    }

    case 'jira_issue': {
      const newEntity: IJiraIssueEntity = {
        ...entity.entity,
        mentionedAt: now,
        source,
      };
      const existingIndex = context.jira.issues.findIndex(e => e.key === newEntity.key);
      if (existingIndex >= 0) {
        context.jira.issues[existingIndex] = newEntity;
      } else {
        context.jira.issues.push(newEntity);
      }
      context.jira.issues = cleanAndLimit(context.jira.issues, maxEntitiesPerType, ttlCutoff);
      break;
    }

    case 'confluence_space': {
      const newEntity: IConfluenceSpaceEntity = {
        ...entity.entity,
        mentionedAt: now,
        source,
      };
      const existingIndex = context.confluence.spaces.findIndex(e => e.key === newEntity.key);
      if (existingIndex >= 0) {
        context.confluence.spaces[existingIndex] = newEntity;
      } else {
        context.confluence.spaces.push(newEntity);
      }
      context.confluence.spaces = cleanAndLimit(context.confluence.spaces, maxEntitiesPerType, ttlCutoff);
      break;
    }

    case 'confluence_page': {
      const newEntity: IConfluencePageEntity = {
        ...entity.entity,
        mentionedAt: now,
        source,
      };
      const existingIndex = context.confluence.pages.findIndex(e => e.id === newEntity.id);
      if (existingIndex >= 0) {
        context.confluence.pages[existingIndex] = newEntity;
      } else {
        context.confluence.pages.push(newEntity);
      }
      context.confluence.pages = cleanAndLimit(context.confluence.pages, maxEntitiesPerType, ttlCutoff);
      break;
    }
  }

  context.lastUpdated = now;

  await db.sessions.update({
    id: sessionId,
    conversationContext: context,
  });

  return context;
}

/**
 * Add multiple entities to the conversation context at once.
 * Batches all updates into a single DB call for efficiency.
 *
 * @param sessionId - The session ID
 * @param entities - Array of entities with their sources
 * @param adapters - Database adapters
 * @param options - Optional configuration
 * @returns The updated conversation context
 */
export async function addEntities(
  sessionId: string,
  entities: Array<{ entity: ConversationEntity; source: EntityMentionSource }>,
  adapters: ConversationContextAdapters,
  options: AddEntityOptions = {}
): Promise<IConversationContext> {
  if (entities.length === 0) {
    return getOrCreate(sessionId, adapters);
  }

  const { db } = adapters;
  const {
    maxEntitiesPerType = CONVERSATION_CONTEXT_DEFAULTS.maxEntitiesPerType,
    entityTTLMs = CONVERSATION_CONTEXT_DEFAULTS.entityTTLMs,
  } = options;

  // Single DB read
  const context = await getOrCreate(sessionId, adapters);
  const now = new Date();
  const ttlCutoff = new Date(now.getTime() - entityTTLMs);

  if (!context.github) {
    context.github = { repos: [], prs: [], issues: [] };
  }
  if (!context.jira) {
    context.jira = { projects: [], issues: [] };
  }
  if (!context.confluence) {
    context.confluence = { spaces: [], pages: [] };
  }

  // Process all entities in memory
  for (const { entity, source } of entities) {
    switch (entity.type) {
      case 'github_repo': {
        const newEntity: IGitHubRepoEntity = { ...entity.entity, mentionedAt: now, source };
        const existingIndex = context.github.repos.findIndex(
          e => e.owner === newEntity.owner && e.repo === newEntity.repo
        );
        if (existingIndex >= 0) {
          context.github.repos[existingIndex] = newEntity;
        } else {
          context.github.repos.push(newEntity);
        }
        break;
      }
      case 'github_pr': {
        const newEntity: IGitHubPREntity = { ...entity.entity, mentionedAt: now, source };
        const existingIndex = context.github.prs.findIndex(
          e => e.owner === newEntity.owner && e.repo === newEntity.repo && e.number === newEntity.number
        );
        if (existingIndex >= 0) {
          context.github.prs[existingIndex] = newEntity;
        } else {
          context.github.prs.push(newEntity);
        }
        break;
      }
      case 'github_issue': {
        const newEntity: IGitHubIssueEntity = { ...entity.entity, mentionedAt: now, source };
        const existingIndex = context.github.issues.findIndex(
          e => e.owner === newEntity.owner && e.repo === newEntity.repo && e.number === newEntity.number
        );
        if (existingIndex >= 0) {
          context.github.issues[existingIndex] = newEntity;
        } else {
          context.github.issues.push(newEntity);
        }
        break;
      }
      case 'jira_project': {
        const newEntity: IJiraProjectEntity = { ...entity.entity, mentionedAt: now, source };
        const existingIndex = context.jira.projects.findIndex(e => e.key === newEntity.key);
        if (existingIndex >= 0) {
          context.jira.projects[existingIndex] = newEntity;
        } else {
          context.jira.projects.push(newEntity);
        }
        break;
      }
      case 'jira_issue': {
        const newEntity: IJiraIssueEntity = { ...entity.entity, mentionedAt: now, source };
        const existingIndex = context.jira.issues.findIndex(e => e.key === newEntity.key);
        if (existingIndex >= 0) {
          context.jira.issues[existingIndex] = newEntity;
        } else {
          context.jira.issues.push(newEntity);
        }
        break;
      }
      case 'confluence_space': {
        const newEntity: IConfluenceSpaceEntity = { ...entity.entity, mentionedAt: now, source };
        const existingIndex = context.confluence.spaces.findIndex(e => e.key === newEntity.key);
        if (existingIndex >= 0) {
          context.confluence.spaces[existingIndex] = newEntity;
        } else {
          context.confluence.spaces.push(newEntity);
        }
        break;
      }
      case 'confluence_page': {
        const newEntity: IConfluencePageEntity = { ...entity.entity, mentionedAt: now, source };
        const existingIndex = context.confluence.pages.findIndex(e => e.id === newEntity.id);
        if (existingIndex >= 0) {
          context.confluence.pages[existingIndex] = newEntity;
        } else {
          context.confluence.pages.push(newEntity);
        }
        break;
      }
    }
  }

  context.github.repos = cleanAndLimit(context.github.repos, maxEntitiesPerType, ttlCutoff);
  context.github.prs = cleanAndLimit(context.github.prs, maxEntitiesPerType, ttlCutoff);
  context.github.issues = cleanAndLimit(context.github.issues, maxEntitiesPerType, ttlCutoff);
  context.jira.projects = cleanAndLimit(context.jira.projects, maxEntitiesPerType, ttlCutoff);
  context.jira.issues = cleanAndLimit(context.jira.issues, maxEntitiesPerType, ttlCutoff);
  context.confluence.spaces = cleanAndLimit(context.confluence.spaces, maxEntitiesPerType, ttlCutoff);
  context.confluence.pages = cleanAndLimit(context.confluence.pages, maxEntitiesPerType, ttlCutoff);

  context.lastUpdated = now;

  // Single DB write
  await db.sessions.update({
    id: sessionId,
    conversationContext: context,
  });

  return context;
}
