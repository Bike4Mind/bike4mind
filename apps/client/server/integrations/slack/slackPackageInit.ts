/**
 * Initializes the @bike4mind/slack package with server-specific dependencies.
 *
 * Must be called once at server startup before any Slack API route runs.
 */

import { configureSlackPackage } from '@bike4mind/slack';
import type { ISlackServerDependencies, ISlackDatabaseDependencies } from '@bike4mind/slack';

// Server utilities
import { createStateToken, verifyStateToken, validateJwtSecret } from '@server/auth/jwtStateStore';
import {
  getOrCreateSession,
  createSession,
  addMessageToSession,
  getDefaultSession,
} from '@server/managers/sessionManager';
import defineAbilitiesFor from '@server/auth/ability';
import { isAvailable } from '@server/services/integrationCircuitBreaker';
import { recordRateLimitEvent } from '@server/utils/cloudwatch';
import { getDefaultChatCompletionOptions, getSharedTokenizer } from '@server/utils/chatCompletionDefaults';
import { LLMEvents } from '@server/utils/eventBus';
import { buildMcpEnvVariables } from '@server/utils/mcpEnv';

import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';
import { getSelectedRepositoriesForMcp } from '@server/integrations/github/github-repo-helper';
import { logEvent } from '@server/utils/analyticsLog';
import { getFilesStorage } from '@server/utils/storage';
import { Resource } from 'sst';
import { encryptToken, decryptToken } from '@server/security/tokenEncryption';

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
import { slackDevWorkspaceRepository } from '@bike4mind/database/infra';

// Route Slack-originated completions to SlackEventBus (slackQuestProcessor),
// keeping them separate from web-originated completions on AppEventBus (questProcessor).
const slackEventBus = {
  LLMEvents: {
    ...LLMEvents,
    CompletionStart: LLMEvents.SlackCompletionStart,
  },
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
    eventBus: slackEventBus as any,
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
