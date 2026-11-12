/**
 * Initializes the @bike4mind/slack package with server-specific dependencies.
 *
 * Must be called once at server startup before any Slack API route runs.
 */

import { configureSlackPackage } from '@bike4mind/slack';
import type { ISlackServerDependencies, ISlackDatabaseDependencies } from '@bike4mind/slack';

// Server utilities
import { createStateToken, verifyStateToken, validateJwtSecret } from '../../auth/jwtStateStore';
import {
  getOrCreateSession,
  createSession,
  addMessageToSession,
  getDefaultSession,
} from '../../managers/sessionManager';
import defineAbilitiesFor from '../../auth/ability';
import { isAvailable } from '../../services/integrationCircuitBreaker';
import { recordRateLimitEvent } from '../../utils/cloudwatch';
import { getDefaultChatCompletionOptions, getSharedTokenizer } from '../../utils/chatCompletionDefaults';
import { LLMEvents, SlackEvents } from '../../utils/eventBus';
import { buildMcpEnvVariables } from '../../utils/mcpEnv';

import { invokeMcpHandler } from '../../utils/invokeMcpHandler';
import { getSelectedRepositoriesForMcp } from '../github/github-repo-helper';
import { logEvent } from '../../utils/analyticsLog';
import { getFilesStorage } from '../../utils/storage/index';
import { Resource } from 'sst';
import { encryptToken, decryptToken } from '../../security/tokenEncryption';

// Database models and repositories
import {
  User,
  Session,
  Quest,
  Project,
  Agent,
  Organization,
  McpServer,
  SlackChannelConfig,
  AdminSettings,
  FabFile,
  rateLimitSnapshotRepository,
  cacheRepository,
  apiKeyRepository,
  adminSettingsRepository,
  slackChannelConfigRepository,
  slackAuditLogRepository,
  webhookSubscriptionRepository,
  mcpServerRepository,
  fabFileRepository,
  projectRepository,
  sessionRepository,
  defineAbilitiesFor as dbDefineAbilitiesFor,
} from '@bike4mind/database';
import { slackDevWorkspaceRepository, orgSlackWorkspaceRepository } from '@bike4mind/database/infra';

// Publish Slack-originated completions as 'slack.completion.started' so they reach
// slackQuestProcessor rather than the web completion path.
const slackEventPublisher = {
  LLMEvents: {
    ...LLMEvents,
    CompletionStart: LLMEvents.SlackCompletionStart,
  },
  SlackEvents,
};

let initialized = false;

export function initializeSlackPackage(): void {
  if (initialized) return;

  // any: The concrete implementations satisfy the DI interfaces at runtime;
  // minor generic/return-type mismatches between @server/* and DI interfaces are safe to bypass.
  const serverDeps: ISlackServerDependencies = {
    jwtStateStore: {
      createStateToken,
      verifyStateToken: verifyStateToken as any,
      validateJwtSecret,
    },
    sessionManager: {
      getOrCreateSession,
      createSession,
      addMessageToSession,
      getDefaultSession,
    },
    authAbility: {
      defineAbilitiesFor,
    },
    integrationCircuitBreaker: {
      isAvailable,
    },
    cloudwatch: {
      recordRateLimitEvent,
    },
    chatCompletionDefaults: {
      defaultChatCompletionOptions: getDefaultChatCompletionOptions(),
      getSharedTokenizer,
    },
    eventBus: slackEventPublisher as any,
    mcpEnv: {
      buildMcpEnvVariables,
    },
    mcpHandler: {
      invokeMcpHandler,
    },
    githubRepoHelper: {
      getSelectedRepositoriesForMcp,
    },
    analyticsManager: {
      logEvent,
    },
    storage: {
      filesStorage: getFilesStorage(),
    },
    tokenEncryption: {
      encryptToken,
      decryptToken,
    },
    sstResources: {
      mcpHandlerFunctionName: (() => {
        try {
          return Resource.mcpHandler?.name ?? '';
        } catch {
          return '';
        }
      })(),
    },
  };

  const databaseDeps: ISlackDatabaseDependencies = {
    // Repositories
    rateLimitSnapshotRepository,
    cacheRepository,
    apiKeyRepository,
    adminSettingsRepository,
    slackDevWorkspaceRepository,
    orgSlackWorkspaceRepository,
    slackChannelConfigRepository,
    slackAuditLogRepository,
    webhookSubscriptionRepository,
    mcpServerRepository,
    fabFileRepository,
    projectRepository,
    sessionRepository,

    // Models
    User,
    Session,
    Quest,
    Project,
    Agent,
    Organization,
    McpServer,
    SlackChannelConfig,
    AdminSettings,
    FabFile,

    // Utilities
    defineAbilitiesFor: dbDefineAbilitiesFor,
  };

  configureSlackPackage(serverDeps, databaseDeps);
  initialized = true;
}
