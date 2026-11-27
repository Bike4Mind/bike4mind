import type { ChatQueueEvent, ChatSessionStatusEvent, ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import type { LoopState } from '@shared/loop';
import type { PendingTaskDecision } from '@shared/orchestration';
import type { AuthService } from '../main/auth/AuthService';
import type { ChatServiceDeps } from '../main/chat/ChatService';
import type { PrMonitor } from '../main/pr/PrMonitor';
import type { ProtectedLocations } from '../main/chat/protectedLocations';

/** The facts about the machine a runtime runs on that it cannot learn without the app shell. */
export type HostEnvironment = {
  /** Root of every store the runtime keeps; the app's userData folder on Desktop. */
  dataDirectory: string;
  homeDirectory: string;
  appName: string;
  platform: NodeJS.Platform;
};

/**
 * Every push the runtime makes to whoever is watching it. On Desktop each method is one
 * renderer IPC channel; a remote host will carry the same calls over its protocol instead.
 */
export type HostEventSink = {
  streamEvent(event: ChatStreamEvent): void;
  sessionSummary(summary: ChatSessionSummary): void;
  /** `statusChanged` is false when only the event's detail moved, such as its background jobs. */
  sessionStatus(event: ChatSessionStatusEvent, statusChanged: boolean): void;
  queueChanged(event: ChatQueueEvent): void;
  taskDecisions(decisions: PendingTaskDecision[]): void;
  loopChanged(sessionId: string, state: LoopState | null): void;
};

/**
 * The one encryption port every secret store and the auth vault take. Electron's safeStorage
 * satisfies it on Desktop (secrets/appSecretCipher.ts); a headless host, which has no keychain
 * session, uses host/auth/permissionProtectedCipher.ts. Kept a port so a store can be tested
 * without Electron and the "only after app ready" rule stays a construction-order concern.
 */
export type SecretCipher = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** True for a blob in an older format that the store should re-save (see secrets/appSecretCipher.ts). */
  needsReencrypt?(encrypted: Buffer): boolean;
  /**
   * Declared only by a cipher that does not encrypt and relies on the file's owner-only
   * permissions instead. Without it, the auth vault keeps tokens in memory only when the
   * cipher cannot encrypt.
   */
  readonly atRestProtection?: 'file-permissions';
};

export type HostAuth = Pick<AuthService, 'getApiClient' | 'getState'>;

/** Capabilities that need a desktop session (windows, the screen, a GPU image decoder); a headless host has none. */
export type HostMachineTools = {
  browser?: ChatServiceDeps['browser'];
  screen?: ChatServiceDeps['screen'];
  simulator?: ChatServiceDeps['simulator'];
  model?: ChatServiceDeps['model'];
  prepareImage?: ChatServiceDeps['prepareImage'];
};

/**
 * The folders the agent's tools may never touch. Required rather than optional: the data
 * directory holds the auth vault, so every runtime protects it. Build them with
 * hostProtectedLocations.
 */
export type HostProtection = {
  /** Folders no tool may read or write. */
  tool: ProtectedLocations;
  /** Folders no permission rule may cover. */
  permission: ProtectedLocations;
};

export type HostPullRequests = Pick<PrMonitor, 'bindForAgent' | 'dismiss' | 'forget'>;

/**
 * Collaborators the app still builds and the runtime only passes through to the chat service.
 * Each is either Electron-bound at construction or serves a feature beyond the core session
 * operations; moving one into the runtime removes it from here.
 */
export type HostCollaborators = Pick<
  ChatServiceDeps,
  | 'attachments'
  | 'composerDrafts'
  | 'models'
  | 'modelSettings'
  | 'spawnLocation'
  | 'permissions'
  | 'capabilities'
  | 'media'
  | 'videoJobs'
  | 'sidebarSections'
  | 'mcp'
  | 'history'
  | 'local'
  | 'artifacts'
  | 'skills'
  | 'spareWorktrees'
  | 'shareableUnderProtected'
> & {
  /** Read per call: the monitor is built from the runtime's own store and service, so it exists only after them. */
  pullRequests?(): HostPullRequests;
};

export type HostHooks = Pick<ChatServiceDeps, 'sessionClosed' | 'releaseSessionTerminals'> & {
  observeStream?(event: ChatStreamEvent): void;
};
