/**
 * Dependency injection interfaces for @bike4mind/slack
 *
 * These interfaces define the contracts for server-specific and database
 * dependencies that must be provided by the consuming application at startup.
 */

import type {
  IUserDocument,
  ISessionDocument,
  IChatHistoryItem,
  IFabFileRepository,
  IMcpServerDocument,
  ISession,
} from '@bike4mind/common';
import type { ITokenizer } from '@bike4mind/utils';
import { ILogger } from '@bike4mind/observability';
import { S3Storage } from '@bike4mind/fab-pipeline';
import type mongoose from 'mongoose';

// ─── JWT State Store ─────────────────────────────────────────────────────────

export interface JwtStateStoreOptions {
  audience: string;
  expiresIn?: string | number;
}

export interface BaseStatePayload {
  aud: string;
  iat: number;
  exp: number;
}

export type VerifyResult<T = unknown> =
  | { valid: true; payload: T }
  | { valid: false; reason: 'missing' | 'expired' | 'invalid'; message: string };

export interface IJwtStateStore {
  createStateToken<T extends Record<string, unknown>>(options: JwtStateStoreOptions, additionalPayload?: T): string;
  verifyStateToken<T extends BaseStatePayload>(token: string, options: JwtStateStoreOptions): VerifyResult<T>;
  validateJwtSecret(): string;
}

// ─── Session Manager ─────────────────────────────────────────────────────────

export interface GetOrCreateSessionParams {
  sessionId?: string;
  sessionName?: string;
  projectId?: string;
  user: IUserDocument;
  ability?: unknown;
  logger: ILogger;
  fabFileIds?: string[];
}

export interface GetOrCreateSessionResult {
  session: ISessionDocument;
  sessionId: string;
  wasCreated: boolean;
  asyncPromises: Promise<unknown>[];
}

export interface ISessionManager {
  getOrCreateSession(params: GetOrCreateSessionParams): Promise<GetOrCreateSessionResult>;
  createSession(
    userId: string,
    data: Partial<ISession>,
    ability: unknown,
    options?: { setLastNotebook?: boolean; session?: unknown }
  ): Promise<ISessionDocument>;
  addMessageToSession(
    userId: string,
    sessionId: string | mongoose.Types.ObjectId,
    message: Omit<IChatHistoryItem, 'sessionId'>,
    ability: unknown
  ): Promise<IChatHistoryItem>;
  getDefaultSession(userId: string): Omit<ISession, 'id'>;
}

// ─── Auth / Ability ──────────────────────────────────────────────────────────

export interface IAuthAbility {
  defineAbilitiesFor(user: IUserDocument | undefined): unknown;
}

// ─── Integration Circuit Breaker ─────────────────────────────────────────────

export interface IIntegrationCircuitBreaker {
  isAvailable(integration: string): Promise<boolean>;
}

// ─── CloudWatch ──────────────────────────────────────────────────────────────

export interface ICloudwatch {
  recordRateLimitEvent(
    integration: string,
    usagePercent: number | null,
    wasThrottled: boolean,
    endpoint?: string
  ): Promise<void>;
}

// ─── Chat Completion Defaults ────────────────────────────────────────────────

export interface IChatCompletionDefaults {
  defaultChatCompletionOptions: Record<string, unknown>;
  getSharedTokenizer(logger?: ILogger): ITokenizer;
}

// ─── Event Bus ───────────────────────────────────────────────────────────────

export interface ILLMEvent<T = unknown> {
  publish(detail: T): Promise<void>;
}

export interface IEventBus {
  LLMEvents: {
    CompletionStart: ILLMEvent;
    CompletionCompleted: ILLMEvent;
    [key: string]: ILLMEvent;
  };
}

// ─── MCP Environment ─────────────────────────────────────────────────────────

export type EnvVariable = { key: string; value: string };

export interface IMcpEnv {
  buildMcpEnvVariables(mcpServer: IMcpServerDocument): Promise<EnvVariable[]>;
}

// ─── MCP Handler ─────────────────────────────────────────────────────────────

export interface McpHandlerPayload {
  id?: string;
  envVariables: EnvVariable[];
  name: string;
  action: 'getTools' | 'callTool';
  userId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}

export interface IMcpHandler {
  invokeMcpHandler<T = unknown>(payload: McpHandlerPayload): Promise<T>;
}

// ─── Analytics Manager ───────────────────────────────────────────────────────

export interface IAnalyticsManager {
  logEvent(event: unknown, options?: { session?: unknown; ability?: unknown }): Promise<void>;
}

// ─── Storage ─────────────────────────────────────────────────────────────────

export interface IStorage {
  filesStorage: S3Storage;
}

// ─── GitHub Repo Helper ──────────────────────────────────────────────────────

export interface IGithubRepoHelper {
  getSelectedRepositoriesForMcp(userId: string, serverName: string): Promise<string[] | undefined>;
}

// ─── Token Encryption ────────────────────────────────────────────────────────

export interface ITokenEncryption {
  encryptToken(value: string | null | undefined): string | null;
  decryptToken(value: string | null | undefined): string | null;
}

// ─── SST Resources ───────────────────────────────────────────────────────────

export interface ISstResources {
  mcpHandlerFunctionName: string;
}

// ─── Combined Server Dependencies ────────────────────────────────────────────

export interface ISlackServerDependencies {
  jwtStateStore: IJwtStateStore;
  sessionManager: ISessionManager;
  authAbility: IAuthAbility;
  integrationCircuitBreaker: IIntegrationCircuitBreaker;
  cloudwatch: ICloudwatch;
  chatCompletionDefaults: IChatCompletionDefaults;
  eventBus: IEventBus;
  mcpEnv: IMcpEnv;
  mcpHandler: IMcpHandler;
  githubRepoHelper: IGithubRepoHelper;
  analyticsManager: IAnalyticsManager;
  storage: IStorage;
  tokenEncryption: ITokenEncryption;
  sstResources: ISstResources;
}

// ─── Database Dependencies ───────────────────────────────────────────────────

export interface ISlackDatabaseDependencies {
  // Repositories
  rateLimitSnapshotRepository: unknown;
  cacheRepository: unknown;
  apiKeyRepository: unknown;
  adminSettingsRepository: unknown;
  slackDevWorkspaceRepository: unknown;
  slackChannelConfigRepository: unknown;
  slackAuditLogRepository: unknown;
  webhookSubscriptionRepository: unknown;
  mcpServerRepository: unknown;
  fabFileRepository: IFabFileRepository;
  projectRepository: unknown;
  sessionRepository: unknown;

  // Models (Mongoose models for direct queries)
  User: unknown;
  Session: unknown;
  Quest: unknown;
  Project: unknown;
  Agent: unknown;
  Organization: unknown;
  McpServer: unknown;
  SlackChannelConfig: unknown;
  AdminSettings: unknown;
  FabFile: unknown;

  // Utilities
  defineAbilitiesFor: (user: IUserDocument | undefined) => unknown;
}
