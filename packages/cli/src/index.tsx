/* eslint-disable @typescript-eslint/no-explicit-any */

// Suppress punycode deprecation warning from dependencies
process.removeAllListeners('warning');
process.on('warning', warning => {
  // Only suppress punycode deprecation warnings
  if (warning.name === 'DeprecationWarning' && warning.message.includes('punycode')) {
    return;
  }
  console.warn(warning);
});

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, promises as fs } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { App, TrustLocationSelector, RewindSelector, SessionSelector, EnvironmentPicker } from './components';
import type { PermissionResponse, EnvChoice } from './components';
import type { UserQuestionPayload, UserQuestionResponse } from '@bike4mind/services';
import { LoginFlow } from './components/LoginFlow';
import { SessionStore, ConfigStore, CommandHistoryStore } from './storage';
import type { Session, Message, CliConfig, ProjectConfig, ProjectLocalConfig, SessionHandoff } from './storage';
import { CheckpointStore } from './storage/CheckpointStore.js';
import { ImageStore } from './storage/ImageStore.js';
import { CustomCommandStore } from './storage/CustomCommandStore.js';
import { RemoteSkillSource } from './storage/RemoteSkillSource.js';
import { ReActAgent } from '@bike4mind/agents';
import { isReadOnlyTool } from './config/toolSafety.js';
import { buildSystemPrompt } from './core/prompts';
import { getPlanModeFilePath } from './utils/planMode.js';
import {
  PermissionManager,
  type AgentContext,
  resolveApiEndpoint,
  requireApiUrl,
  ApiEndpointUnconfiguredError,
  getEnvironmentName,
  getCreditsUrl,
  parseApiUrl,
  processFileReferences,
  formatStep,
  extractCompactInstructions,
} from './utils';
import { getTokenCounter } from './utils/tokenCounter.js';
import { buildCompactionPrompt, createCompactedSession } from './utils/compaction.js';
import { getProcessHooks } from './utils/processHooks.js';
import {
  buildHandoffPrompt,
  parseHandoffResponse,
  formatHandoffOutput,
  injectHandoffMessage,
  SHORT_SESSION_THRESHOLD,
  buildLocalHandoff,
  writeLocalHandoffFile,
  isLlmUnavailableError,
} from './utils/handoff.js';
import { substituteArguments } from './utils/argumentSubstitution.js';
import { McpManager } from './utils/mcpAdapter';
import { ImageRenderer } from './utils/imageRenderer.js';
import { MessageBuilder } from './utils/messageBuilder.js';

/**
 * Render the first question from a UserQuestion payload as a 240-char-capped
 * summary for tavern status events. Returns undefined if the payload has no
 * questions (defensive: payload.questions[0]?.question is typed string but
 * the array itself can be empty).
 */
function summarizeUserQuestion(payload: UserQuestionPayload): string | undefined {
  const first = payload.questions?.[0]?.question;
  return first ? first.slice(0, 240) : undefined;
}

/**
 * Render the B4M ASCII banner with an optional startup log column to the right.
 * Used on startup and after /clear so the user always sees the banner at the
 * top of a fresh session.
 */
function renderBanner(startupLog: string[] = []): void {
  const bannerLines: Array<{ text: string; ansi: string }> = [
    { text: '██████╗ ██╗  ██╗███╗   ███╗', ansi: '\x1b[36m\x1b[1m' },
    { text: '██╔══██╗██║  ██║████╗ ████║', ansi: '\x1b[36m\x1b[1m' },
    { text: '██████╔╝███████║██╔████╔██║', ansi: '\x1b[36m\x1b[1m' },
    { text: '██╔══██╗╚════██║██║╚██╔╝██║', ansi: '\x1b[36m\x1b[1m' },
    { text: '██████╔╝     ██║██║ ╚═╝ ██║', ansi: '\x1b[36m\x1b[1m' },
    { text: '╚═════╝      ╚═╝╚═╝     ╚═╝', ansi: '\x1b[36m\x1b[1m' },
    { text: '', ansi: '' },
    { text: `v${packageJson.version} - AI-Powered CLI`, ansi: '\x1b[2m' },
    { text: '/help for more information', ansi: '\x1b[2m' },
  ];
  const bannerWidth = 30;
  const termWidth = process.stdout.columns || 80;
  const rightColWidth = termWidth - bannerWidth - 2;

  const truncate = (str: string, max: number) => {
    if (str.length > max) return str.slice(0, max - 1) + '…';
    return str;
  };

  const totalLines = Math.max(bannerLines.length, startupLog.length);
  for (let i = 0; i < totalLines; i++) {
    const banner = bannerLines[i];
    const leftText = banner?.text || '';
    const leftAnsi = banner?.ansi || '';
    const right = startupLog[i] || '';
    const coloredLeft = leftText ? `${leftAnsi}${leftText}\x1b[0m` : '';
    const gap = ' '.repeat(bannerWidth - leftText.length + 2);
    console.log(coloredLeft + gap + truncate(right, rightColWidth));
  }
}

import { useCliStore } from './store';
import { ServerLlmBackend, isTransientNetworkError } from './llm/ServerLlmBackend';
import { WebSocketLlmBackend } from './llm/WebSocketLlmBackend';
import { NotifyingLlmBackend } from './llm/NotifyingLlmBackend.js';
import { MultiLlmBackend } from './llm/MultiLlmBackend.js';
import { FallbackLlmBackend } from './llm/FallbackLlmBackend.js';
import { type ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { WebSocketConnectionManager } from './ws/WebSocketConnectionManager';
import { setWebSocketToolExecutor, registerFeatureModuleTools, clearFeatureModuleTools } from './llm/ToolRouter';
import { ApiClient } from './auth/ApiClient';
import { warmFileCache } from './utils/fileSearch.js';
import { isAxiosError } from 'axios';
import { logger } from './utils/Logger';
import { startPeonNotifier, emitPeonSessionEnd } from './utils/peonNotifier';
import packageJson from '../package.json';
import type { ICreditTransactionResponse, ModelInfo } from '@bike4mind/common';
import { CREDIT_DEDUCT_TRANSACTION_TYPES, ChatModels } from '@bike4mind/common';
import { USAGE_DAYS, MODEL_NAME_COLUMN_WIDTH, USAGE_CACHE_TTL } from './config/constants';
import { mergeCommands } from './config/commands.js';
import { SubagentOrchestrator } from './agents/SubagentOrchestrator.js';
import { AgentStore } from './agents/AgentStore.js';
import { createAgentDelegateTool } from './agents/delegateTool.js';
import { createDynamicAgentTool } from './agents/dynamicAgentTool.js';
import { BackgroundAgentManager } from './agents/BackgroundAgentManager.js';
import { createBackgroundAgentTools } from './agents/backgroundTools.js';
import { createCoordinateTaskTool } from './agents/coordinatorTool.js';
import { parseAgentConfig } from './tools/skillTool.js';
import { deferredToolRegistry } from './tools/deferredToolRegistry.js';
import { createToolSearchTool } from './tools/toolSearchTool.js';
import {
  createWriteTodosTool,
  createTodoStore,
  createSkillTool,
  createFindDefinitionTool,
  createGetFileStructureTool,
  createDecisionLogTool,
  createDecisionStore,
  formatDecisionsOutput,
  createBlockerTools,
  createBlockerStore,
  formatBlockersOutput,
  createReviewGateTool,
  createReviewGateStore,
  formatReviewGatesOutput,
} from './tools';
import { buildSkillsPromptSection } from './core/skillsPrompt';
import { checkForUpdate } from './utils/updateChecker.js';
import { FeatureModuleRegistry } from './features/FeatureModuleRegistry.js';
import { TavernModule } from './features/tavern/index.js';
import { bridgePresence } from './features/bridgePresence/index.js';
import { buildLlmBackend } from './bootstrap/buildLlmBackend.js';
import { buildSandbox } from './bootstrap/buildSandbox.js';
import { buildSupportingStores } from './bootstrap/buildSupportingStores.js';
import { buildAgent } from './bootstrap/buildAgent.js';
import { wireAgentEvents } from './bootstrap/wireAgentEvents.js';

interface PermissionPromptState {
  id: string;
  toolName: string;
  args: unknown;
  preview?: string;
  canBeTrusted: boolean;
  resolve: (response: { action: PermissionResponse }) => void;
}

interface TrustLocationSelectorState {
  toolName: string;
  resolve: (location: 'local' | 'project' | 'global' | null) => void;
}

interface RewindSelectorState {
  resolve: (messageIndex: number | null) => void;
}

interface SessionSelectorState {
  sessions: Session[];
  resolve: (session: Session | null) => void;
}

interface CliState {
  // NOTE: the active session is NOT stored here. It lives solely in the Zustand
  // store (`useCliStore`) as the single source of truth. Read it imperatively
  // via `useCliStore.getState().session` and write it via `setStoreSession`.
  // Rendering subscribes to the store directly (see App.tsx). See issue #227.
  sessionStore: SessionStore;
  configStore: ConfigStore;
  commandHistoryStore: CommandHistoryStore;
  customCommandStore: CustomCommandStore;
  imageStore: ImageStore | null; // Lazy-loaded on first image upload
  imageRenderer: ImageRenderer;
  messageBuilder: MessageBuilder | null;
  agent: ReActAgent | null;
  mcpManager: McpManager | null;
  permissionManager: PermissionManager | null;
  permissionPrompt: PermissionPromptState | null;
  trustLocationSelector: TrustLocationSelectorState | null;
  rewindSelector: RewindSelectorState | null;
  sessionSelector: SessionSelectorState | null;
  showLoginFlow?: boolean;
  showEnvironmentPicker?: boolean; // First-run backend picker when no endpoint is configured
  config?: CliConfig; // Cached config for synchronous access
  availableModels?: ModelInfo[]; // Models fetched from API at startup
  prefillInput?: string; // Pre-fill input (e.g., from rewind)
  orchestrator: SubagentOrchestrator | null; // Subagent orchestrator for delegation
  agentStore: AgentStore | null; // Store for agent definitions
  abortController: AbortController | null; // Current operation abort controller
  contextContent: string; // Raw CLAUDE.md content for compact instructions extraction
  backgroundManager: BackgroundAgentManager | null; // Background agent manager for grouped notifications
  sandboxOrchestrator: import('./sandbox/SandboxOrchestrator.js').SandboxOrchestrator | null; // Sandbox orchestrator for OS-level isolation
  wsManager: WebSocketConnectionManager | null; // WebSocket connection manager for streaming
  checkpointStore: CheckpointStore | null; // File change checkpointing for undo/restore
  additionalDirectories: string[]; // Additional directories for file access (from --add-dir or /add-dir)
  featureRegistry: FeatureModuleRegistry | null; // Opt-in feature module registry
}

// Global state for exit handling (outside React for immediate response)
let exitTimestamp: number | null = null;
// Re-entrance guard: once the exit chain (handoff prompt -> cleanup -> exit) is
// running, further Ctrl+C presses must not start a second concurrent chain.
let exitInProgress = false;
const EXIT_TIMEOUT_MS = 2000; // 2 seconds like Claude Code
// Bound the handoff prompt so a stuck UI / abandoned terminal can never hang
// the exit chain. Hoisted to module-level so tests can reference it.
const EXIT_HANDOFF_PROMPT_TIMEOUT_MS = 30_000;

// Cache for usage data to avoid redundant API calls
interface UsageCacheEntry {
  data: {
    currentCredits: number;
    transactions: ICreditTransactionResponse[];
  };
  timestamp: number;
}

let usageCache: UsageCacheEntry | null = null;

function CliApp() {
  const { exit } = useApp();
  const imageRenderer = new ImageRenderer();

  const [state, setState] = useState<CliState>({
    sessionStore: new SessionStore(),
    configStore: new ConfigStore(),
    commandHistoryStore: new CommandHistoryStore(),
    customCommandStore: new CustomCommandStore(),
    imageStore: null as any, // Lazy-loaded on first use
    imageRenderer,
    messageBuilder: null,
    agent: null,
    mcpManager: null,
    permissionManager: null,
    permissionPrompt: null,
    trustLocationSelector: null,
    rewindSelector: null,
    sessionSelector: null,
    orchestrator: null,
    agentStore: null,
    abortController: null,
    contextContent: '',
    backgroundManager: null,
    sandboxOrchestrator: null,
    wsManager: null,
    checkpointStore: null,
    additionalDirectories: [],
    featureRegistry: null,
  });

  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);

  // Guard to prevent race condition when initializing ImageStore
  const imageStoreInitPromise = useRef<Promise<ImageStore> | null>(null);

  // Durable workflow stores - refs so they're accessible across all callbacks
  const decisionStoreRef = useRef(createDecisionStore());
  const blockerStoreRef = useRef(createBlockerStore());
  const reviewGateStoreRef = useRef(createReviewGateStore());

  // Use Zustand store for UI state. The session is the single source of truth;
  // handlers read the latest value via `useCliStore.getState().session` and
  // write via `setStoreSession`. Message rendering subscribes to the store
  // directly in App.tsx, so CliApp deliberately does NOT subscribe to the
  // session here (that would re-render the whole app on every streaming step).
  const setStoreSession = useCliStore(state => state.setSession);
  const enqueuePermissionPrompt = useCliStore(state => state.enqueuePermissionPrompt);
  const enqueueUserQuestionPrompt = useCliStore(state => state.enqueueUserQuestionPrompt);
  const dequeueUserQuestionPrompt = useCliStore(state => state.dequeueUserQuestionPrompt);
  const enqueueReviewGatePrompt = useCliStore(state => state.enqueueReviewGatePrompt);
  const dequeueReviewGatePrompt = useCliStore(state => state.dequeueReviewGatePrompt);
  const setShowConfigEditor = useCliStore(state => state.setShowConfigEditor);
  const setShowMcpViewer = useCliStore(state => state.setShowMcpViewer);
  const setExitRequested = useCliStore(state => state.setExitRequested);

  // Cleanup function to close all handles and allow natural process exit
  const performCleanup = useCallback(async () => {
    const cleanupTasks: Promise<void>[] = [];

    // Save session
    const session = useCliStore.getState().session;
    if (session) {
      cleanupTasks.push(
        state.sessionStore.save(session).catch(err => {
          logger.debug(`[CLEANUP] Session save error: ${err.message}`);
        })
      );
    }

    // Disconnect MCP - this closes all open connections
    if (state.mcpManager) {
      cleanupTasks.push(
        state.mcpManager.disconnect().catch(err => {
          logger.debug(`[CLEANUP] MCP disconnect error: ${err.message}`);
        })
      );
    }

    // Dispose feature modules (unsubscribes WS handlers)
    if (state.featureRegistry) {
      state.featureRegistry.disposeAll();
    }

    // Disconnect WebSocket
    if (state.wsManager) {
      state.wsManager.disconnect();
      setWebSocketToolExecutor(null);
    }

    // Tear down tavern presence - best-effort disconnect so the sprite
    // despawns promptly rather than waiting for the bridge's WS sweep.
    cleanupTasks.push(
      bridgePresence.stop('cli_exit').catch(err => {
        logger.debug(`[CLEANUP] Bridge presence stop error: ${err.message}`);
      })
    );

    // Remove all event listeners from agent
    if (state.agent) {
      state.agent.removeAllListeners();
    }

    // Close image store database connection
    if (state.imageStore) {
      try {
        state.imageStore.close();
      } catch (err) {
        logger.debug(`[CLEANUP] Image store close error: ${err}`);
      }
    }

    // Wait for cleanup with timeout
    await Promise.race([
      Promise.all(cleanupTasks),
      new Promise(resolve => setTimeout(resolve, 500)), // 500ms timeout
    ]);

    // Force exit after a short delay if process hasn't exited naturally
    // This handles any remaining open handles we can't close
    setTimeout(() => {
      process.exit(0);
    }, 100);
  }, [
    // session is read fresh from the store (useCliStore.getState()), so it is
    // intentionally not a dependency here.
    state.sessionStore,
    state.mcpManager,
    state.agent,
    state.imageStore,
    state.wsManager,
    state.featureRegistry,
  ]);

  // Handle Ctrl+C and ESC using Ink's useInput
  useInput((input, key) => {
    // Check for ESC key - abort current operation or clear paste
    if (key.escape) {
      const store = useCliStore.getState();
      if (store.pastedContent) {
        store.clearPaste();
        return;
      }
      if (state.abortController) {
        logger.debug('[ABORT] ESC pressed - aborting current operation...');
        state.abortController.abort();
        setState(prev => ({ ...prev, abortController: null }));
        // Clear thinking state immediately so UI updates
        useCliStore.getState().setIsThinking(false);
        // Drop any queued messages - ESC means "stop everything", not
        // "skip this one and continue with the next".
        useCliStore.getState().clearMessageQueue();
      } else {
        // No active operation, but the user may still want to clear a
        // pending queue (e.g. they queued messages, the current finished
        // before they pressed ESC, and now the queue is about to drain).
        useCliStore.getState().clearMessageQueue();
      }
      return;
    }

    // Check for Ctrl+C
    if (key.ctrl && input === 'c') {
      // Re-entrance guard: a previous Ctrl+C has already kicked off the exit
      // chain. Ignore further presses so we don't open a second handoff
      // prompt or run cleanup twice.
      if (exitInProgress) return;

      const now = Date.now();

      // Check if this is within timeout window of first Ctrl+C
      if (exitTimestamp && now - exitTimestamp < EXIT_TIMEOUT_MS) {
        // Second Ctrl+C within timeout: cleanup and exit
        logger.debug('[EXIT] Second Ctrl+C - cleaning up and exiting...');
        exitInProgress = true;
        exitTimestamp = null;
        // Don't await maybePromptExitHandoff outside async context; chain it.
        // performCleanup has built-in setTimeout to force exit if cleanup hangs.
        maybePromptExitHandoff()
          .catch(err => {
            logger.debug(`[EXIT] Handoff prompt error: ${err instanceof Error ? err.message : String(err)}`);
          })
          .then(() => performCleanup())
          .then(() => {
            exit(); // Let Ink unmount and process exit naturally
          });
      } else {
        // First Ctrl+C or timeout expired: clear input, show warning and reset timer
        logger.debug('[EXIT] First Ctrl+C - press again to exit');

        // Clear input and paste state if there's any text
        const store = useCliStore.getState();
        if (store.inputValue.length > 0 || store.pastedContent) {
          store.clearInput();
        }

        exitTimestamp = now;
        setExitRequested(true);

        // Reset warning after timeout
        setTimeout(() => {
          exitTimestamp = null;
          setExitRequested(false);
        }, EXIT_TIMEOUT_MS);
      }
    }
  });

  // Initialize CLI (extracted from useEffect to make it callable from login flow)
  const init = useCallback(async () => {
    try {
      // Collect startup messages for two-column display
      const startupLog: string[] = [];

      // Load configuration
      const config = await state.configStore.load();

      // Load additional directories from config and --add-dir flag
      const configDirs = await state.configStore.getAdditionalDirectories();
      const flagDirs = process.env.B4M_ADDITIONAL_DIRS ? JSON.parse(process.env.B4M_ADDITIONAL_DIRS) : [];
      const additionalDirectories = [...new Set([...configDirs, ...flagDirs])]; // Deduplicate

      // Load command history
      const history = await state.commandHistoryStore.load();
      setCommandHistory(history);

      // Load custom commands
      try {
        await state.customCommandStore.loadCommands();
      } catch (error) {
        console.warn('Failed to load custom commands:', error instanceof Error ? error.message : String(error));
      }

      // Validate authentication tokens on startup - auto-trigger login if needed
      const authTokens = await state.configStore.getAuthTokens();
      const tokenExpired = authTokens ? new Date(authTokens.expiresAt) <= new Date() : false;

      if (!authTokens || tokenExpired) {
        // Both paths lead to the device-authorization login flow, which needs a
        // configured endpoint. When there isn't one (a published, unbranded fork
        // with no baked default), let the user pick a backend interactively
        // rather than dead-ending the OAuth flow on an empty URL.
        const endpoint = resolveApiEndpoint(config.apiConfig);
        if (endpoint.status === 'unconfigured') {
          setState(prev => ({ ...prev, showEnvironmentPicker: true, config }));
          return;
        }

        if (tokenExpired) {
          // Returning user with expired token - auto-trigger re-authentication
          console.log("\n🔐 Your session has expired. Let's re-authenticate.\n");
          await state.configStore.clearAuthTokens();
        } else {
          // First-time user or logged out - auto-trigger login flow
          console.log('\n🔐 Welcome to B4M CLI! Authentication is required to get started.\n');
        }

        // Make the target backend obvious before login - especially the
        // source-mode default, which would otherwise silently point contributors
        // at localhost when they might have expected production.
        if (endpoint.source === 'dev-default') {
          console.log(
            `🔧 No endpoint configured; defaulting to the local dev server (${endpoint.url}).\n` +
              '   Use `b4m --prod` or `b4m --api-url <url>` to target a different backend.\n'
          );
        }

        setState(prev => ({ ...prev, showLoginFlow: true, config }));
        return;
      }

      // Past the gate above, authTokens is present and unexpired.
      const expiresAt = new Date(authTokens.expiresAt);
      const daysUntilExpiry = Math.floor((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      startupLog.push(`✅ Authenticated (expires in ${daysUntilExpiry} day${daysUntilExpiry !== 1 ? 's' : ''})`);

      // Create API client for server-side LLM calls. Past the login gate above
      // the endpoint is guaranteed configured; requireApiUrl fails loud if not.
      const apiBaseURL = requireApiUrl(config.apiConfig);
      const envName = getEnvironmentName(config.apiConfig);

      // Always surface the active API environment so it's obvious which
      // backend (Production / Local Dev / Self-Hosted) the session is talking to.
      startupLog.unshift(`🌍 API Environment: ${envName} (${apiBaseURL})`);

      const apiClient = new ApiClient(apiBaseURL, state.configStore);

      // Layer B4M-web skills on top of the local skill files already loaded
      // above. Local files keep precedence - `mergeRemoteCommands()` only
      // inserts remote entries whose names aren't already taken. Skipped when
      // the user opts out via the `--no-remote-skills` flag or the
      // `preferences.enableRemoteSkills: false` config option.
      const remoteSkillsEnabled =
        process.env.B4M_NO_REMOTE_SKILLS !== '1' && config.preferences.enableRemoteSkills !== false;
      if (remoteSkillsEnabled) {
        try {
          state.customCommandStore.setRemoteSource(new RemoteSkillSource(apiClient));
          await state.customCommandStore.mergeRemoteCommands();
          const remoteCount = state.customCommandStore.getCommandsBySource('remote').length;
          if (remoteCount > 0) {
            startupLog.push(`☁️  Synced ${remoteCount} skill${remoteCount === 1 ? '' : 's'} from B4M web`);
          }
        } catch (error) {
          // Remote skill sync is a productivity boost, not a critical path -
          // a fetch failure here must never block startup.
          console.warn('Failed to sync remote skills:', error instanceof Error ? error.message : String(error));
        }
      }

      // Token getter for WebSocket auth (shared by WS manager and backend)
      const tokenGetter = async (): Promise<string | null> => {
        const tokens = await state.configStore.getAuthTokens();
        return tokens?.accessToken ?? null;
      };

      // Build the LLM backend: WebSocket-first transport (bypasses CloudFront
      // 20s timeout) with SSE fallback, optional Ollama multiplexing, and the
      // resolved default model. The Keep handler is registered inside the WS
      // path (see buildLlmBackend).
      const { llm, wsManager, models, modelInfo } = await buildLlmBackend({
        config,
        apiClient,
        tokenGetter,
        startupLog,
      });

      // Create new session with the ACTUAL model being used.
      // Host board-pane session pinning (claude-compat): --resume reopens an
      // existing conversation by uuid; --session-id pins a FRESH session to a fixed
      // uuid (so a later --resume finds it). Stage launches set neither -> random uuid.
      const pinnedSessionId = process.env.B4M_SESSION_ID;
      const resumeSessionId = process.env.B4M_RESUME_ID;
      let newSession: Session;
      if (resumeSessionId) {
        const resumed = await state.sessionStore.load(resumeSessionId);
        if (!resumed) {
          // Exact string the host matches to auto-heal a bricked pane.
          console.error(`No conversation found with session ID ${resumeSessionId}`);
          process.exit(1);
        }
        newSession = resumed;
      } else {
        newSession = {
          id: pinnedSessionId || uuidv4(),
          name: `Session ${new Date().toLocaleString()}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          model: modelInfo.id, // Use actual model, not config.defaultModel
          messages: [],
          metadata: {
            totalTokens: 0,
            totalCost: 0,
            toolCallCount: 0,
          },
        };
      }

      // Initialize debug logger with session ID
      await logger.initialize(newSession.id);

      // Enable verbose logging if B4M_VERBOSE env var is set
      logger.setVerbose(process.env.B4M_VERBOSE === '1');

      logger.debug('=== Session Configuration Complete ===');

      // Cleanup old debug logs (async, don't await)
      logger.cleanupOldLogs().catch(() => {
        // Silent fail
      });

      // Create silent logger to prevent backend logs from causing Ink re-renders
      const silentLogger = {
        log: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      };

      // Initialize permission manager with trusted tools and denied tools from config
      const permissionManager = new PermissionManager(
        config.trustedTools || [],
        undefined, // customCategories (not used yet)
        config.tools.disabled || [] // denied tools from project config
      );

      // Initialize the sandbox orchestrator for OS-level filesystem isolation.
      // checkpointStore is created here in the shell (it's also needed by the
      // CLI tools and the subagent orchestrator); buildSandbox runs its .init()
      // in parallel with the sandbox runtime creation.
      const checkpointProjectDir = state.configStore.getProjectConfigDir() || process.cwd();
      const checkpointStore = new CheckpointStore(checkpointProjectDir);
      const { sandboxOrchestrator } = await buildSandbox({
        config,
        sessionId: newSession.id,
        permissionManager,
        checkpointStore,
      });

      // Create permission prompt function (queue-based for concurrent agent support)
      let permissionPromptCounter = 0;
      const promptFn = (toolName: string, args: unknown, preview?: string) => {
        return new Promise<{ action: PermissionResponse }>(resolve => {
          // Process-hook (host action_required signal): an interactive permission
          // prompt is now blocking - fire Notification/permission_prompt (writes sentinel).
          void getProcessHooks()?.fireNotificationPermissionPrompt(toolName);
          const canBeTrusted = permissionManager.canBeTrusted(toolName);
          const id = `perm-${++permissionPromptCounter}`;
          const prompt = { id, toolName, args, preview, canBeTrusted, resolve };
          setState(prev => ({
            ...prev,
            permissionManager,
          }));
          enqueuePermissionPrompt(prompt);
          // Tavern: surface the prompt as a permission_request row + flip the
          // sprite to awaiting_permission so the chime/toast/tab-badge fire.
          // The `id` is reused as `requestId` so a tavern Allow/Deny round-trips
          // back through `onResolvePermission` and finds this prompt.
          // Cap to the schema's 4000-char limit (`permission_request.input` in
          // common/schemas/actions.ts) - long diff previews would otherwise
          // fail Zod parsing on the server and the event would be dropped.
          let summary: string | undefined;
          if (preview) {
            summary = preview.slice(0, 4000);
          } else {
            try {
              summary = JSON.stringify(args).slice(0, 4000);
            } catch {
              summary = undefined;
            }
          }
          void bridgePresence.emitEvent({
            type: 'permission_request',
            requestId: id,
            toolName,
            input: summary,
          });
          void bridgePresence.emitEvent({
            type: 'status',
            status: 'awaiting_permission',
            text: `${toolName} permission requested`.slice(0, 240),
          });
        });
      };

      // Create user question function (queue-based, mirrors promptFn pattern)
      let userQuestionCounter = 0;
      const userQuestionFn = (payload: UserQuestionPayload) => {
        return new Promise<UserQuestionResponse>(resolve => {
          const id = `uq-${++userQuestionCounter}`;
          enqueueUserQuestionPrompt({ id, payload, resolve });
          // Tavern: user-question payloads are richer than Allow/Deny so the
          // modal can't render an inline resolver yet - but the awaiting_input
          // status still drives the chime/toast/tab-badge so the user knows to
          // come back to the terminal.
          void bridgePresence.emitEvent({
            type: 'status',
            status: 'awaiting_input',
            text: summarizeUserQuestion(payload),
          });
        });
      };

      // Create review gate function (queue-based, mirrors promptFn pattern).
      // Pauses execution until the user explicitly approves or rejects.
      const reviewGateFn = (params: {
        id: string;
        description: string;
        options?: string[];
        recommendation?: string;
      }) => {
        return new Promise<{ decision: 'approved' | 'rejected'; note?: string }>(resolve => {
          enqueueReviewGatePrompt({
            id: params.id,
            description: params.description,
            options: params.options,
            recommendation: params.recommendation,
            resolve,
          });
          void bridgePresence.emitEvent({
            type: 'status',
            status: 'awaiting_input',
            text: `Review gate: ${params.description}`.slice(0, 240),
          });
        });
      };

      // Create agent context for observation tracking
      const agentContext: AgentContext = {
        currentAgent: null,
        observationQueue: [],
      };

      // Build CLI tools, MCP/agent/context stores, the subagent orchestrator,
      // and the background-agent manager. Background-agent status callbacks are
      // wired to Zustand here (kept out of the pure module).
      const {
        mcpManager,
        agentStore,
        contextResult,
        mcpTools,
        loadedB4mTools,
        deferredB4mTools,
        orchestrator,
        backgroundManager,
      } = await buildSupportingStores({
        config,
        llm,
        modelId: modelInfo.id,
        permissionManager,
        apiClient,
        configStore: state.configStore,
        customCommandStore: state.customCommandStore,
        checkpointStore,
        sandboxOrchestrator,
        additionalDirectories,
        agentContext,
        promptFn,
        userQuestionFn,
        startupLog,
        silentLogger,
        onBackgroundStatusChange: job => {
          useCliStore.getState().upsertBackgroundAgent(job);
        },
        onGroupCompletion: (notification, groupDescription) => {
          useCliStore.getState().addCompletedGroupNotification(notification, groupDescription);
          // Always set the trigger - the useEffect will wait for isThinking to be false
          useCliStore.getState().setPendingBackgroundTrigger(true);
        },
        onSubagentUsage: usage => {
          useCliStore.getState().recordSubagentUsage({ tokens: usage.totalTokens, credits: usage.totalCredits });
        },
      });

      // Create agent_delegate tool (with background support)
      const agentDelegateTool = createAgentDelegateTool(orchestrator, agentStore, newSession.id, backgroundManager);

      // Create create_dynamic_agent tool (experimental, gated by config flag)
      const dynamicAgentTool =
        config.preferences.enableDynamicAgentCreation === true
          ? createDynamicAgentTool(orchestrator, newSession.id, backgroundManager)
          : null;

      // Create background agent control tools
      const backgroundTools = createBackgroundAgentTools(backgroundManager);

      // Wrap with FallbackLlmBackend if fallback models are configured
      const llmWithFallback =
        config.fallbackModels && config.fallbackModels.length > 0
          ? new FallbackLlmBackend(llm, config.fallbackModels, (fromModel, toModel, error) => {
              logger.warn(`⚠️  Model "${fromModel}" failed (${error.message}) — falling back to "${toModel}"`);
            })
          : llm;

      // Wrap LLM for main agent: injects background agent notifications before each call
      const notifyingLlm = new NotifyingLlmBackend(llmWithFallback, backgroundManager);

      // Create write_todos tool for task tracking
      const todoStore = createTodoStore();
      const writeTodosTool = createWriteTodosTool(todoStore);

      // Create durable workflow tools (Q-inspired agentic patterns)
      const decisionLogTool = createDecisionLogTool(decisionStoreRef.current);
      const blockerTools = createBlockerTools(blockerStoreRef.current);
      const reviewGateTool = createReviewGateTool(reviewGateStoreRef.current, reviewGateFn);

      // Initialize workflow stores from resumed session if available
      if (newSession.metadata.workflow) {
        decisionStoreRef.current.decisions = [...newSession.metadata.workflow.decisions];
        blockerStoreRef.current.blockers = [...newSession.metadata.workflow.blockers];
        reviewGateStoreRef.current.reviewGates = [...(newSession.metadata.workflow.reviewGates ?? [])];
      } else {
        decisionStoreRef.current.decisions = [];
        blockerStoreRef.current.blockers = [];
        reviewGateStoreRef.current.reviewGates = [];
      }

      // Create skill tool for AI-driven skill invocation (unless disabled)
      const enableSkillTool = config.preferences.enableSkillTool !== false;
      const skillTool = enableSkillTool
        ? createSkillTool({
            customCommandStore: state.customCommandStore,
            subagentOrchestrator: orchestrator,
            sessionId: newSession.id,
          })
        : null;

      // Create find_definition tool for fast symbol lookup
      const findDefinitionTool = createFindDefinitionTool();

      // Create get_file_structure tool for AST-based code overview
      const getFileStructureTool = createGetFileStructureTool();

      // Create feature module registry and conditionally register modules
      const featureRegistry = new FeatureModuleRegistry();
      if (config.features?.tavern) {
        featureRegistry.register(
          new TavernModule(
            apiClient,
            entry => useCliStore.getState().addTavernLogEntry(entry),
            () => useCliStore.getState().tavernActivityLog
          )
        );
      }

      // Register feature module tool names with ToolRouter so they route as local tools
      const featureModuleToolNames = featureRegistry.getAllToolNames();
      if (featureModuleToolNames.length > 0) {
        registerFeatureModuleTools(featureModuleToolNames);
      }

      // Register feature module WS handlers
      if (wsManager && featureRegistry.hasModules) {
        featureRegistry.registerAllWsHandlers(wsManager);
      }

      // Combine B4M, MCP, and CLI-specific tools
      const cliTools = [
        agentDelegateTool,
        ...backgroundTools,
        writeTodosTool,
        decisionLogTool,
        ...blockerTools,
        reviewGateTool,
        findDefinitionTool,
        getFileStructureTool,
      ];
      if (skillTool) {
        cliTools.push(skillTool);
      }
      if (dynamicAgentTool) {
        cliTools.push(dynamicAgentTool);
      }

      // Create coordinate_task tool (gated by config flag)
      if (config.preferences.enableCoordinatorMode === true) {
        const coordinateTaskTool = createCoordinateTaskTool(orchestrator, agentStore, newSession.id);
        cliTools.push(coordinateTaskTool);
      }

      const featureTools = featureRegistry.getAllTools();
      // Holder so the tool_search closure can resolve to the agent's live
      // context.tools array (assigned below after the agent is constructed).
      // Pushing into context.tools makes newly-loaded schemas callable in
      // the next ReAct iteration - see b4m-core/agents/src/ReActAgent.ts:202.
      const agentToolsRef: { current: ICompletionOptionTools[] | null } = { current: null };
      const toolSearchTool =
        deferredToolRegistry.size() > 0
          ? createToolSearchTool(() => {
              if (!agentToolsRef.current) {
                throw new Error('tool_search invoked before agent context was wired');
              }
              return agentToolsRef.current;
            })
          : null;
      const allTools = [...loadedB4mTools, ...(toolSearchTool ? [toolSearchTool] : []), ...cliTools, ...featureTools];

      startupLog.push(`📂 Working directory: ${process.cwd()}`);
      if (additionalDirectories.length > 0) {
        startupLog.push(`📁 Additional directories: ${additionalDirectories.length}`);
      }
      if (skillTool) {
        const skillCount = state.customCommandStore.getCommandCount();
        if (skillCount > 0) {
          startupLog.push(`🛠️ Skill tool enabled (${skillCount} skills available)`);
        }
      }
      if (dynamicAgentTool) {
        startupLog.push(`🧪 Dynamic agent creation enabled (experimental)`);
      }
      if (featureRegistry.hasModules) {
        const moduleNames = featureRegistry.getModuleNames().join(', ');
        startupLog.push(`🏰 Feature modules: ${moduleNames} (${featureTools.length} tools)`);
      }
      logger.debug(
        `Total tools available to agent: ${allTools.length} (${loadedB4mTools.length} B4M loaded + ${cliTools.length} CLI + ${featureTools.length} feature + ${toolSearchTool ? 1 : 0} tool_search, ${deferredB4mTools.length} B4M + ${mcpTools.length} MCP deferred)`
      );

      if (contextResult.globalContext) {
        startupLog.push(`📄 Global context: ${contextResult.globalContext.filename}`);
      }
      if (contextResult.projectContext) {
        startupLog.push(`📄 Project context: ${contextResult.projectContext.filename}`);
      }
      for (const error of contextResult.errors) {
        startupLog.push(`⚠️  Context file error: ${error}`);
      }

      // Construct the main ReAct agent (system prompt selected by config
      // variant, tool_search wired to its live tools array). The interaction-mode
      // subscription stays in the shell below and uses the returned closure.
      const { agent, buildPromptForMode } = buildAgent({
        config,
        modelId: modelInfo.id,
        notifyingLlm,
        allTools,
        agentContext,
        agentToolsRef,
        silentLogger,
        sessionId: newSession.id,
        initialInteractionMode: useCliStore.getState().interactionMode,
        contextContent: contextResult.mergedContent,
        agentStore,
        customCommandStore: state.customCommandStore,
        enableSkillTool,
        additionalDirectories,
        featureModulePrompts: featureRegistry.getSystemPromptSections(),
      });

      // Hot-swap the system prompt when the user cycles into/out of plan mode (Shift+Tab).
      // The subscription self-cancels when the agent is replaced (e.g., on session reset).
      let lastInteractionMode = useCliStore.getState().interactionMode;
      useCliStore.subscribe(s => {
        if (s.interactionMode === lastInteractionMode) return;
        lastInteractionMode = s.interactionMode;
        if (agentContext.currentAgent !== agent) return;
        agent.setSystemPrompt(buildPromptForMode(s.interactionMode));
      });

      // Wire the agent's step events to the UI store and tavern transcript,
      // and mirror them onto delegated subagents via the orchestrator callbacks.
      wireAgentEvents({ agent, agentContext, orchestrator });

      setState((prev: CliState) => ({
        ...prev,
        agent,
        mcpManager,
        permissionManager,
        config, // Store config for synchronous access
        availableModels: models, // Store models for ConfigEditor
        orchestrator, // Store orchestrator for step handler updates
        agentStore, // Store agent store for agent management commands
        contextContent: contextResult.mergedContent, // Store raw context for compact instructions
        backgroundManager, // Store for grouped notification turn tracking
        sandboxOrchestrator, // Store sandbox orchestrator for /sandbox commands
        wsManager, // WebSocket connection manager (null if using SSE fallback)
        checkpointStore, // File change checkpointing for undo/restore
        additionalDirectories, // Store additional directories for file access
        featureRegistry, // Feature module registry for opt-in modules
      }));

      // Sync initial session with Zustand store
      setStoreSession(newSession);

      // Render banner with startup messages on the right
      renderBanner(startupLog);

      setIsInitialized(true);
      console.log('');
    } catch (error) {
      console.error('Initialization error:', error);
      setInitError(error instanceof Error ? error.message : 'Unknown error');
    }
  }, [
    state.configStore,
    setCommandHistory,
    setIsInitialized,
    setInitError,
    enqueuePermissionPrompt,
    setStoreSession,
    setState,
  ]);

  // Initialize CLI on mount
  useEffect(() => {
    init();
  }, [init]);

  // peon-ping: emit lifecycle pings (turn complete / needs-attention) so the
  // user hears a voice line when the agent finishes or blocks on a prompt.
  // Auto-detects peon-ping on disk; no-op when it isn't installed.
  useEffect(() => {
    const unsubscribe = startPeonNotifier();
    return () => {
      unsubscribe();
      emitPeonSessionEnd();
    };
  }, []);

  // Refs so `bridgePresence` callbacks can reach the latest handleMessage /
  // abort controller without tearing down the loopback WS on every render.
  const handleMessageRef = useRef<((msg: string) => void | Promise<void>) | null>(null);
  const abortControllerRef = useRef<AbortController | null>(state.abortController);
  abortControllerRef.current = state.abortController;

  // Auto-fire turn 1 (claude positional-prompt parity): once init completes and
  // handleMessage is wired, submit B4M_INITIAL_PROMPT exactly once. Deferred a tick
  // so the agent is in state and the ref is current; the prompt then flows through
  // the normal handleMessage path (seeds AND submits, stays interactive).
  const autoFiredRef = useRef(false);
  useEffect(() => {
    if (!isInitialized || autoFiredRef.current) return;
    const initialPrompt = process.env.B4M_INITIAL_PROMPT;
    if (!initialPrompt) return;
    autoFiredRef.current = true;
    setImmediate(() => {
      void handleMessageRef.current?.(initialPrompt);
    });
  }, [isInitialized]);

  // Recompute the tavern sprite status from whatever prompts are still queued.
  // Used after dequeueing a permission/user-question prompt so a second queued
  // prompt keeps the sprite in its awaiting state instead of briefly flipping
  // to `running`. Hoisted out of the render-tree callbacks so both the local
  // Ink response handlers and the tavern `onResolvePermission` can share it.
  const emitNextAwaitingStatus = () => {
    const s = useCliStore.getState();
    if (s.permissionPrompt) {
      void bridgePresence.emitEvent({
        type: 'status',
        status: 'awaiting_permission',
        text: `${s.permissionPrompt.toolName} permission requested`.slice(0, 240),
      });
      return;
    }
    if (s.userQuestionPrompt) {
      void bridgePresence.emitEvent({
        type: 'status',
        status: 'awaiting_input',
        text: summarizeUserQuestion(s.userQuestionPrompt.payload),
      });
      return;
    }
    if (s.reviewGatePrompt) {
      void bridgePresence.emitEvent({
        type: 'status',
        status: 'awaiting_input',
        text: `Review gate: ${s.reviewGatePrompt.description}`.slice(0, 240),
      });
      return;
    }
    // No more queued prompts. Skip the `running` emit if the agent loop is
    // winding down (deny, abort, or tool error) - its `finally` will emit
    // `idle` shortly, and emitting `running` here causes a brief
    // awaiting -> running -> idle flicker in the tavern sprite.
    const abort = abortControllerRef.current;
    if (!abort || abort.signal.aborted) return;
    void bridgePresence.emitEvent({ type: 'status', status: 'running' });
  };

  // Tavern presence: when cc-bridge is running on this machine, announce
  // this CLI session over loopback so a sprite appears in the tavern
  // (D14 - bridge is the sole tavern gateway). No-op if bridge absent.
  //
  // Gated on the `features.tavern` toggle: with Tavern off we never probe the
  // bridge, so a stale `~/.b4m/cc-bridge.json` (left over from a past session
  // where the bridge ran) can't drive the announce-retry loop and spam
  // "[tavern] bridge announce failed" when the bridge process is down.
  const tavernPresenceEnabled = state.config?.features?.tavern ?? false;
  useEffect(() => {
    if (!isInitialized) return;
    if (!tavernPresenceEnabled) {
      // Feature off (or just toggled off at runtime): tear down any active
      // presence and stop the retry/reconnect loops. No-op if never started.
      void bridgePresence.stop('tavern_disabled');
      return;
    }
    let cancelled = false;
    bridgePresence.setCallbacks({
      onSendPrompt: text => handleMessageRef.current?.(text),
      onAbort: () => abortControllerRef.current?.abort(),
      // Tavern modal Allow/Deny -> look up the prompt by `requestId` (the
      // `perm-N` id we coined at enqueue) and resolve it. Maps `allow=true`
      // to `'allow-once'` (no persistent trust granted from the tavern path)
      // and `allow=false` to `'deny'`. If the local Ink UI already answered,
      // `resolvePermissionPromptById` returns false and we no-op.
      onResolvePermission: (requestId, allow) => {
        const action: PermissionResponse = allow ? 'allow-once' : 'deny';
        const resolved = useCliStore.getState().resolvePermissionPromptById(requestId, action);
        if (!resolved) return;
        void bridgePresence.emitEvent({
          type: 'permission_resolved',
          requestId,
          allow,
          resolvedBy: 'user',
        });
        emitNextAwaitingStatus();
      },
    });
    void bridgePresence
      .start({ workspacePath: process.cwd() })
      .then(live => {
        if (cancelled) return;
        if (live) logger.debug('[tavern] presence active');
      })
      .catch(err => logger.debug(`[tavern] start threw: ${(err as Error).message}`));
    return () => {
      cancelled = true;
    };
  }, [isInitialized, tavernPresenceEnabled]);

  /**
   * Handle custom command execution with proper display
   * Shows concise user message but sends full template to agent
   */
  const handleCustomCommandMessage = async (fullTemplate: string, displayMessage: string) => {
    const session = useCliStore.getState().session;
    if (!state.agent || !session) {
      console.error('❌ CLI failed to initialize. Try restarting b4m.\n');
      return;
    }

    // Set thinking state to show loading indicator
    useCliStore.getState().setIsThinking(true);

    // Create abort controller for this operation
    const abortController = new AbortController();
    setState(prev => ({ ...prev, abortController }));

    // Track steps locally for this message
    const currentSteps: any[] = [];

    // Subscribe to agent events for real-time step display
    const stepHandler = (step: any) => {
      currentSteps.push(step);
      const currentSession = useCliStore.getState().session;
      if (currentSession) {
        const messages = [...currentSession.messages];
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.role === 'assistant') {
          messages[messages.length - 1] = {
            ...lastMessage,
            metadata: {
              ...lastMessage.metadata,
              steps: [...currentSteps],
            },
          };
          setStoreSession({
            ...currentSession,
            messages,
          });
        }
      }
    };

    state.agent.on('thought', stepHandler);
    state.agent.on('action', stepHandler);

    try {
      // Check if message contains images
      let messageContent: any = fullTemplate;
      const userMessageContent = displayMessage; // Show concise message to user

      if (state.messageBuilder && state.messageBuilder.hasImages(fullTemplate)) {
        const { message: multimodalMessage } = await state.messageBuilder.buildMessage(fullTemplate);
        messageContent = multimodalMessage.content;
      }

      // Create user message with concise display
      const userMessage: Message = {
        id: uuidv4(),
        role: 'user',
        content: userMessageContent,
        timestamp: new Date().toISOString(),
      };

      // Create a pending assistant message
      const pendingAssistantMessage: Message = {
        id: uuidv4(),
        role: 'assistant',
        content: '...',
        timestamp: new Date().toISOString(),
        metadata: {
          steps: [],
        },
      };

      // Add both messages immediately
      const sessionWithMessages: Session = {
        ...session,
        messages: [...session.messages, userMessage, pendingAssistantMessage],
        updatedAt: new Date().toISOString(),
      };
      setStoreSession(sessionWithMessages);

      // Build conversation history
      const recentMessages = session.messages.slice(-20);
      const previousMessages = recentMessages
        .filter((msg: Message) => msg.role === 'user' || msg.role === 'assistant')
        .map((msg: Message) => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        }));

      // Run agent with FULL template (not the display message)
      const cliConfig = await state.configStore.get();

      // Set turn ID for grouped background agent notifications
      const turnId = `turn-${randomBytes(4).toString('hex')}`;
      state.backgroundManager?.setCurrentTurn(turnId);

      // Quest review gates are enforced via system prompt instructions (tavern tools).
      // The agent reads the plan, sees reviewGate: true with pending status, and stops
      // voluntarily to ask the user. This is preferred over confidenceGate for CLI because
      // the user is present and the agent can explain why it's pausing.
      // See: TavernModule.getSystemPromptSection() for the review gate instructions.
      let result;
      try {
        result = await state.agent.run(messageContent, {
          previousMessages: previousMessages.length > 0 ? previousMessages : undefined,
          signal: abortController.signal,
          parallelExecution: cliConfig.preferences.enableParallelToolExecution === true,
          isReadOnlyTool,
        });
      } finally {
        state.backgroundManager?.setCurrentTurn(null);
      }

      // Check if permission was denied
      const permissionDenied = result.finalAnswer.startsWith('Permission denied for tool');

      if (permissionDenied) {
        console.log('\n⚠️  Action denied by user\n');
      }

      // Count successful tool calls from result.steps
      const successfulToolCalls = result.steps.filter(s => s.type === 'observation').length;

      // Get current session state (may have been updated by stepHandler)
      const currentSession = useCliStore.getState().session;
      if (!currentSession) return;

      // Update the pending assistant message with the actual response
      const updatedMessages = [...currentSession.messages];
      const lastMessage = updatedMessages[updatedMessages.length - 1];
      updatedMessages[updatedMessages.length - 1] = {
        id: lastMessage.id, // Preserve the original message ID
        role: 'assistant',
        content: result.finalAnswer,
        timestamp: new Date().toISOString(),
        metadata: {
          steps: result.steps.map(formatStep),
          tokenUsage: {
            prompt: 0,
            completion: 0,
            total: result.completionInfo.totalTokens,
          },
          creditsUsed: result.completionInfo.totalCredits,
          model: session.model,
          permissionDenied,
        },
      };

      // Update session metadata with token counts and tool calls
      const finalSession: Session = {
        ...currentSession,
        messages: updatedMessages,
        updatedAt: new Date().toISOString(),
        metadata: {
          ...currentSession.metadata,
          totalTokens: currentSession.metadata.totalTokens + result.completionInfo.totalTokens,
          totalCredits: (currentSession.metadata.totalCredits || 0) + (result.completionInfo.totalCredits || 0),
          toolCallCount: currentSession.metadata.toolCallCount + successfulToolCalls,
          // Sync durable workflow state from in-memory stores
          workflow:
            decisionStoreRef.current.decisions.length > 0 ||
            blockerStoreRef.current.blockers.length > 0 ||
            reviewGateStoreRef.current.reviewGates.length > 0
              ? {
                  decisions: decisionStoreRef.current.decisions,
                  blockers: blockerStoreRef.current.blockers,
                  handoff: currentSession.metadata.workflow?.handoff,
                  reviewGates: reviewGateStoreRef.current.reviewGates,
                }
              : currentSession.metadata.workflow,
        },
      };

      setStoreSession(finalSession);

      // Save session after each message
      await state.sessionStore.save(finalSession);

      // Clear usage cache after AI operation
      usageCache = null;

      // Clear thinking state
      useCliStore.getState().setIsThinking(false);
    } catch (error: any) {
      useCliStore.getState().setIsThinking(false);

      // Handle abort (user pressed ESC)
      if (error instanceof Error && error.name === 'AbortError') {
        logger.debug('[ABORT] Custom command aborted by user');

        // Update the assistant message with cancellation
        const currentSession = useCliStore.getState().session;
        if (currentSession) {
          const messages = [...currentSession.messages];
          const lastMessage = messages[messages.length - 1];

          if (lastMessage && lastMessage.role === 'assistant') {
            messages[messages.length - 1] = {
              ...lastMessage,
              content: '⚠️ Operation cancelled by user',
              metadata: {
                ...lastMessage.metadata,
                cancelled: true,
              },
            };
          }

          const sessionWithCancel: Session = {
            ...currentSession,
            messages,
            updatedAt: new Date().toISOString(),
          };

          setStoreSession(sessionWithCancel);
          await state.sessionStore.save(sessionWithCancel);
        }
        return;
      }

      // Handle permission denied
      if (error?.message?.includes('Permission denied')) {
        console.log('\n⚠️  Action blocked by permission settings');
        const currentSession = useCliStore.getState().session;
        if (!currentSession) return;

        const sessionWithDenied = { ...currentSession };
        const messages = [...sessionWithDenied.messages];
        const lastMessage = messages[messages.length - 1];

        if (lastMessage && lastMessage.role === 'assistant') {
          messages[messages.length - 1] = {
            ...lastMessage,
            content: error.message,
            metadata: {
              ...lastMessage.metadata,
              permissionDenied: true,
            },
          };
        }

        sessionWithDenied.messages = messages;
        setStoreSession(sessionWithDenied);
        await state.sessionStore.save(sessionWithDenied);
        return;
      }

      console.error('Error executing command:', error);
      console.error(error.stack);

      // Update the assistant message with error
      const currentSession = useCliStore.getState().session;
      if (!currentSession) return;

      const sessionWithError = { ...currentSession };
      const messages = [...sessionWithError.messages];
      const lastMessage = messages[messages.length - 1];

      if (lastMessage && lastMessage.role === 'assistant') {
        messages[messages.length - 1] = {
          ...lastMessage,
          content: `❌ Error: ${error.message || 'Unknown error occurred'}`,
        };
      }

      sessionWithError.messages = messages;
      setStoreSession(sessionWithError);
    } finally {
      // Clean up abort controller and event handlers
      setState(prev => ({ ...prev, abortController: null }));
      state.agent.off('thought', stepHandler);
      state.agent.off('action', stepHandler);
    }
  };

  const handleMessage = async (message: string) => {
    // Read session fresh from the Zustand store. The React `state.session`
    // captured by this closure can be stale when handleMessage is invoked
    // again via the message-queue drain: the previous turn already wrote
    // its user message into the store, but the closure's `state` reference
    // still points at the pre-turn session object. Reading `state.session`
    // and then writing back would clobber the previous turn's user prompt
    // (the queued message would appear to "disappear" from history).
    const storeSession = useCliStore.getState().session;
    if (!state.agent || !storeSession) {
      console.error('❌ CLI failed to initialize. Try restarting b4m.\n');
      return;
    }

    // Process-hook (host action_required signal): a new user prompt clears any
    // stale block sentinel.
    void getProcessHooks()?.fireUserPromptSubmit();

    // Mirror the user turn into the tavern transcript so remote viewers see
    // it immediately. `text` clamped to the schema's 4000-char cap; the
    // bridge is a no-op if cc-bridge isn't running.
    void bridgePresence.emitEvent({ type: 'message', role: 'user', text: message.slice(0, 4000) });
    void bridgePresence.emitEvent({ type: 'status', status: 'running', text: message.slice(0, 240) });

    // Add to command history
    await state.commandHistoryStore.add(message);
    const updatedHistory = await state.commandHistoryStore.list();
    setCommandHistory(updatedHistory);

    // Check for auto-compact before processing
    const config = state.config;
    let activeSession = storeSession;
    if (config?.preferences.autoCompact !== false && activeSession.messages.length >= 6) {
      const tokenCounter = getTokenCounter();
      const contextWindow = tokenCounter.getContextWindow(activeSession.model, state.availableModels);
      const threshold = contextWindow * 0.8;

      const systemPrompt = buildSystemPrompt(config?.preferences.promptVariant ?? 'current', {
        contextContent: state.contextContent,
        agentStore: state.agentStore || undefined,
        customCommands: state.customCommandStore.getAllCommands(),
        enableSkillTool: config?.preferences.enableSkillTool !== false,
        additionalDirectories: state.additionalDirectories,
        featureModulePrompts: state.featureRegistry?.getSystemPromptSections() || undefined,
        deferredToolNames: deferredToolRegistry.getDirectoryNames(),
      });
      const contextUsage = tokenCounter.countSessionTokens(activeSession, systemPrompt);

      if (contextUsage.totalTokens >= threshold) {
        console.log('\n\u26A0\uFE0F  Context window 80% full. Auto-compacting...\n');

        // Set thinking state for compaction
        useCliStore.getState().setIsThinking(true);

        try {
          const { prompt: compactionPrompt, preservedMessages } = buildCompactionPrompt(activeSession.messages, {
            claudeMdInstructions: extractCompactInstructions(state.contextContent || ''),
          });

          if (compactionPrompt) {
            const result = await state.agent.run(compactionPrompt, { maxIterations: 1 });

            await state.sessionStore.save(activeSession);
            const newSession = createCompactedSession(
              activeSession,
              result.finalAnswer,
              preservedMessages,
              !!(process.env.B4M_SESSION_ID || process.env.B4M_RESUME_ID)
            );

            await logger.initialize(newSession.id);
            setStoreSession(newSession);
            useCliStore.getState().clearPendingMessages();

            console.log('\u2705 Auto-compacted. Continuing with your message...\n');

            // Update local reference to use new session for remaining code
            activeSession = newSession;
          }
        } finally {
          useCliStore.getState().setIsThinking(false);
        }
      }
    }

    // Set thinking state to show loading indicator
    useCliStore.getState().setIsThinking(true);

    // Create abort controller for this operation
    const abortController = new AbortController();
    setState(prev => ({ ...prev, abortController }));

    try {
      // Check if message contains images and build multimodal message if needed
      let messageContent: any = message;
      let userMessageContent = message;

      if (state.messageBuilder && state.messageBuilder.hasImages(message)) {
        const { message: multimodalMessage } = await state.messageBuilder.buildMessage(message);
        messageContent = multimodalMessage.content;
        userMessageContent = message; // Keep original text with placeholders for display
      }

      // Create user message
      const userMessage: Message = {
        id: uuidv4(),
        role: 'user',
        content: userMessageContent,
        timestamp: new Date().toISOString(),
      };

      // Create a pending assistant message to show steps as they come in
      const pendingAssistantMessage: Message = {
        id: uuidv4(),
        role: 'assistant',
        content: '...',
        timestamp: new Date().toISOString(),
        metadata: {
          steps: [],
        },
      };

      // Add user message to session.messages (already complete)
      // Use activeSession which may have been updated by auto-compact
      const sessionWithUserMessage: Session = {
        ...activeSession,
        messages: [...activeSession.messages, userMessage],
        updatedAt: new Date().toISOString(),
      };
      setStoreSession(sessionWithUserMessage);

      // Add pending assistant message to pendingMessages (dynamic, will update in real-time)
      useCliStore.getState().addPendingMessage(pendingAssistantMessage);

      // Build conversation history from previous messages (last 10 exchanges to avoid token limits)
      // Use only the original messages (before pending assistant), not including user message we just added
      const recentMessages = activeSession.messages.slice(-20); // Last 20 messages = 10 exchanges
      const previousMessages = recentMessages
        .filter((msg: Message) => msg.role === 'user' || msg.role === 'assistant')
        .map((msg: Message) => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        }));

      // Run agent with conversation history, using multimodal content if images present
      const cliConfig = await state.configStore.get();

      // Set turn ID for grouped background agent notifications
      const turnId = `turn-${randomBytes(4).toString('hex')}`;
      state.backgroundManager?.setCurrentTurn(turnId);

      let result;
      try {
        result = await state.agent.run(messageContent, {
          previousMessages: previousMessages.length > 0 ? previousMessages : undefined,
          signal: abortController.signal,
          parallelExecution: cliConfig.preferences.enableParallelToolExecution === true,
          isReadOnlyTool,
        });
      } finally {
        state.backgroundManager?.setCurrentTurn(null);
      }

      // Check if permission was denied
      const permissionDenied = result.finalAnswer.startsWith('Permission denied for tool');

      // Provide immediate feedback if permission was denied
      if (permissionDenied) {
        console.log('\n⚠️  Action denied by user\n');
      }

      // Count successful tool calls from result.steps (observations = completed tools)
      const successfulToolCalls = result.steps.filter(s => s.type === 'observation').length;

      // Create the final assistant message
      const finalAssistantMessage: Message = {
        id: pendingAssistantMessage.id, // Preserve the original message ID
        role: 'assistant',
        content: result.finalAnswer,
        timestamp: pendingAssistantMessage.timestamp,
        metadata: {
          tokenUsage: {
            prompt: 0,
            completion: 0,
            total: result.completionInfo.totalTokens,
          },
          creditsUsed: result.completionInfo.totalCredits,
          steps: result.steps.map(formatStep), // Complete history: thoughts, actions, observations
          permissionDenied,
        },
      };

      // Move the pending message to session.messages (history)
      useCliStore.getState().completePendingMessage(0, finalAssistantMessage);

      // Get the updated session and update metadata
      const currentSession = useCliStore.getState().session;
      if (!currentSession) return;

      const updatedSession: Session = {
        ...currentSession,
        metadata: {
          ...currentSession.metadata,
          totalTokens: currentSession.metadata.totalTokens + result.completionInfo.totalTokens,
          totalCredits: (currentSession.metadata.totalCredits || 0) + (result.completionInfo.totalCredits || 0),
          toolCallCount: currentSession.metadata.toolCallCount + successfulToolCalls,
        },
      };

      setStoreSession(updatedSession);

      // Auto-save session
      await state.sessionStore.save(updatedSession);
    } catch (error) {
      // Clear pending messages on error
      useCliStore.getState().clearPendingMessages();

      // Handle abort (user pressed ESC)
      if (error instanceof Error && error.name === 'AbortError') {
        logger.debug('[ABORT] Operation aborted by user');

        // Add cancellation message to session
        const currentSession = useCliStore.getState().session;
        if (currentSession) {
          const cancelMessage: Message = {
            id: uuidv4(),
            role: 'assistant',
            content: '⚠️ Operation cancelled by user',
            timestamp: new Date().toISOString(),
            metadata: {
              cancelled: true,
            },
          };

          const sessionWithCancel: Session = {
            ...currentSession,
            messages: [...currentSession.messages, cancelMessage],
            updatedAt: new Date().toISOString(),
          };

          setStoreSession(sessionWithCancel);
          await state.sessionStore.save(sessionWithCancel);
        }
        return;
      }

      // Handle authentication errors gracefully (without stack trace)
      if (error instanceof Error) {
        if (error.message.includes('Authentication failed') || error.message.includes('Authentication expired')) {
          console.log('\n❌ Authentication failed');
          console.log('💡 Run /login to authenticate with your API environment.\n');
          return;
        }
      }

      // Defense in depth: a bare network-level abort (e.g. `Error: aborted`
      // from a TLS socket close, the symptom that rendered as a cryptic
      // "❌ aborted") is not the user cancelling - it's the connection dropping.
      // The streaming backend retries these and rewrites the message, but if a
      // bare one ever reaches here from another path (other backends, etc.),
      // surface something the user can act on rather than a one-word error.
      // Reuse the backend's classifier so this stays in lockstep with the full
      // set of transient patterns it retries (ETIMEDOUT, terminated, fetch
      // failed, UND_ERR_SOCKET, ...) - not a hand-maintained subset.
      const rawMessage = error instanceof Error ? error.message : String(error);
      if (error instanceof Error && isTransientNetworkError(error)) {
        console.error('\n❌ The connection to the server dropped mid-response. Type "continue" to resume.\n');
        logger.debug(`Full error details: ${error.stack || error.message}`);
        return;
      }

      // Handle other errors - clean message for users, full stack in debug logs
      console.error(`\n❌ ${rawMessage}\n`);
      logger.debug(`Full error details: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    } finally {
      // Tavern: the ReAct turn has settled. Parity with Claude Code's
      // tavern integration: a finished turn means "your turn now" - emit
      // `awaiting_input` so the chime/toast/tab-badge fire and a remote
      // user knows to come back. The exception is a user-initiated abort
      // (ESC): they're already at the keyboard, so emit silent `idle`.
      // Read from the local `abortController` captured at the top of this
      // turn - `state.abortController` is already null by now because the
      // ESC handler clears it eagerly.
      const wasAborted = abortController.signal.aborted;
      setState(prev => ({ ...prev, abortController: null }));
      useCliStore.getState().setIsThinking(false);
      // Process-hook (host action_required signal): end of turn - clear any block
      // sentinel (covers a *denied* permission, which never reaches PostToolUse).
      void getProcessHooks()?.fireStop();
      void bridgePresence.emitEvent({
        type: 'status',
        status: wasAborted ? 'idle' : 'awaiting_input',
      });
      // Drain the user-message queue: if the user submitted more messages
      // while this one was processing, collate ALL of them into a single
      // combined prompt (separated by blank lines) and submit as one
      // request. Fewer round-trips and the model can address everything
      // at once. ESC clears the queue (see ESC handler), so an aborted
      // turn falls through with an empty queue. setImmediate defers the
      // recursive call out of this finally to avoid re-entering
      // handleMessage synchronously.
      if (!wasAborted) {
        const queued = useCliStore.getState().dequeueAllMessages();
        if (queued.length > 0) {
          const combined = queued.join('\n\n');
          setImmediate(() => {
            void handleMessage(combined);
          });
        }
      }
    }
  };
  handleMessageRef.current = handleMessage;

  /**
   * Handle background agent completion - runs agent to process results silently
   * without adding a user message to the conversation.
   */
  const handleBackgroundCompletion = async () => {
    const session = useCliStore.getState().session;
    if (!state.agent || !session) {
      return;
    }

    // Check authentication before allowing any AI operations
    const authTokens = await state.configStore.getAuthTokens();
    if (!authTokens || new Date(authTokens.expiresAt) <= new Date()) {
      return;
    }

    // Set thinking state
    useCliStore.getState().setIsThinking(true);

    // Create abort controller for this operation
    const abortController = new AbortController();
    setState(prev => ({ ...prev, abortController }));

    try {
      // Create a pending assistant message (no user message added to conversation)
      const pendingAssistantMessage: Message = {
        id: uuidv4(),
        role: 'assistant',
        content: '...',
        timestamp: new Date().toISOString(),
        metadata: {
          steps: [],
        },
      };

      useCliStore.getState().addPendingMessage(pendingAssistantMessage);

      // Build conversation history from previous messages
      const recentMessages = session.messages.slice(-20);
      const previousMessages = recentMessages
        .filter((msg: Message) => msg.role === 'user' || msg.role === 'assistant')
        .map((msg: Message) => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        }));

      // Run agent with a system prompt to process background results
      // The actual notification will be injected by NotifyingLlmBackend
      const cliConfig = await state.configStore.get();

      const result = await state.agent.run(
        '[System: Background agents have completed. Review and summarize the results.]',
        {
          previousMessages: previousMessages.length > 0 ? previousMessages : undefined,
          signal: abortController.signal,
          parallelExecution: cliConfig.preferences.enableParallelToolExecution === true,
          isReadOnlyTool,
        }
      );

      // Count successful tool calls
      const successfulToolCalls = result.steps.filter(s => s.type === 'observation').length;

      // Get current session state
      const currentSession = useCliStore.getState().session;
      if (!currentSession) return;

      // Create a continuation message (renders without header due to isContinuation flag)
      // This works with Ink's Static component which doesn't re-render existing items
      const continuationMessage: Message = {
        id: uuidv4(),
        role: 'assistant',
        content: '---\n\n**Background Agent Results:**\n\n' + result.finalAnswer,
        timestamp: new Date().toISOString(),
        metadata: {
          isContinuation: true, // Flag to skip "Assistant" header in MessageItem
          steps: result.steps.map(formatStep),
          tokenUsage: {
            prompt: 0,
            completion: 0,
            total: result.completionInfo.totalTokens,
          },
          creditsUsed: result.completionInfo.totalCredits,
        },
      };

      const updatedSession: Session = {
        ...currentSession,
        messages: [...currentSession.messages, continuationMessage],
        updatedAt: new Date().toISOString(),
        metadata: {
          ...currentSession.metadata,
          totalTokens: currentSession.metadata.totalTokens + result.completionInfo.totalTokens,
          totalCredits: (currentSession.metadata.totalCredits || 0) + (result.completionInfo.totalCredits || 0),
          toolCallCount: currentSession.metadata.toolCallCount + successfulToolCalls,
        },
      };

      // Remove pending message
      useCliStore.getState().clearPendingMessages();

      // Update session in the store (single source of truth)
      setStoreSession(updatedSession);
      await state.sessionStore.save(updatedSession);
    } catch (error: unknown) {
      useCliStore.getState().clearPendingMessages();

      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      console.error('Error processing background results:', error);
    } finally {
      setState(prev => ({ ...prev, abortController: null }));
      useCliStore.getState().setIsThinking(false);
    }
  };

  // Handle bash command execution directly (no backend calls)
  const handleBashCommand = useCallback(
    (command: string) => {
      const session = useCliStore.getState().session;
      if (!session) return;

      let output: string;
      let isError = false;

      try {
        output = execSync(command, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: process.cwd(),
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        });
      } catch (error) {
        const execError = error as { stderr?: string; message?: string };
        output = execError.stderr || execError.message || 'Command failed';
        isError = true;
      }

      // Create messages for the bash command
      const userMessage: Message = {
        id: uuidv4(),
        role: 'user',
        content: `$ ${command}`,
        timestamp: new Date().toISOString(),
      };

      const assistantMessage: Message = {
        id: uuidv4(),
        role: 'assistant',
        content: isError ? `❌ Error:\n${output}` : output.trim() || '(no output)',
        timestamp: new Date().toISOString(),
      };

      // Update session with both messages
      const updatedSession: Session = {
        ...session,
        messages: [...session.messages, userMessage, assistantMessage],
        updatedAt: new Date().toISOString(),
      };

      setStoreSession(updatedSession);

      // Auto-save session
      state.sessionStore.save(updatedSession);
    },
    // session is read fresh from the store, so it is intentionally not a dependency.
    [state.sessionStore]
  );

  const handleImageDetected = async (imageData: Buffer): Promise<string> => {
    try {
      // Lazy-load ImageStore on first use with initialization guard to prevent race condition
      let imageStore = state.imageStore;
      if (!imageStore) {
        // Check if initialization is already in progress
        if (!imageStoreInitPromise.current) {
          // Start initialization and store the promise
          imageStoreInitPromise.current = (async () => {
            const { ImageStore: ImageStoreClass } = await import('./storage/ImageStore.js');
            const newImageStore = new ImageStoreClass();
            setState(prev => ({
              ...prev,
              imageStore: newImageStore,
              messageBuilder: new MessageBuilder(newImageStore, prev.imageRenderer),
            }));
            return newImageStore;
          })();
        }
        // Wait for the initialization to complete
        imageStore = await imageStoreInitPromise.current;
      }

      // Store image locally
      const imageRef = await imageStore.store(imageData);

      // Create placeholder
      const imagePlaceholder = state.imageRenderer.createPlaceholder(imageRef.hash);

      // Log success
      console.log(`\n✓ Image detected and stored: ${imagePlaceholder}\n`);

      return imagePlaceholder;
    } catch (error) {
      console.error('Error storing image:', error);
      throw error;
    }
  };

  /**
   * Recalculate session metadata from current messages
   */
  const recalculateSessionMetadata = (messages: Message[]) => {
    let totalTokens = 0;
    let totalCost = 0;
    let toolCallCount = 0;

    for (const msg of messages) {
      if (msg.metadata) {
        if (msg.metadata.tokenUsage) {
          totalTokens += msg.metadata.tokenUsage.total || 0;
        }

        if (msg.metadata.cost) {
          totalCost += msg.metadata.cost;
        }

        // Count tool calls from steps (observations = completed tools)
        if (msg.metadata.steps) {
          const observations = msg.metadata.steps.filter(s => s.type === 'observation');
          toolCallCount += observations.length;
        }
      }
    }

    return {
      totalTokens,
      totalCost,
      toolCallCount,
    };
  };

  /**
   * Helper to display agents grouped by source
   */
  const displayAgentsBySource = (
    agents: Array<{ name: string; description: string }>,
    label: string,
    emoji: string
  ): void => {
    if (agents.length > 0) {
      console.log(`${emoji} ${label}:`);
      // Calculate max description length based on terminal width
      // Format: "  {name.padEnd(25)} - {description}"
      const terminalWidth = process.stdout.columns || 80;
      const nameWidth = 25;
      const prefixWidth = 2 + nameWidth + 3; // "  " + name + " - "
      const maxDescLength = Math.max(20, terminalWidth - prefixWidth);
      agents.forEach(agent => {
        const desc =
          agent.description.length > maxDescLength
            ? agent.description.slice(0, maxDescLength - 3) + '...'
            : agent.description;
        console.log(`  ${agent.name.padEnd(nameWidth)} - ${desc}`);
      });
      console.log('');
    }
  };

  /**
   * Apply `handoff` to the session's workflow state, pulling the latest
   * decisions/blockers/review-gates from their stores. Centralizes the
   * workflow assembly so the LLM-backed path and the local fallback path
   * cannot drift apart on which fields land on `session.metadata.workflow`.
   */
  const applyHandoffToWorkflow = (session: Session, handoff: SessionHandoff): void => {
    session.metadata.workflow = {
      decisions: decisionStoreRef.current.decisions,
      blockers: blockerStoreRef.current.blockers,
      handoff,
      reviewGates: reviewGateStoreRef.current.reviewGates,
    };
  };

  /**
   * Best-effort write of the Markdown handoff artifact to
   * `~/.bike4mind/handoffs/`. Returns the file path on success, null on
   * filesystem failure - callers should not block on this.
   *
   * Reads `session.metadata.workflow.handoff` to include the narrative
   * synthesis section (if any), so this works uniformly for both the
   * LLM-backed path and the local fallback path.
   */
  const writeHandoffMarkdown = async (session: Session): Promise<string | null> => {
    try {
      return await writeLocalHandoffFile(session);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.debug(`Handoff markdown write failed: ${reason}`);
      return null;
    }
  };

  /**
   * Build a handoff purely from local session state - no LLM call. Mutates
   * the session's workflow state with the local handoff and writes a Markdown
   * file to `~/.bike4mind/handoffs/`.
   *
   * Used both as the explicit `--local` path and as the auto-fallback when
   * the LLM is unreachable (rate limit, network, auth).
   */
  const writeLocalFallbackHandoff = async (
    session: Session
  ): Promise<{ handoff: SessionHandoff; filePath: string } | null> => {
    // Pass the authoritative ref-store contents so the handoff itself and the
    // workflow object written immediately after stay consistent - the session
    // object may not yet have been synced from the refs (no agent.run cycle
    // since the last decision/blocker).
    const handoff = buildLocalHandoff(session, {
      decisions: decisionStoreRef.current.decisions,
      blockers: blockerStoreRef.current.blockers,
    });
    applyHandoffToWorkflow(session, handoff);
    const filePath = await writeHandoffMarkdown(session);
    if (!filePath) return null;
    return { handoff, filePath };
  };

  /**
   * Generate a structured session handoff via a single LLM call and persist it
   * onto the session's workflow state. Returns the handoff on success, or null
   * if generation was skipped (short session) or failed unrecoverably.
   *
   * If the LLM is unavailable (rate-limit, network, auth, upstream outage),
   * automatically falls back to a local handoff written to disk so the user
   * always has a usable artifact. Falling back is silent at
   * the data layer; the caller surfaces the path to the user.
   *
   * Other failures (parse errors, short sessions) are best-effort and surfaced
   * as warnings rather than thrown - the surrounding /save flow must not block
   * on handoff generation.
   *
   * Callers are responsible for saving the session afterwards.
   */
  const generateHandoff = async (
    session: Session
  ): Promise<{
    handoff: SessionHandoff;
    filePath: string | null;
    source: 'llm' | 'local-fallback';
  } | null> => {
    if (!state.agent) return null;

    // buildHandoffPrompt returns '' for short sessions - single source of truth
    // for the threshold check.
    const prompt = buildHandoffPrompt(session);
    if (!prompt) return null;

    console.log('📝 Generating session handoff...');
    useCliStore.getState().setIsThinking(true);
    try {
      const result = await state.agent.run(prompt, { maxIterations: 1 });
      const handoff = parseHandoffResponse(result.finalAnswer);

      if (!handoff) {
        console.warn('⚠️  Handoff generation returned no parseable JSON; skipping.');
        logger.debug(`Handoff response: ${result.finalAnswer.slice(0, 500)}`);
        return null;
      }

      applyHandoffToWorkflow(session, handoff);
      const filePath = await writeHandoffMarkdown(session);
      return { handoff, filePath, source: 'llm' };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.debug(`Handoff generation error: ${reason}`);

      if (isLlmUnavailableError(err)) {
        console.warn(`⚠️  LLM unavailable for handoff generation: ${reason}`);
        const local = await writeLocalFallbackHandoff(session);
        if (local) {
          return { handoff: local.handoff, filePath: local.filePath, source: 'local-fallback' };
        }
        console.warn('⚠️  Local handoff fallback also failed; no handoff produced.');
        return null;
      }

      console.warn(`⚠️  Handoff generation failed: ${reason}`);
      return null;
    } finally {
      useCliStore.getState().setIsThinking(false);
    }
  };

  /**
   * If the active session is eligible for a handoff, prompt the user to
   * generate one before exiting. Eligibility: session exists, has at least
   * SHORT_SESSION_THRESHOLD messages, no handoff already, and an agent is
   * available to run the generation.
   *
   * `generateHandoff` mutates the passed-in session in place, then we save
   * that exact reference. We don't rely on the trailing `performCleanup()` to
   * persist the change because the store's session may have been replaced while
   * we waited for the prompt (e.g. by a background-agent update), making the
   * mutated snapshot orphaned. Best-effort: any failure is logged and
   * swallowed so it never blocks exit.
   */
  const maybePromptExitHandoff = async (): Promise<void> => {
    const session = useCliStore.getState().session;
    if (!session) return;
    if (!state.agent) return;
    if (session.messages.length < SHORT_SESSION_THRESHOLD) return;
    if (session.metadata.workflow?.handoff) return;

    // If the prompt times out, the user is treated as having declined and the
    // prompt is cleared from the store so the UI doesn't keep rendering it
    // during cleanup. See EXIT_HANDOFF_PROMPT_TIMEOUT_MS at module-level.
    const promptId = uuidv4();
    let timer: NodeJS.Timeout | undefined;
    const wantsHandoff = await new Promise<boolean>(resolve => {
      let settled = false;
      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      useCliStore.getState().setExitHandoffPrompt({ id: promptId, resolve: settle });
      timer = setTimeout(() => {
        logger.debug('[EXIT] Handoff prompt timed out — defaulting to no handoff');
        const current = useCliStore.getState().exitHandoffPrompt;
        if (current?.id === promptId) {
          useCliStore.getState().setExitHandoffPrompt(null);
        }
        settle(false);
      }, EXIT_HANDOFF_PROMPT_TIMEOUT_MS);
    });

    if (!wantsHandoff) return;

    try {
      const result = await generateHandoff(session);
      if (result) {
        await state.sessionStore.save(session);
        const label =
          result.source === 'local-fallback' ? 'Local handoff written (LLM unavailable)' : 'Handoff generated';
        if (result.filePath) {
          console.log(`🤝 ${label}. File: ${result.filePath}`);
        } else {
          console.log(`🤝 ${label}.`);
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.debug(`[EXIT] Handoff generation/save failed: ${reason}`);
    }
  };

  const printDecisions = (): void => {
    console.log('\n📋 Decision Log\n');
    console.log(formatDecisionsOutput(decisionStoreRef.current.decisions));
    console.log('');
  };

  const printBlockers = (): void => {
    console.log('\n🚧 Blockers\n');
    console.log(formatBlockersOutput(blockerStoreRef.current.blockers));
    console.log('');
  };

  const printReviewGates = (): void => {
    console.log('\n🛑 Review Gates\n');
    console.log(formatReviewGatesOutput(reviewGateStoreRef.current.reviewGates));
    console.log('');
  };

  const printWorkflowOverview = (): void => {
    const decisionCount = decisionStoreRef.current.decisions.length;
    const blockers = blockerStoreRef.current.blockers;
    const openBlockers = blockers.filter(b => b.status === 'open').length;
    const gateCount = reviewGateStoreRef.current.reviewGates.length;
    const handoff = useCliStore.getState().session?.metadata.workflow?.handoff;

    console.log('\n🔧 Workflow Overview\n');
    console.log(`  📋 Decisions: ${decisionCount}`);
    console.log(`  🚧 Blockers: ${openBlockers} open / ${blockers.length} total`);
    console.log(`  🛑 Review gates: ${gateCount}`);
    console.log(`  🤝 Handoff: ${handoff ? `generated at ${handoff.generatedAt}` : 'none'}`);
    console.log('\n  Use /workflow <decisions|blockers|handoff|review-gates> for details.\n');
  };

  /**
   * Show the existing handoff or generate a fresh one. Shared by `/handoff` and
   * `/workflow handoff`. Subcommands:
   *   - `generate` / `regen` - force regeneration via the LLM (auto-falls back
   *     to a local handoff if the LLM is unreachable).
   *   - `--local` flag - skip the LLM entirely and write a local handoff file
   *     from session state. The recovery path for when the user is
   *     rate-limited or offline.
   */
  const runHandoffCommand = async (args: string[]): Promise<void> => {
    const session = useCliStore.getState().session;
    if (!session) {
      console.log('No active session');
      return;
    }

    const wantsLocal = args.includes('--local');
    const filteredArgs = args.filter(a => a !== '--local');
    const existing = session.metadata.workflow?.handoff;
    const wantsRegen = filteredArgs[0] === 'generate' || filteredArgs[0] === 'regen' || wantsLocal;

    if (existing && !wantsRegen) {
      console.log('\n🤝 Session handoff\n');
      console.log(formatHandoffOutput(existing));
      console.log('Run /handoff generate to refresh, or /handoff --local for an LLM-free snapshot.\n');
      return;
    }

    if (wantsLocal) {
      const local = await writeLocalFallbackHandoff(session);
      if (!local) {
        console.log('❌ Failed to write local handoff');
        return;
      }
      await state.sessionStore.save(session);
      console.log('\n🤝 Local session handoff (no LLM call)\n');
      console.log(formatHandoffOutput(local.handoff));
      console.log(`\n📄 Local handoff written to ${local.filePath}`);
      console.log('✅ Session saved with local handoff');
      return;
    }

    if (session.messages.length < SHORT_SESSION_THRESHOLD) {
      console.log(`Not enough messages to generate a handoff (need at least ${SHORT_SESSION_THRESHOLD})`);
      return;
    }
    if (!state.agent) {
      console.log('Cannot generate handoff: no active agent');
      return;
    }

    const result = await generateHandoff(session);
    if (!result) {
      console.log('❌ Failed to generate handoff. Try /handoff --local for an LLM-free snapshot.');
      return;
    }
    await state.sessionStore.save(session);
    const fellBack = result.source === 'local-fallback';
    console.log(fellBack ? '\n🤝 Local session handoff (LLM unavailable)\n' : '\n🤝 Session handoff\n');
    console.log(formatHandoffOutput(result.handoff));
    if (result.filePath) {
      console.log(`\n📄 Handoff written to ${result.filePath}`);
    }
    console.log(fellBack ? '✅ Session saved with local fallback handoff' : '✅ Session saved with refreshed handoff');
  };

  const handleCommand = async (command: string, args: string[]) => {
    // Check if this is a custom command first
    const customCommand = state.customCommandStore.getCommand(command);
    if (customCommand) {
      try {
        // Show that the command is being executed
        const sourceIcon = customCommand.source === 'global' ? '🏠' : '📁';
        console.log(`${sourceIcon} Executing custom command: /${command}`);

        // Substitute arguments in the command body
        let substitutedBody = substituteArguments(customCommand.body, args);

        // Process @file references using existing system
        const processed = await processFileReferences(substitutedBody);
        substitutedBody = processed.content;

        // Log any file reference errors
        if (processed.errors.length > 0) {
          processed.errors.forEach(error => console.warn(`Warning: ${error}`));
        }

        // Show the expanded command in verbose mode
        if (process.env.B4M_VERBOSE === '1') {
          console.log('📝 Expanded command:\n', substitutedBody);
        }

        // Create a concise display message for the user
        const displayMessage = `/${command}${args.length > 0 ? ' ' + args.join(' ') : ''}`;

        // Check if command should delegate to an agent
        if (customCommand.agent && state.orchestrator && state.agentStore) {
          const { name: agentName } = parseAgentConfig(customCommand.agent);

          // Validate agent exists
          if (!state.agentStore.hasAgent(agentName)) {
            const available = state.agentStore.getAgentNames().join(', ');
            console.error(`❌ Unknown agent "${agentName}" specified in command.`);
            console.error(`   Available agents: ${available}`);
            return;
          }

          console.log(`🤖 Delegating to ${agentName} agent...\n`);

          // Delegate to the specified agent
          const result = await state.orchestrator.delegateToAgent({
            task: substitutedBody,
            agentName,
            thoroughness: customCommand.thoroughness,
            variables: customCommand.variables,
            parentSessionId: useCliStore.getState().session?.id || 'unknown',
          });

          // Display the agent result summary
          console.log('\n' + result.summary + '\n');
          return;
        }

        // Apply model override if specified
        if (customCommand.model && state.agent) {
          console.log(`🔄 Using model override: ${customCommand.model}`);

          // Temporarily override the model on the active session by mutating the
          // captured reference in place. NOTE: this restore is best-effort and
          // known-incomplete - handleCustomCommandMessage installs new session
          // references in the store, so the restore below mutates a now-orphaned
          // object and the override can persist to the saved session. Behavior
          // is unchanged from before the single-source-of-truth refactor; a
          // proper fix (restore on the current store session, or a first-class
          // "run with model override" transition) is tracked in #241.
          const overrideSession = useCliStore.getState().session;
          const originalModel = overrideSession?.model;
          if (overrideSession) {
            overrideSession.model = customCommand.model;
          }

          // Execute the command - send full template to agent but show concise message to user
          await handleCustomCommandMessage(substitutedBody, displayMessage);

          // Restore original model
          if (overrideSession && originalModel) {
            overrideSession.model = originalModel;
          }
        } else {
          // Execute without model override
          console.log('🤖 Sending to agent...\n');
          await handleCustomCommandMessage(substitutedBody, displayMessage);
        }

        return; // Custom command handled, exit
      } catch (error) {
        console.error(
          `❌ Failed to execute custom command /${command}:`,
          error instanceof Error ? error.message : String(error)
        );
        return;
      }
    }

    // Handle built-in commands
    switch (command) {
      case 'help': {
        const customCommands = state.customCommandStore.getAllCommands();
        const hasCustomCommands = customCommands.length > 0;

        console.log(`
Available commands:
  /help - Show this help message
  /exit - Exit the CLI
  /clear - Start a new session
  /rewind - Rewind conversation to a previous point
  /undo - Undo the last file change
  /checkpoints - List available file restore points
  /restore <n> - Restore files to a specific checkpoint
  /diff [n] - Show diff between current state and a checkpoint
  /login - Authenticate with your B4M account
  /logout - Clear authentication and sign out
  /whoami - Show current authenticated user
  /usage - Show credit usage and balance
  /save <name> - Save current session
  /resume - List and resume saved sessions
  /config - Show configuration

API Configuration:
  /set-api <url> - Connect to self-hosted Bike4Mind instance
  /reset-api - Clear the custom API URL (falls back to the default, or prompts you to pick one)
  /api-info - Show current API configuration

Tool Permissions:
  /trust <tool-name> - Trust a tool (won't ask permission again)
  /untrust <tool-name> - Remove tool from trusted list
  /trusted - List all trusted tools

Project Configuration:
  /project-config - Show merged project configuration

Custom Commands:
  /commands - List all custom commands
  /commands:new <name> - Create a new custom command
  /commands:reload - Reload custom commands from disk

Terminal Setup:
  /terminal-setup - Configure Shift+Enter for multi-line input

Keyboard Shortcuts:
  Ctrl+C          - Press twice to exit
  Esc             - Abort current operation
  Shift+Tab       - Toggle auto-accept edits
  Ctrl+U          - Clear current line
  Ctrl+K          - Clear from cursor to end of line
  Ctrl+W          - Delete word before cursor
  Ctrl+A          - Move cursor to beginning
  Ctrl+E          - Move cursor to end
  Ctrl+B / ←      - Move cursor left
  Ctrl+F / →      - Move cursor right
  Ctrl+D          - Delete character at cursor
  Ctrl+L          - Clear input
  ↑ / ↓           - Navigate history / autocomplete
  Tab             - Accept autocomplete suggestion
  Shift+Cmd+Click - Open links in browser

Multi-line Input:
  \\ + Enter       - Insert newline (works everywhere)
  Option + Enter  - Insert newline (macOS standard terminals)
  Shift + Enter   - Insert newline (iTerm2, WezTerm, Ghostty, Kitty)${hasCustomCommands ? '\n\n📝 Custom Commands Available:' : ''}${
    hasCustomCommands
      ? customCommands
          .map(cmd => {
            const source = cmd.source === 'global' ? '🏠' : '📁';
            const argHint = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
            return `\n  ${source} /${cmd.name}${argHint} - ${cmd.description}`;
          })
          .join('')
      : ''
  }
        `);
        break;
      }

      case 'exit':
      case 'quit':
        // If a Ctrl+C exit chain is already in flight, don't start a second
        // one - it would orphan the first handoff prompt's resolver.
        if (exitInProgress) break;
        // Cleanup and exit naturally
        logger.debug('[EXIT /exit command - cleaning up and exiting...');
        exitInProgress = true;
        await maybePromptExitHandoff();
        await performCleanup();
        exit(); // Let Ink unmount and process exit naturally
        break;

      case 'save': {
        const session = useCliStore.getState().session;
        if (!session) {
          console.log('No active session to save');
          return;
        }
        if (session.messages.length === 0) {
          console.log('❌ Cannot save session with no messages');
          return;
        }
        const sessionName = args.join(' ') || session.name;
        session.name = sessionName;
        // Sync workflow state before saving so decisions/blockers are persisted
        // even if handoff generation is skipped or fails. When generateHandoff
        // succeeds it will overwrite this with a fresh workflow object that
        // includes the new handoff.
        if (
          decisionStoreRef.current.decisions.length > 0 ||
          blockerStoreRef.current.blockers.length > 0 ||
          reviewGateStoreRef.current.reviewGates.length > 0
        ) {
          session.metadata.workflow = {
            decisions: decisionStoreRef.current.decisions,
            blockers: blockerStoreRef.current.blockers,
            handoff: session.metadata.workflow?.handoff,
            reviewGates: reviewGateStoreRef.current.reviewGates,
          };
        }
        // Generate structured handoff so the next session can resume seamlessly.
        // Skipped silently for short sessions or when no agent is available.
        const handoffResult = await generateHandoff(session);
        await state.sessionStore.save(session);
        console.log(`✅ Session saved as "${sessionName}"`);
        if (handoffResult) {
          const label =
            handoffResult.source === 'local-fallback'
              ? 'Local handoff written (LLM unavailable)'
              : 'Session handoff generated';
          if (handoffResult.filePath) {
            console.log(`🤝 ${label}. File: ${handoffResult.filePath}`);
          } else {
            console.log(`🤝 ${label}`);
          }
        }
        break;
      }

      case 'resume':
      case 'sessions': {
        const sessions = await state.sessionStore.list(20);

        // Handle empty sessions case
        if (sessions.length === 0) {
          console.log('\n📚 No saved sessions found.');
          console.log('💡 Use /save <name> to save your current session.\n');
          break;
        }

        // Define handler for session selection
        const handleSessionSelect = async (selectedSession: Session | null) => {
          setState(prev => ({ ...prev, sessionSelector: null }));

          if (!selectedSession) {
            return;
          }

          // Load full session from disk
          const loadedSession = await state.sessionStore.load(selectedSession.id);

          if (!loadedSession) {
            console.log(`❌ Failed to load session: ${selectedSession.name}`);
            console.log('   The session file may be corrupted or deleted.');
            return;
          }

          // Reinitialize logger for resumed session
          await logger.initialize(loadedSession.id);
          logger.debug('=== Session Resumed ===');

          // Update checkpoint store for resumed session
          if (state.checkpointStore) {
            state.checkpointStore.setSessionId(loadedSession.id);
          }

          // Inject handoff as a system message so the AI picks up structured
          // continuity context, not just raw chat history. injectHandoffMessage
          // replaces any prior injected handoff to avoid stacking on repeated
          // save/resume cycles.
          const handoff = loadedSession.metadata.workflow?.handoff;
          const sessionForState: Session = handoff
            ? { ...loadedSession, messages: injectHandoffMessage(loadedSession.messages, handoff) }
            : loadedSession;

          // Update the session in the store (single source of truth)
          setStoreSession(sessionForState);
          useCliStore.getState().clearPendingMessages();

          // Clear usage cache
          usageCache = null;

          console.log(`\n✅ Session resumed: "${sessionForState.name}"`);
          console.log(
            `📝 ${sessionForState.messages.length} messages | 🤖 ${sessionForState.model} | 📊 ${sessionForState.metadata.totalTokens.toLocaleString()} tokens\n`
          );

          if (handoff) {
            console.log('🤝 Session handoff:\n');
            console.log(formatHandoffOutput(handoff));
          }
        };

        // Show interactive selector
        setState(prev => ({
          ...prev,
          sessionSelector: { sessions, resolve: handleSessionSelect },
        }));
        break;
      }

      case 'config': {
        // Open interactive configuration editor
        setShowConfigEditor(true);
        break;
      }

      case 'set-api': {
        const rawUrl = args[0];

        if (!rawUrl) {
          console.log('Usage: /set-api <url>');
          console.log('');
          console.log('Connect to a self-hosted Bike4Mind instance.');
          console.log('');
          console.log('Example:');
          console.log('  /set-api https://app.your-instance.example.com');
          console.log('');
          return;
        }

        // Validate + normalize through the shared parser so /set-api applies the
        // same rule as --api-url and the first-run picker: trims whitespace,
        // strips trailing slashes, and requires an http(s) origin.
        const result = parseApiUrl(rawUrl);
        if ('error' in result) {
          console.log(`\n❌ ${result.error}`);
          console.log('Please provide a valid http(s) URL (e.g., https://app.your-instance.example.com)\n');
          return;
        }
        const { url } = result;

        await state.configStore.setCustomApiUrl(url);

        // Clear authentication when changing API URL
        await state.configStore.clearAuthTokens();

        console.log(`\n✅ API URL updated: ${url}`);
        console.log('🔓 Authentication cleared');
        console.log(`💡 Run /login to authenticate with ${url}`);
        console.log('Please restart the CLI for changes to take effect.\n');
        break;
      }

      case 'reset-api': {
        await state.configStore.setCustomApiUrl(null);

        // Clear authentication when resetting API URL
        await state.configStore.clearAuthTokens();

        const resetEndpoint = resolveApiEndpoint();
        console.log('\n✅ Custom API URL cleared');
        console.log('🔓 Authentication cleared');
        if (resetEndpoint.status === 'configured') {
          console.log(`🌍 The CLI will now use ${resetEndpoint.url}`);
          console.log('💡 Restart the CLI, then run /login to authenticate.\n');
        } else {
          console.log("💡 Restart the CLI and you'll be prompted to choose a backend.\n");
        }
        break;
      }

      case 'api-info': {
        const config = await state.configStore.get();
        const endpoint = resolveApiEndpoint(config.apiConfig);
        const apiType = getEnvironmentName(config.apiConfig);

        console.log('\n🌍 API Configuration:\n');
        console.log(`Type: ${apiType}`);
        console.log(`URL: ${endpoint.status === 'configured' ? endpoint.url : '(not configured)'}`);
        console.log('');
        break;
      }

      case 'trust': {
        if (!state.permissionManager) {
          console.log('Permission manager not initialized');
          return;
        }

        const toolToTrust = args[0];

        if (!toolToTrust) {
          console.log('Usage: /trust <tool-name>');
          console.log('');
          console.log('Example:');
          console.log('  /trust file_read  - Opens interactive location selector');
          console.log('');
          return;
        }

        // Check if tool can be trusted
        const canTrust = state.permissionManager.trustTool(toolToTrust);
        if (!canTrust) {
          if (state.permissionManager.isDenied(toolToTrust)) {
            console.log(`❌ Tool '${toolToTrust}' is denied by project configuration and cannot be trusted`);
          } else {
            console.log(`❌ Tool '${toolToTrust}' cannot be trusted (it's in the 'prompt_always' category)`);
          }
          return;
        }

        // Remove from permission manager (we'll save to config instead)
        state.permissionManager.untrustTool(toolToTrust);

        // Show interactive location selector
        const handleLocationSelect = async (location: 'local' | 'project' | 'global' | null) => {
          setState(prev => ({ ...prev, trustLocationSelector: null }));

          if (!location) {
            console.log('❌ Trust operation cancelled');
            return;
          }

          const projectDir = state.configStore.getProjectConfigDir();

          // Save based on location
          switch (location) {
            case 'local': {
              if (!projectDir) {
                console.log('❌ No project found. Use "global" to save to ~/.bike4mind/config.json');
                return;
              }

              try {
                // Auto-create .bike4mind directory if needed
                await state.configStore.initProjectConfig(); // This ensures .gitignore is updated

                // Load existing local config or create new
                const existingLocal = (await state.configStore.loadRawProjectLocalConfig()) || {};
                const updatedLocal: ProjectLocalConfig = {
                  ...existingLocal,
                  trustedTools: [...new Set([...(existingLocal.trustedTools || []), toolToTrust])],
                };

                await state.configStore.saveProjectLocalConfig(updatedLocal);
                state.permissionManager?.trustTool(toolToTrust);
                console.log(`✅ Tool '${toolToTrust}' trusted for this project only`);
                console.log(`   Saved in: ${projectDir}/.bike4mind/local.json`);
              } catch (error) {
                console.error(`❌ Failed to save project-local config:`, error);
              }
              break;
            }

            case 'project': {
              if (!projectDir) {
                console.log('❌ No project found. Use "global" to save to ~/.bike4mind/config.json');
                return;
              }

              try {
                // Load existing project config or create new
                const existingProject = (await state.configStore.loadRawProjectConfig()) || {};
                const updatedProject: ProjectConfig = {
                  ...existingProject,
                  tools: {
                    ...existingProject.tools,
                    enabled: [...new Set([...(existingProject.tools?.enabled || []), toolToTrust])],
                  },
                };

                await state.configStore.saveProjectConfig(updatedProject);
                state.permissionManager?.trustTool(toolToTrust);
                console.log(`✅ Tool '${toolToTrust}' trusted for entire team`);
                console.log(`   Saved in: ${projectDir}/.bike4mind/config.json`);
                console.log('   ⚠️  Remember to commit this file to share with your team!');
              } catch (error) {
                console.error(`❌ Failed to save project config:`, error);
              }
              break;
            }

            case 'global': {
              try {
                await state.configStore.trustTool(toolToTrust);
                state.permissionManager?.trustTool(toolToTrust);
                console.log(`✅ Tool '${toolToTrust}' trusted globally (all projects)`);
                console.log('   Saved in: ~/.bike4mind/config.json');
              } catch (error) {
                console.error(`❌ Failed to save global config:`, error);
              }
              break;
            }
          }
        };

        setState(prev => ({
          ...prev,
          trustLocationSelector: {
            toolName: toolToTrust,
            resolve: handleLocationSelect,
          },
        }));
        break;
      }

      case 'untrust': {
        if (!state.permissionManager) {
          console.log('Permission manager not initialized');
          return;
        }
        const toolToUntrust = args[0];
        if (!toolToUntrust) {
          console.log('Usage: /untrust <tool-name>');
          return;
        }
        state.permissionManager.untrustTool(toolToUntrust);
        await state.configStore.untrustTool(toolToUntrust);
        console.log(`✅ Tool '${toolToUntrust}' removed from trusted list`);
        break;
      }

      case 'trusted': {
        if (!state.permissionManager) {
          console.log('Permission manager not initialized');
          return;
        }
        const trustedTools = state.permissionManager.getTrustedTools();
        console.log('\n🔒 Trusted Tools:\n');
        if (trustedTools.length === 0) {
          console.log('  (none)');
        } else {
          trustedTools.forEach(t => console.log(`  - ${t}`));
        }
        console.log('');
        break;
      }

      case 'login':
        // Login flow will be handled by rendering LoginFlow component
        setState(prev => ({ ...prev, showLoginFlow: true }) as any);
        break;

      case 'logout':
        usageCache = null; // Clear cached usage data to prevent data leakage
        await state.configStore.clearAuthTokens();
        console.log('✅ Successfully logged out');
        break;

      case 'whoami': {
        const authTokens = await state.configStore.getAuthTokens();
        if (!authTokens) {
          console.log('Not authenticated. Run /login to authenticate.');
          return;
        }
        const isExpired = new Date(authTokens.expiresAt) <= new Date();
        console.log('\n👤 Current User:\n');
        console.log(`User ID: ${authTokens.userId}`);
        console.log(`Status: ${isExpired ? '⚠️  Token expired' : '✅ Authenticated'}`);
        console.log(`Expires: ${new Date(authTokens.expiresAt).toLocaleString()}`);
        console.log('');
        break;
      }

      case 'clear':
      case 'new': {
        // Clear the terminal screen and re-render the banner so the fresh
        // session starts with the same header the user sees on startup.
        console.clear();
        renderBanner();

        // Create new session (preserving model from current session or config).
        // Pinned-session mode (host board pane): keep the SAME uuid so the host's
        // --resume still finds this conversation after a /clear.
        const currentSession = useCliStore.getState().session;
        const model = currentSession?.model || state.config?.defaultModel || ChatModels.CLAUDE_4_5_SONNET;
        const clearPinnedId = process.env.B4M_SESSION_ID || process.env.B4M_RESUME_ID;
        const newSession: Session = {
          id: clearPinnedId ? (currentSession?.id ?? clearPinnedId) : uuidv4(),
          name: `Session ${new Date().toLocaleString()}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          model,
          messages: [],
          metadata: {
            totalTokens: 0,
            totalCost: 0,
            toolCallCount: 0,
          },
        };

        // Reinitialize logger with new session ID
        await logger.initialize(newSession.id);
        logger.debug('=== New Session Started via /clear ===');

        // Reset workflow stores so old decisions/blockers don't leak into new session
        decisionStoreRef.current.decisions = [];
        blockerStoreRef.current.blockers = [];

        // Update checkpoint store for new session
        if (state.checkpointStore) {
          state.checkpointStore.setSessionId(newSession.id);
        }

        // Update the session in the store (single source of truth)
        setStoreSession(newSession);

        // Clear pending messages from Zustand store
        useCliStore.getState().clearPendingMessages();

        // Drain any stale review gate prompt from the UI queue. The agent
        // shouldn't be running during /clear, but guard against an in-flight
        // gate Promise leaking by resolving it as a rejection so the agent
        // unwinds cleanly if it ever does.
        const staleGate = useCliStore.getState().reviewGatePrompt;
        if (staleGate) {
          dequeueReviewGatePrompt();
          staleGate.resolve({ decision: 'rejected', note: 'Session cleared.' });
        }

        // Reset reviewGates *after* the drained gate's toolFn continuation
        // runs. The continuation is scheduled as a microtask by the resolve()
        // above, and it pushes a rejection entry into store.reviewGates.
        // Clearing synchronously here would let that push leak into the new
        // session; deferring to the next microtask ensures we replace the
        // array after the push, dropping the ghost entry with the old array.
        queueMicrotask(() => {
          reviewGateStoreRef.current.reviewGates = [];
        });

        // Clear usage cache for fresh data
        usageCache = null;

        console.log('New session started.');
        console.log(`\n📝 Session: ${newSession.name}  |  🤖 Model: ${newSession.model}  |  📊 Tokens: 0\n`);
        break;
      }

      case 'rewind': {
        const session = useCliStore.getState().session;
        if (!session) {
          console.log('No active session to rewind');
          return;
        }

        // Check if conversation is empty
        if (session.messages.length === 0) {
          console.log('⚠️  Conversation is empty. Nothing to rewind.');
          return;
        }

        // Get user messages
        const userMessages = session.messages.filter(msg => msg.role === 'user');

        if (userMessages.length === 0) {
          console.log('⚠️  No user messages found. Nothing to rewind.');
          return;
        }

        // Check if there's only one exchange (user + assistant)
        if (userMessages.length === 1) {
          console.log('⚠️  Only one exchange in the conversation. Use /clear to start a new session instead.');
          return;
        }

        // Show interactive selector
        const handleRewindSelect = async (messageIndex: number | null) => {
          setState(prev => ({ ...prev, rewindSelector: null }));

          if (messageIndex === null) {
            console.log('❌ Rewind operation cancelled');
            return;
          }

          const activeSession = useCliStore.getState().session;
          if (!activeSession) {
            console.log('❌ No active session');
            return;
          }

          // Get the selected message content to prefill the input
          const selectedMessage = activeSession.messages[messageIndex];
          const prefillContent = selectedMessage?.content || '';

          // Remove the selected message and all messages after it
          // The user will re-send the message (possibly edited) from the input
          const rewindedMessages = activeSession.messages.slice(0, messageIndex);

          // Recalculate metadata
          const newMetadata = recalculateSessionMetadata(rewindedMessages);

          // Create updated session
          const rewindedSession: Session = {
            ...activeSession,
            messages: rewindedMessages,
            updatedAt: new Date().toISOString(),
            metadata: {
              ...newMetadata,
              // Not derivable from message data - carry forward rather than zeroing
              subagentCalls: activeSession.metadata.subagentCalls,
              subagentTokens: activeSession.metadata.subagentTokens,
              subagentCost: activeSession.metadata.subagentCost,
            },
          };

          // Prefill the input with the selected message
          setState((prev: CliState) => ({
            ...prev,
            prefillInput: prefillContent,
          }));

          // Update the session in the store (single source of truth)
          setStoreSession(rewindedSession);
          useCliStore.getState().clearPendingMessages();

          // Save session
          await state.sessionStore.save(rewindedSession);

          console.log('✅ Conversation rewound successfully');
          console.log(`📊 Current state: ${rewindedMessages.length} messages, ${newMetadata.totalTokens} tokens`);
          console.log(`📝 Your message has been placed in the input. Edit and send when ready.\n`);
        };

        setState(prev => ({
          ...prev,
          rewindSelector: {
            resolve: handleRewindSelect,
          },
        }));
        break;
      }

      case 'undo': {
        if (!state.checkpointStore) {
          console.log('Checkpointing not available.');
          return;
        }
        const undoCheckpoints = state.checkpointStore.listCheckpoints();
        if (undoCheckpoints.length === 0) {
          console.log('No checkpoints available. No file changes have been made yet.');
          return;
        }
        try {
          const restored = await state.checkpointStore.undoLast();
          console.log(`\n✅ Restored ${restored.filePaths.length} file(s) to state before: ${restored.name}`);
          for (const f of restored.filePaths) {
            console.log(`  - ${f}`);
          }
          console.log('');
        } catch (err) {
          console.log(`Failed to undo: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      case 'checkpoints': {
        if (!state.checkpointStore) {
          console.log('Checkpointing not available.');
          return;
        }
        const cpList = state.checkpointStore.listCheckpoints();
        if (cpList.length === 0) {
          console.log('No checkpoints yet. Checkpoints are created automatically before file changes.');
          return;
        }
        console.log('\nCheckpoints (most recent first):\n');
        cpList.forEach((cp, idx) => {
          const ageMs = Date.now() - new Date(cp.timestamp).getTime();
          const ageSec = Math.floor(ageMs / 1000);
          let age: string;
          if (ageSec < 60) age = `${ageSec}s ago`;
          else if (ageSec < 3600) age = `${Math.floor(ageSec / 60)}m ago`;
          else age = `${Math.floor(ageSec / 3600)}h ago`;
          console.log(`  ${idx + 1}. ${cp.name} (${age}) - ${cp.filePaths.length} file(s)`);
        });
        console.log('\nUse /restore <number> to restore, /diff <number> to see changes.\n');
        break;
      }

      case 'restore': {
        if (!state.checkpointStore) {
          console.log('Checkpointing not available.');
          return;
        }
        const restoreTarget = args[0];
        if (!restoreTarget) {
          console.log('Usage: /restore <checkpoint-number>');
          console.log('Use /checkpoints to list available restore points.');
          return;
        }
        const restoreNum = parseInt(restoreTarget, 10);
        if (isNaN(restoreNum) || restoreNum < 1) {
          console.log('Please provide a valid checkpoint number. Use /checkpoints to list.');
          return;
        }
        try {
          const restoredCp = await state.checkpointStore.restoreCheckpoint(restoreNum);
          console.log(`\n✅ Restored to checkpoint: ${restoredCp.name}`);
          for (const f of restoredCp.filePaths) {
            console.log(`  - ${f}`);
          }
          console.log('');
        } catch (err) {
          console.log(`Failed to restore: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      case 'diff': {
        if (!state.checkpointStore) {
          console.log('Checkpointing not available.');
          return;
        }
        const diffTarget = args[0] ? parseInt(args[0], 10) : 1;
        if (isNaN(diffTarget) || diffTarget < 1) {
          console.log('Usage: /diff [checkpoint-number] (defaults to 1, most recent)');
          return;
        }
        try {
          const diffOutput = state.checkpointStore.getCheckpointDiff(diffTarget);
          if (!diffOutput.trim()) {
            console.log('No differences found between checkpoint and current state.');
          } else {
            console.log(diffOutput);
          }
        } catch (err) {
          console.log(`Failed to generate diff: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      case 'usage': {
        // Check authentication first
        const usageAuthTokens = await state.configStore.getAuthTokens();
        if (!usageAuthTokens || new Date(usageAuthTokens.expiresAt) <= new Date()) {
          console.log('\nNot authenticated. Run /login to authenticate.\n');
          return;
        }

        console.log('\nFetching usage data...');

        // Simple interface for identify response (we only need currentCredits)
        interface IdentifyResponse {
          user: { currentCredits: number };
          accessToken: string;
        }

        // Check cache first
        const now = Date.now();
        let currentCredits: number;
        let transactions: ICreditTransactionResponse[];

        if (usageCache && now - usageCache.timestamp < USAGE_CACHE_TTL) {
          // Use cached data
          currentCredits = usageCache.data.currentCredits;
          transactions = usageCache.data.transactions;
          console.log('(using cached data)\n');
        } else {
          // Fetch fresh data
          try {
            // Create API client on-demand
            const config = await state.configStore.get();
            const apiBaseURL = requireApiUrl(config.apiConfig);
            const apiClient = new ApiClient(apiBaseURL, state.configStore);

            // Fetch user info and transactions in parallel
            const [identifyResponse, transactionsResponse] = await Promise.all([
              apiClient.get<IdentifyResponse>('/api/identify'),
              apiClient.get<ICreditTransactionResponse[]>(`/api/credits/transactions?days=${USAGE_DAYS}`),
            ]);

            // Validate API response format
            if (!identifyResponse?.user?.currentCredits && identifyResponse?.user?.currentCredits !== 0) {
              throw new Error('Invalid response format from /api/identify');
            }

            currentCredits = identifyResponse.user.currentCredits;
            transactions = transactionsResponse || [];

            // Update cache
            usageCache = {
              data: { currentCredits, transactions },
              timestamp: now,
            };
          } catch (error) {
            if (isAxiosError(error)) {
              if (error.response?.status === 401) {
                console.log('\n❌ Authentication failed. Run /login to re-authenticate.\n');
              } else if (error.response?.status === 403) {
                console.log('\n❌ Access denied. You may not have permission to view usage data.\n');
              } else if (error.response?.status === 404) {
                console.log('\n❌ Usage endpoint not available on this server.\n');
              } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
                console.log('\n❌ Cannot connect to server. Check your API configuration with /api-info\n');
              } else {
                console.log(`\n❌ Error fetching usage data: ${error.message}\n`);
              }
            } else if (error instanceof Error) {
              console.log(`\n❌ Error: ${error.message}\n`);
            } else {
              console.log('\n❌ Unexpected error fetching usage data. Please try again.\n');
            }
            break;
          }
        }

        // Filter deduct transactions and calculate metrics
        const deductTransactions = transactions.filter(t =>
          (CREDIT_DEDUCT_TRANSACTION_TYPES as readonly string[]).includes(t.type)
        );

        // Calculate total credits used (absolute value since deducts are negative)
        const totalCreditsUsed = deductTransactions.reduce((sum, t) => sum + Math.abs(t.credits), 0);

        // Daily burn rate (credits used / USAGE_DAYS)
        const dailyBurnRate = Math.round(totalCreditsUsed / USAGE_DAYS);

        // Days remaining
        let daysRemainingStr: string;
        if (dailyBurnRate === 0) {
          daysRemainingStr = 'N/A (no usage)';
        } else {
          const daysRemaining = Math.floor(currentCredits / dailyBurnRate);
          daysRemainingStr = `~${daysRemaining.toLocaleString()} days`;
        }

        // Usage by model
        const usageByModel: Record<string, number> = {};
        for (const t of deductTransactions) {
          // Model name can be in metadata.modelName or directly on model field (for usage transactions)
          const modelName =
            (t.metadata as { modelName?: string } | undefined)?.modelName ||
            ('model' in t ? (t.model as string) : null) ||
            'Unknown';
          usageByModel[modelName] = (usageByModel[modelName] || 0) + Math.abs(t.credits);
        }

        // Sort by usage descending
        const sortedModels = Object.entries(usageByModel).sort((a, b) => b[1] - a[1]);

        // Display formatted output
        console.log('\n Credit Usage Summary');
        console.log('═══════════════════════════════════════\n');
        console.log(`Credits Balance:    ${currentCredits.toLocaleString()}`);
        console.log(`Daily Burn Rate:    ${dailyBurnRate.toLocaleString()} credits/day`);
        console.log(`Days Remaining:     ${daysRemainingStr}`);

        if (currentCredits === 0) {
          console.log('\n⚠️  You have no credits remaining.');
          // Credits page is build-time configured; omit the line for an
          // unbranded fork that hasn't set one.
          const creditsUrl = getCreditsUrl();
          if (creditsUrl) {
            console.log(`💡 Visit ${creditsUrl} to purchase more credits.\n`);
          }
          break;
        }

        if (sortedModels.length > 0) {
          console.log(`\nUsage by Model (Last ${USAGE_DAYS} days):`);
          for (const [model, credits] of sortedModels) {
            const percentage = totalCreditsUsed > 0 ? Math.round((credits / totalCreditsUsed) * 100) : 0;
            // Pad model name for alignment using constant
            const paddedModel = model.padEnd(MODEL_NAME_COLUMN_WIDTH);
            console.log(`  ${paddedModel}${credits.toLocaleString()} credits (${percentage}%)`);
          }
        } else {
          console.log(`\nNo usage data available for the last ${USAGE_DAYS} days.`);
        }

        break;
      }

      case 'context': {
        const session = useCliStore.getState().session;
        if (!session) {
          console.log('No active session');
          break;
        }

        const tokenCounter = getTokenCounter();
        const contextWindow = tokenCounter.getContextWindow(session.model, state.availableModels);

        // Calculate token counts for each component (reflect the variant the user has selected)
        const variantForCount = state.config?.preferences.promptVariant ?? 'current';
        const corePromptTokens = tokenCounter.countTokens(buildSystemPrompt(variantForCount));
        const projectContextTokens = state.contextContent ? tokenCounter.countTokens(state.contextContent) : 0;
        const commands = state.customCommandStore.getAllCommands();
        const skillsSection = buildSkillsPromptSection(commands);
        const skillsTokens = skillsSection ? tokenCounter.countTokens(skillsSection) : 0;
        const agentDirectoryTokens = state.agentStore
          ? tokenCounter.countTokens(state.agentStore.getDirectoryContext())
          : 0;
        const mcpTools = state.mcpManager?.getTools() || [];
        // MCP tool schemas are deferred - they no longer count against the
        // initial context. Only the directory of names (rendered inside the
        // system prompt) and any schemas the agent has loaded via tool_search
        // contribute. The directory cost is baked into systemPrompt below; the
        // loaded-schema cost is added to totalWithTools via agentToolsTokens.
        const deferredNames = deferredToolRegistry.getDirectoryNames();
        const mcpToolCount = state.mcpManager?.getToolCount() || [];

        const systemPrompt = buildSystemPrompt(variantForCount, {
          contextContent: state.contextContent,
          agentStore: state.agentStore || undefined,
          customCommands: commands,
          enableSkillTool: state.config?.preferences.enableSkillTool !== false,
          additionalDirectories: state.additionalDirectories,
          featureModulePrompts: state.featureRegistry?.getSystemPromptSections() || undefined,
          deferredToolNames: deferredNames,
        });
        const usage = tokenCounter.countSessionTokens(session, systemPrompt);
        // Tool schemas ship with every request - count whatever is currently
        // loaded on the agent (built-ins + any MCP/B4M schemas hydrated via
        // tool_search). Without this the meter under-reports real usage by
        // the size of the loaded schemas.
        const agentTools = state.agent?.getTools() ?? [];
        const agentToolsTokens = tokenCounter.countToolSchemaTokens(agentTools);
        const totalWithTools = usage.totalTokens + agentToolsTokens;
        const usagePercent = (totalWithTools / contextWindow) * 100;

        // Build visual progress bar
        const BAR_WIDTH = 40;
        const filledWidth = Math.min(Math.round((usagePercent / 100) * BAR_WIDTH), BAR_WIDTH);
        const bar = '\u2588'.repeat(filledWidth) + '\u2591'.repeat(BAR_WIDTH - filledWidth);

        // Display context usage summary
        console.log('\n\u{1F4CA} Context Usage:');
        console.log(`[${bar}] ${usagePercent.toFixed(1)}%`);
        console.log(`${(totalWithTools / 1000).toFixed(1)}k / ${(contextWindow / 1000).toFixed(0)}k tokens\n`);

        // System prompt breakdown
        console.log('System Prompt Breakdown:');
        console.log(`  Core Instructions: ${corePromptTokens.toLocaleString()} tokens`);
        if (projectContextTokens > 0) {
          console.log(`  Project Context:   ${projectContextTokens.toLocaleString()} tokens (CLAUDE.md)`);
        }
        if (commands.length > 0) {
          console.log(`  Skills Section:    ${skillsTokens.toLocaleString()} tokens (${commands.length} skills)`);
        }
        if (agentDirectoryTokens > 0) {
          const agentCount = state.agentStore?.getAgentCount() || 0;
          console.log(`  Agent Directory:   ${agentDirectoryTokens.toLocaleString()} tokens (${agentCount} agents)`);
        }

        // MCP tools breakdown (schemas deferred; only the directory of names
        // is in the system prompt). Loaded schemas (built-ins + any hydrated
        // via tool_search) are reported separately so the meter is honest.
        if (mcpTools.length > 0) {
          console.log('\nMCP Tools (deferred):');
          console.log(`  Schemas:           load on demand via tool_search (${mcpTools.length} tools available)`);
          for (const { serverName, count } of mcpToolCount) {
            console.log(`    ${serverName}: ${count} tools`);
          }
        }
        if (agentTools.length > 0) {
          console.log('\nLoaded Tool Schemas:');
          console.log(
            `  Schemas:           ${agentToolsTokens.toLocaleString()} tokens (${agentTools.length} tools active)`
          );
        }

        // Conversation tokens
        console.log('\nConversation:');
        console.log(
          `  Messages:          ${usage.messageTokens.toLocaleString()} tokens (${session.messages.length} messages)`
        );

        // Warning if context is nearly full
        if (usagePercent >= 80) {
          console.log(`\n\u26A0\uFE0F  Warning: Context is ${usagePercent.toFixed(0)}% full`);
          console.log('   Run /compact to summarize and free space');
        }
        console.log('');
        break;
      }

      case 'compact': {
        const session = useCliStore.getState().session;
        if (!session || !state.agent) {
          console.log('No active session');
          break;
        }

        if (session.messages.length < 6) {
          console.log('Not enough messages to compact (need at least 6)');
          break;
        }

        const userInstructions = args.join(' ') || undefined;

        const { prompt: compactionPrompt, preservedMessages } = buildCompactionPrompt(session.messages, {
          userInstructions,
          claudeMdInstructions: extractCompactInstructions(state.contextContent || ''),
        });

        if (!compactionPrompt) {
          console.log('Not enough messages to compact');
          break;
        }

        console.log('\u{1F5DC}\uFE0F  Compacting conversation...\n');

        // Set thinking state
        useCliStore.getState().setIsThinking(true);

        try {
          // Use agent to generate summary (single iteration, no tools)
          const result = await state.agent.run(compactionPrompt, { maxIterations: 1 });
          const summary = result.finalAnswer;

          // Save old session first
          await state.sessionStore.save(session);
          const oldSessionName = session.name;

          // Create new compacted session
          const newSession = createCompactedSession(
            session,
            summary,
            preservedMessages,
            !!(process.env.B4M_SESSION_ID || process.env.B4M_RESUME_ID)
          );

          // Reinitialize logger with new session ID
          await logger.initialize(newSession.id);

          // Update the session in the store (single source of truth)
          setStoreSession(newSession);
          useCliStore.getState().clearPendingMessages();

          console.log('\u2705 Conversation compacted');
          console.log(`\u{1F4DD} New session: ${newSession.name}`);
          console.log(`\u{1F4BE} Previous session preserved: ${oldSessionName}\n`);
        } finally {
          useCliStore.getState().setIsThinking(false);
        }
        break;
      }

      case 'project-config': {
        const projectDir = state.configStore.getProjectConfigDir();
        const config = await state.configStore.get();

        console.log('\n📁 Project Configuration:\n');

        if (projectDir) {
          console.log(`Project Directory: ${projectDir}/.bike4mind/`);
          console.log('');

          const projectConfig = await state.configStore.loadRawProjectConfig();
          const localConfig = await state.configStore.loadRawProjectLocalConfig();

          if (projectConfig) {
            console.log('Team Config (.bike4mind/config.json):');
            if (projectConfig.defaultModel) {
              console.log(`  Default Model: ${projectConfig.defaultModel}`);
            }
            if (projectConfig.tools?.denied && projectConfig.tools.denied.length > 0) {
              console.log(`  Denied Tools: ${projectConfig.tools.denied.join(', ')}`);
            }
            if (projectConfig.mcpServers && projectConfig.mcpServers.length > 0) {
              console.log(`  MCP Servers: ${projectConfig.mcpServers.map(s => s.name).join(', ')}`);
            }
            console.log('');
          }

          if (localConfig) {
            console.log('Local Config (.bike4mind/local.json):');
            if (localConfig.trustedTools && localConfig.trustedTools.length > 0) {
              console.log(`  Trusted Tools: ${localConfig.trustedTools.join(', ')}`);
            }
            if (localConfig.mcpServers && localConfig.mcpServers.length > 0) {
              console.log(`  MCP Servers: ${localConfig.mcpServers.map(s => s.name).join(', ')}`);
            }
            console.log('');
          }

          console.log("Merged Configuration (what you're using):");
          console.log(`  Default Model: ${config.defaultModel}`);
          console.log(`  Trusted Tools: ${config.trustedTools?.length || 0} tools`);
          console.log(`  Denied Tools: ${config.tools.disabled.length} tools`);
          console.log(`  MCP Servers: ${config.mcpServers.length} servers`);
        } else {
          console.log('No project configuration found.');
          console.log('Tip: Create .bike4mind/config.json in your project root for team-wide settings.');
        }

        console.log('');
        break;
      }

      case 'commands': {
        const customCommands = state.customCommandStore.getAllCommands();
        const globalCommands = state.customCommandStore.getCommandsBySource('global');
        const projectCommands = state.customCommandStore.getCommandsBySource('project');

        console.log('\n📝 Custom Commands:\n');

        if (customCommands.length === 0) {
          console.log('No custom commands found.');
          console.log('\nTo create a custom command:');
          console.log('  /commands:new <name> - Create a new command');
          console.log('\nCustom commands can be stored in:');
          console.log('  🏠 Global: ~/.bike4mind/commands/ (available in all projects)');
          console.log('  📁 Project: .bike4mind/commands/ (team-shared, committed to git)');
        } else {
          const termWidth = process.stdout.columns || 80;
          const truncateDescription = (desc: string, prefixLen: number): string => {
            const maxDescLen = termWidth - prefixLen - 5; // 5 for " - " and "..."
            if (maxDescLen < 20) return desc; // Don't truncate if too narrow
            return desc.length > maxDescLen ? desc.slice(0, maxDescLen) + '...' : desc;
          };

          if (globalCommands.length > 0) {
            console.log('🏠 Global Commands (~/.bike4mind/commands/):');
            globalCommands.forEach(cmd => {
              const argHint = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
              const prefix = `  /${cmd.name}${argHint}`;
              const desc = truncateDescription(cmd.description, prefix.length);
              console.log(`${prefix} - ${desc}`);
            });
            console.log('');
          }

          if (projectCommands.length > 0) {
            console.log('📁 Project Commands (.bike4mind/commands/):');
            projectCommands.forEach(cmd => {
              const argHint = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
              const prefix = `  /${cmd.name}${argHint}`;
              const desc = truncateDescription(cmd.description, prefix.length);
              console.log(`${prefix} - ${desc}`);
            });
            console.log('');
          }

          console.log(`Total: ${customCommands.length} custom command${customCommands.length !== 1 ? 's' : ''}`);
        }

        console.log('');
        break;
      }

      case 'commands:new': {
        const commandName = args[0];
        if (!commandName) {
          console.log('❌ Please provide a command name');
          console.log('Usage: /commands:new <name>');
          break;
        }

        // Ask if global or project
        console.log('\nWhere should this command be stored?');
        console.log('  1. 🏠 Global (~/.bike4mind/commands/) - available in all projects');
        console.log('  2. 📁 Project (.bike4mind/commands/) - team-shared');
        console.log('\nDefaulting to global. Creating command file...');

        try {
          const filePath = await state.customCommandStore.createCommandFile(commandName, true);
          console.log(`✅ Created command file: ${filePath}`);
          console.log('\nEdit this file to customize your command.');
          console.log('Then run: /commands:reload to load it');
        } catch (error) {
          console.error('❌ Failed to create command file:', error instanceof Error ? error.message : String(error));
        }

        break;
      }

      case 'commands:reload': {
        try {
          await state.customCommandStore.reloadCommands();
          const count = state.customCommandStore.getCommandCount();
          console.log(`✅ Reloaded ${count} custom command${count !== 1 ? 's' : ''}`);
        } catch (error) {
          console.error('❌ Failed to reload commands:', error instanceof Error ? error.message : String(error));
        }
        break;
      }

      case 'mcp':
      case 'mcp:list': {
        // Open full-screen MCP server status viewer
        setShowMcpViewer(true);
        break;
      }

      case 'agents':
      case 'agents:list': {
        if (!state.agentStore) {
          console.log('❌ Agent store not initialized');
          break;
        }

        const summary = state.agentStore.getSummary();
        console.log('\n🤖 Available Agents:\n');

        if (summary.total === 0) {
          console.log('No agents found.');
          console.log('\nTo create a custom agent:');
          console.log('  /agents:new <name> - Create a new agent');
        } else {
          displayAgentsBySource(state.agentStore.getAgentsBySource('builtin'), 'Built-in Agents', '📦');
          displayAgentsBySource(
            state.agentStore.getAgentsBySource('global'),
            'Global Agents (~/.claude/agents/ or ~/.bike4mind/agents/)',
            '🏠'
          );
          displayAgentsBySource(
            state.agentStore.getAgentsBySource('project'),
            'Project Agents (.claude/agents/ or .bike4mind/agents/)',
            '📁'
          );

          console.log(
            `Total: ${summary.total} agent${summary.total !== 1 ? 's' : ''} ` +
              `(${summary.builtin} built-in, ${summary.global} global, ${summary.project} project)`
          );
        }

        console.log('');
        break;
      }

      case 'agents:new': {
        if (!state.agentStore) {
          console.log('❌ Agent store not initialized');
          break;
        }

        const agentName = args[0];
        if (!agentName) {
          console.log('❌ Please provide an agent name');
          console.log('Usage: /agents:new <name>');
          break;
        }

        console.log('\nWhere should this agent be stored?');
        console.log('  1. 🏠 Global (~/.claude/agents/) - available in all projects');
        console.log('  2. 📁 Project (.claude/agents/) - team-shared');
        console.log('\nDefaulting to global (~/.claude/agents/). Creating agent file...');

        try {
          const filePath = await state.agentStore.createAgentFile(agentName, true);
          console.log(`✅ Created agent file: ${filePath}`);
          console.log('\nEdit this file to customize your agent.');
          console.log('Then run: /agents:reload to load it');
        } catch (error) {
          console.error('❌ Failed to create agent file:', error instanceof Error ? error.message : String(error));
        }

        break;
      }

      case 'agents:reload': {
        if (!state.agentStore) {
          console.log('❌ Agent store not initialized');
          break;
        }

        try {
          await state.agentStore.reloadAgents();
          const summary = state.agentStore.getSummary();
          console.log(
            `✅ Reloaded ${summary.total} agent${summary.total !== 1 ? 's' : ''} ` +
              `(${summary.builtin} built-in, ${summary.global} global, ${summary.project} project)`
          );
        } catch (error) {
          console.error('❌ Failed to reload agents:', error instanceof Error ? error.message : String(error));
        }
        break;
      }

      // --- Sandbox commands ---
      case 'sandbox': {
        if (!state.sandboxOrchestrator) {
          console.log('\nSandbox: Not initialized');
          break;
        }
        const status = state.sandboxOrchestrator.getStatus();
        console.log('\nSandbox Status:');
        console.log(`  Enabled:   ${status.enabled ? 'Yes' : 'No'}`);
        console.log(`  Mode:      ${status.mode}`);
        console.log(`  Platform:  ${status.platform ?? 'N/A'}`);
        console.log(`  Runtime:   ${status.runtimeName ?? 'N/A'}`);
        console.log(`  Available: ${status.runtimeAvailable ? 'Yes' : 'No'}`);
        console.log('');
        console.log('Filesystem Config:');
        console.log(`  Write only to CWD: ${status.config.filesystem.writeOnlyToWorkingDir}`);
        console.log(`  Allowed reads: ${status.config.filesystem.allowedReadPaths.join(', ') || '(none)'}`);
        console.log(`  Denied paths:  ${status.config.filesystem.deniedPaths.join(', ') || '(none)'}`);
        console.log(`  Excluded cmds: ${status.config.excludedCommands.join(', ') || '(none)'}`);
        console.log('');
        console.log('Network Filtering:');
        console.log(`  Enabled:  ${status.config.network.enabled ? 'Yes' : 'No'}`);
        console.log(`  Proxy:    ${status.proxyRunning ? `running on port ${status.proxyPort}` : 'stopped'}`);
        console.log(`  Domains:  ${status.config.network.allowedDomains.length} allowed`);
        console.log('');
        if (status.stats) {
          const total = status.stats.sandboxed + status.stats.unsandboxed + status.stats.blocked;
          console.log('Session Stats:');
          console.log(`  Total commands: ${total}`);
          console.log(`  Sandboxed:     ${status.stats.sandboxed}`);
          console.log(`  Unsandboxed:   ${status.stats.unsandboxed}`);
          console.log(`  Blocked:       ${status.stats.blocked}`);
          console.log(`  Violations:    ${status.stats.violations}`);
          console.log('');
        }
        break;
      }

      case 'sandbox:enable': {
        if (!state.sandboxOrchestrator) {
          console.log('Sandbox not initialized');
          break;
        }
        if (!state.sandboxOrchestrator.isAvailable()) {
          console.log('Sandbox runtime not available on this platform');
          break;
        }
        state.sandboxOrchestrator.setMode('auto-allow');
        state.permissionManager?.setSandboxState('auto-allow', state.sandboxOrchestrator.isActive());
        // Start network proxy if enabled
        const sandboxCfg = state.sandboxOrchestrator.getConfig();
        if (sandboxCfg.network.enabled) {
          await state.sandboxOrchestrator.startProxy();
          const pm = state.sandboxOrchestrator.getProxyManager();
          if (pm?.isRunning()) {
            console.log(`🌐 Network proxy started on port ${pm.getPort()}`);
          }
        }
        // Persist to config
        const config = await state.configStore.get();
        await state.configStore.save({
          ...config,
          sandbox: { ...state.sandboxOrchestrator.getConfig() },
        });
        console.log('Sandbox enabled (auto-allow mode)');
        break;
      }

      case 'sandbox:disable': {
        if (!state.sandboxOrchestrator) {
          console.log('Sandbox not initialized');
          break;
        }
        await state.sandboxOrchestrator.stopProxy();
        state.sandboxOrchestrator.setMode('disabled');
        state.permissionManager?.setSandboxState('disabled', false);
        const disableConfig = await state.configStore.get();
        await state.configStore.save({
          ...disableConfig,
          sandbox: { ...state.sandboxOrchestrator.getConfig() },
        });
        console.log('Sandbox disabled');
        break;
      }

      case 'sandbox:mode': {
        if (!state.sandboxOrchestrator) {
          console.log('Sandbox not initialized');
          break;
        }
        const modeArg = args[0];
        if (modeArg !== 'auto-allow' && modeArg !== 'permissions') {
          console.log('Usage: /sandbox:mode <auto-allow|permissions>');
          break;
        }
        if (!state.sandboxOrchestrator.isAvailable()) {
          console.log('Sandbox runtime not available on this platform');
          break;
        }
        state.sandboxOrchestrator.setMode(modeArg);
        state.permissionManager?.setSandboxState(modeArg, state.sandboxOrchestrator.isActive());
        const modeConfig = await state.configStore.get();
        await state.configStore.save({
          ...modeConfig,
          sandbox: { ...state.sandboxOrchestrator.getConfig() },
        });
        console.log(`Sandbox mode set to: ${modeArg}`);
        break;
      }

      case 'sandbox:trust-domain': {
        if (!state.sandboxOrchestrator) {
          console.log('Sandbox not initialized');
          break;
        }
        if (args.length === 0) {
          console.log('Usage: /sandbox:trust-domain <domain> [...]');
          break;
        }
        const proxyMgr = state.sandboxOrchestrator.getProxyManager();
        if (!proxyMgr) {
          console.log('Network proxy not initialized');
          break;
        }
        for (const domain of args) {
          proxyMgr.addAllowedDomain(domain);
          console.log(`  Added: ${domain}`);
        }
        // Persist to config
        const trustDomainConfig = await state.configStore.get();
        const currentSandboxConfig = state.sandboxOrchestrator.getConfig();
        await state.configStore.save({
          ...trustDomainConfig,
          sandbox: {
            ...currentSandboxConfig,
            network: {
              ...currentSandboxConfig.network,
              allowedDomains: proxyMgr.getAllowedDomains(),
            },
          },
        });
        console.log(`Trusted ${args.length} domain(s)`);
        break;
      }

      case 'sandbox:domains': {
        if (!state.sandboxOrchestrator) {
          console.log('Sandbox not initialized');
          break;
        }
        const domainProxyMgr = state.sandboxOrchestrator.getProxyManager();
        if (!domainProxyMgr) {
          console.log('Network proxy not initialized');
          break;
        }
        const domains = domainProxyMgr.getAllowedDomains().sort();
        console.log(`\nAllowed domains (${domains.length}):`);
        for (const d of domains) {
          console.log(`  ${d}`);
        }
        console.log('');
        break;
      }

      case 'terminal-setup': {
        const { runTerminalSetup } = await import('./utils/terminalSetup.js');
        await runTerminalSetup();
        break;
      }

      case 'add-dir': {
        let dirPath = args.join(' ').trim();
        if (!dirPath) {
          console.log('Usage: /add-dir <path>');
          console.log('\nExample:');
          console.log('  /add-dir /path/to/directory');
          console.log('  /add-dir ~/codes/my-project');
          break;
        }

        // Expand tilde to home directory
        if (dirPath.startsWith('~/')) {
          dirPath = path.join(homedir(), dirPath.slice(2));
        } else if (dirPath === '~') {
          dirPath = homedir();
        }

        const resolvedPath = path.resolve(dirPath);

        // Check if directory exists
        if (!existsSync(resolvedPath)) {
          console.log(`❌ Directory does not exist: ${resolvedPath}`);
          break;
        }

        // Check if it's actually a directory
        const dirStat = await fs.stat(resolvedPath);
        if (!dirStat.isDirectory()) {
          console.log(`❌ Path is not a directory: ${resolvedPath}`);
          break;
        }

        // Add to config
        await state.configStore.addDirectory(resolvedPath);

        // Update session state
        setState(prev => ({
          ...prev,
          additionalDirectories: [...(prev.additionalDirectories || []), resolvedPath],
        }));

        console.log(`✅ Added directory: ${resolvedPath}`);
        console.log('   File tools now have access to this directory.');
        break;
      }

      case 'remove-dir': {
        let removeDir = args.join(' ').trim();
        if (!removeDir) {
          console.log('Usage: /remove-dir <path>');
          break;
        }

        // Expand tilde to home directory
        if (removeDir.startsWith('~/')) {
          removeDir = path.join(homedir(), removeDir.slice(2));
        } else if (removeDir === '~') {
          removeDir = homedir();
        }

        const resolvedRemovePath = path.resolve(removeDir);

        // Remove from config
        await state.configStore.removeDirectory(resolvedRemovePath);

        // Update session state
        setState(prev => ({
          ...prev,
          additionalDirectories: (prev.additionalDirectories || []).filter(d => path.resolve(d) !== resolvedRemovePath),
        }));

        console.log(`✅ Removed directory: ${resolvedRemovePath}`);
        break;
      }

      case 'decisions': {
        printDecisions();
        break;
      }

      case 'blockers': {
        printBlockers();
        break;
      }

      case 'review-gates': {
        printReviewGates();
        break;
      }

      case 'handoff': {
        await runHandoffCommand(args);
        break;
      }

      case 'workflow': {
        const sub = args[0];
        const subArgs = args.slice(1);
        switch (sub) {
          case undefined:
          case '':
            printWorkflowOverview();
            break;
          case 'decisions':
            printDecisions();
            break;
          case 'blockers':
            printBlockers();
            break;
          case 'review-gates':
          case 'gates':
            printReviewGates();
            break;
          case 'handoff':
            await runHandoffCommand(subArgs);
            break;
          default:
            console.log(`Unknown /workflow subcommand: ${sub}`);
            console.log('Available: decisions, blockers, handoff, review-gates (alias: gates)');
            break;
        }
        break;
      }

      case 'dirs': {
        const additionalDirs = await state.configStore.getAdditionalDirectories();
        const cwd = process.cwd();

        console.log('\n📂 Accessible Directories:\n');
        console.log(`  📁 Working directory: ${cwd}`);

        if (additionalDirs.length > 0) {
          console.log('\n  📁 Additional directories:');
          additionalDirs.forEach(d => {
            console.log(`     ${d}`);
          });
        } else {
          console.log('\n  No additional directories configured.');
          console.log('  Use /add-dir <path> or --add-dir <path> flag to add directories.');
        }

        console.log('');
        break;
      }

      case 'sandbox:violations': {
        const vStore = state.sandboxOrchestrator?.getViolationStore();
        if (!vStore) {
          console.log('Violation tracking not initialized');
          break;
        }
        const requestedCount = parseInt(args[0], 10);
        const violations = await vStore.getRecent(Number.isNaN(requestedCount) ? 20 : requestedCount);
        if (violations.length === 0) {
          console.log('\nNo sandbox violations recorded.\n');
          break;
        }

        console.log(`\n\x1b[1mRecent Sandbox Violations\x1b[0m (${violations.length}):\n`);
        for (const v of violations) {
          const time = new Date(v.timestamp).toLocaleTimeString();
          const typeColor = v.type === 'filesystem' ? '\x1b[33m' : '\x1b[36m';
          const typeLabel = v.type === 'filesystem' ? 'FS ' : 'NET';
          const target = v.path ?? v.domain ?? '';
          console.log(`  ${typeColor}${typeLabel}\x1b[0m ${time} \x1b[90m${v.blockedBy}\x1b[0m ${target}`);
          if (v.detail) {
            console.log(`       \x1b[90m${v.detail.slice(0, 120)}\x1b[0m`);
          }
        }
        console.log('');
        break;
      }

      case 'sandbox:violations:clear': {
        const clearStore = state.sandboxOrchestrator?.getViolationStore();
        if (!clearStore) {
          console.log('Violation tracking not initialized');
          break;
        }
        await clearStore.clear();
        state.sandboxOrchestrator?.resetStats();
        console.log('Violation log cleared.');
        break;
      }

      default: {
        // Delegate to feature module commands before showing unknown
        if (state.featureRegistry?.executeCommand(command, args)) {
          break;
        }
        console.log(`Unknown command: /${command}`);
        console.log('Type /help for available commands');
      }
    }
  };

  /**
   * Handle saving config from the interactive editor
   */
  const handleSaveConfig = async (updatedConfig: CliConfig): Promise<void> => {
    await state.configStore.save(updatedConfig);

    // Check if model changed
    const modelChanged = state.config?.defaultModel !== updatedConfig.defaultModel;

    // Check if feature module config changed
    const featuresChanged =
      JSON.stringify(state.config?.features ?? {}) !== JSON.stringify(updatedConfig.features ?? {});

    // Hot-reload feature modules if features changed
    let newFeatureRegistry = state.featureRegistry;
    if (featuresChanged && state.agent) {
      // Dispose old registry (unsubscribes WS handlers)
      state.featureRegistry?.disposeAll();

      // Clear old feature tool registrations from ToolRouter
      clearFeatureModuleTools();

      // Create fresh registry with new config
      newFeatureRegistry = new FeatureModuleRegistry();
      const apiClient = new ApiClient(requireApiUrl(updatedConfig.apiConfig), state.configStore);

      if (updatedConfig.features?.tavern) {
        newFeatureRegistry.register(
          new TavernModule(
            apiClient,
            entry => useCliStore.getState().addTavernLogEntry(entry),
            () => useCliStore.getState().tavernActivityLog
          )
        );
      }

      // Register new tool names with ToolRouter
      const newToolNames = newFeatureRegistry.getAllToolNames();
      if (newToolNames.length > 0) {
        registerFeatureModuleTools(newToolNames);
      }

      // Register new WS handlers
      if (state.wsManager && newFeatureRegistry.hasModules) {
        newFeatureRegistry.registerAllWsHandlers(state.wsManager);
      }

      // Hot-swap agent tools: remove old feature tools, add new ones
      const oldFeatureToolNames = new Set(state.featureRegistry?.getAllToolNames() ?? []);
      const baseTools = state.agent.getTools().filter(t => !oldFeatureToolNames.has(t.toolSchema.name));
      const newFeatureTools = newFeatureRegistry.getAllTools();
      state.agent.setTools([...baseTools, ...newFeatureTools]);

      // Rebuild system prompt with new feature module sections
      const newFeaturePrompts = newFeatureRegistry.getSystemPromptSections();
      const currentInteractionMode = useCliStore.getState().interactionMode;
      const rebuildSession = useCliStore.getState().session;
      const planFilePathForRebuild =
        currentInteractionMode === 'plan' && rebuildSession ? getPlanModeFilePath(rebuildSession.id) : undefined;
      state.agent.setSystemPrompt(
        buildSystemPrompt(updatedConfig.preferences.promptVariant ?? 'current', {
          contextContent: state.contextContent,
          agentStore: state.agentStore || undefined,
          customCommands: state.customCommandStore.getAllCommands(),
          enableSkillTool: updatedConfig.preferences.enableSkillTool !== false,
          enableDynamicAgentCreation: updatedConfig.preferences.enableDynamicAgentCreation === true,
          additionalDirectories: state.additionalDirectories,
          featureModulePrompts: newFeaturePrompts || undefined,
          planModeFilePath: planFilePathForRebuild,
          appendSystemPrompt: process.env.B4M_APPEND_SYSTEM_PROMPT,
          deferredToolNames: deferredToolRegistry.getDirectoryNames(),
        })
      );

      const moduleNames = newFeatureRegistry.getModuleNames();
      if (moduleNames.length > 0) {
        console.error(`\n\x1b[36m🏰 Feature modules hot-reloaded: ${moduleNames.join(', ')}\x1b[0m`);
      } else {
        console.error(`\n\x1b[36m🏰 Feature modules disabled\x1b[0m`);
      }
    }

    // Update local state with new config (pure reducer - no side effects)
    setState(prev => {
      const updates: Partial<typeof prev> = { config: updatedConfig };

      if (featuresChanged) {
        updates.featureRegistry = newFeatureRegistry;
      }

      return { ...prev, ...updates };
    });

    // If the model changed, update the session model in the store (single source of truth)
    if (modelChanged) {
      const currentSession = useCliStore.getState().session;
      if (currentSession) {
        setStoreSession({
          ...currentSession,
          model: updatedConfig.defaultModel,
          updatedAt: new Date().toISOString(),
        });

        // Update the agent's model (context is private, but we can access it)
        if (state.agent) {
          (state.agent as any).context.model = updatedConfig.defaultModel;
        }
      }
    }

    // Update LLM backend's model if it changed
    // The LLM backend is stored in the agent's context
    if (modelChanged && state.agent) {
      const backend = (state.agent as any).context.llm as ServerLlmBackend | WebSocketLlmBackend | MultiLlmBackend;
      if (backend) {
        backend.currentModel = updatedConfig.defaultModel;
      }
    }
  };

  if (initError) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red" bold>
          ❌ Initialization Error
        </Text>
        <Text>{initError}</Text>
        <Text dimColor>{'\n'}Tip: Run /config to set up your API keys</Text>
      </Box>
    );
  }

  // Show trust location selector if requested
  if (state.trustLocationSelector) {
    const projectDir = state.configStore.getProjectConfigDir();
    const inProject = projectDir !== null;

    return (
      <TrustLocationSelector
        inProject={inProject}
        onSelect={location => {
          if (state.trustLocationSelector) {
            state.trustLocationSelector.resolve(location);
          }
        }}
        onCancel={() => {
          if (state.trustLocationSelector) {
            state.trustLocationSelector.resolve(null);
          }
        }}
      />
    );
  }

  // The rewind/session selectors below are each gated behind React state
  // (`state.rewindSelector` / `state.sessionSelector`), which triggers this
  // re-render when set; the session is stable while a selector is open (the
  // agent is idle), so a single non-subscribing getState() snapshot is correct
  // for both branches.
  const currentSession = useCliStore.getState().session;

  // Show rewind selector if requested
  if (state.rewindSelector && currentSession) {
    return (
      <RewindSelector
        messages={currentSession.messages}
        onSelect={messageIndex => {
          if (state.rewindSelector) {
            state.rewindSelector.resolve(messageIndex);
          }
        }}
        onCancel={() => {
          if (state.rewindSelector) {
            state.rewindSelector.resolve(null);
          }
        }}
      />
    );
  }

  // Show session selector if requested
  if (state.sessionSelector) {
    return (
      <SessionSelector
        sessions={state.sessionSelector.sessions}
        currentSession={currentSession}
        onSelect={session => {
          if (state.sessionSelector) {
            state.sessionSelector.resolve(session);
          }
        }}
        onCancel={() => {
          if (state.sessionSelector) {
            state.sessionSelector.resolve(null);
          }
        }}
      />
    );
  }

  // Show the first-run backend picker when no endpoint is configured (checked
  // before the login flow, since a backend must be chosen before authenticating).
  if (state.showEnvironmentPicker) {
    return (
      <EnvironmentPicker
        onSelect={(choice: EnvChoice) => {
          void (async () => {
            try {
              const result = await state.configStore.switchApiEnvironment(choice.target);
              setState(prev => ({ ...prev, showEnvironmentPicker: false }));
              console.log(`\n✅ Connecting to ${result.envName} (${result.url})\n`);
              // Re-run init now that an endpoint is configured; it will proceed
              // into the login flow.
              init().catch(err => {
                console.error('\n❌ Initialization failed:', err.message, '\n');
                exit();
              });
            } catch (err) {
              setState(prev => ({ ...prev, showEnvironmentPicker: false }));
              console.error(`\n❌ Failed to save endpoint: ${err instanceof Error ? err.message : String(err)}\n`);
              exit();
            }
          })();
        }}
      />
    );
  }

  // Show login flow if requested (check BEFORE isInitialized to allow login when not authenticated)
  if (state.showLoginFlow) {
    const endpoint = resolveApiEndpoint(state.config?.apiConfig);

    // Defensive: init()'s login gate prevents entering the flow unconfigured,
    // so this only guards against a regression. Render an actionable message
    // rather than handing an empty baseURL to the OAuth client.
    if (endpoint.status === 'unconfigured') {
      return (
        <Box flexDirection="column" padding={1}>
          <Text color="red">{new ApiEndpointUnconfiguredError().message}</Text>
        </Box>
      );
    }

    return (
      <LoginFlow
        apiUrl={endpoint.url}
        configStore={state.configStore}
        onSuccess={() => {
          setState(prev => ({ ...prev, showLoginFlow: false }));
          console.log('\n✅ Login successful! Initializing CLI...\n');
          // Reinitialize after successful login
          init().catch(err => {
            console.error('\n❌ Initialization failed:', err.message, '\n');
            exit();
          });
        }}
        onError={error => {
          setState(prev => ({ ...prev, showLoginFlow: false }));
          console.error(`\n❌ Login failed: ${error.message}`);
          console.log("Run b4m again when you're ready to authenticate.\n");
          exit();
        }}
      />
    );
  }

  if (!isInitialized) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>🚀 Initializing...</Text>
      </Box>
    );
  }

  // Merge built-in, feature module, and custom commands for autocomplete
  const featureCommandDefs = (state.featureRegistry?.getAllCommands() ?? []).map(cmd => ({
    name: cmd.name,
    description: cmd.description,
  }));
  const allCommands = mergeCommands(state.customCommandStore.getAllCommands(), featureCommandDefs);

  return (
    <App
      onMessage={handleMessage}
      onBackgroundCompletion={handleBackgroundCompletion}
      onCommand={handleCommand}
      onBashCommand={handleBashCommand}
      onImageDetected={handleImageDetected}
      commandHistory={commandHistory}
      commands={allCommands}
      config={state.config}
      availableModels={state.availableModels}
      onSaveConfig={handleSaveConfig}
      prefillInput={state.prefillInput}
      onPrefillConsumed={() => {
        setState(prev => ({ ...prev, prefillInput: undefined }));
      }}
      mcpManager={state.mcpManager ?? undefined}
      onPermissionResponse={(response: PermissionResponse, promptId: string) => {
        // Route through the same store method the tavern uses: it looks up
        // the prompt by `promptId` (the id this Ink prompt was rendered
        // against), so a buffered keypress that arrived after the tavern
        // already answered + dequeued is a no-op instead of mis-resolving
        // the next active prompt.
        const resolved = useCliStore.getState().resolvePermissionPromptById(promptId, response);
        if (!resolved) return;
        // Tavern: close the resolver row + lift the awaiting state. Mirror
        // these for tavern parity even when the local Ink UI is the one
        // answering - otherwise the tavern modal would stay locked on
        // pending permission until the next status event.
        // NOTE: collapses 'allow-once' / 'allow-session' / 'allow-always'
        // into a single `allow: true`. If the schema gains a `scope` field,
        // pass `response` through here.
        // `resolvedBy: 'user'` is correct for this code path: auto-accept
        // and trusted-tool short-circuits in toolsAdapter never invoke
        // `promptFn`, so any prompt that reaches this handler was answered
        // by a human at the keyboard.
        void bridgePresence.emitEvent({
          type: 'permission_resolved',
          requestId: promptId,
          allow: response !== 'deny',
          resolvedBy: 'user',
        });
        // Deny is treated identically to pressing ESC during an active
        // prompt: fire the AbortController so the agent loop unwinds
        // through the same path as a user interrupt. The denied tool call
        // is NOT submitted to the backend as a tool observation - the
        // turn ends as "Interrupted" and the conversation history stays
        // clean. `emitNextAwaitingStatus` already early-returns when the
        // abort signal is set, so we skip calling it on deny.
        if (response === 'deny') {
          abortControllerRef.current?.abort();
          return;
        }
        emitNextAwaitingStatus();
      }}
      onUserQuestionResponse={(response: UserQuestionResponse, promptId: string) => {
        // Verify the active prompt still matches the one we rendered against
        // before resolving (defends against any future remote resolver path
        // landing first; today the active prompt is the only writer).
        const state = useCliStore.getState();
        const currentPrompt = state.userQuestionPrompt;
        if (currentPrompt?.id !== promptId) return;
        // Dequeue before resolving so any sync consumer reads the post-removal
        // store before the resolved promise drives downstream effects.
        // Matches `resolvePermissionPromptById` and `onReviewGateResponse`.
        dequeueUserQuestionPrompt();
        currentPrompt.resolve(response);
        emitNextAwaitingStatus();
      }}
      onReviewGateResponse={(response, promptId) => {
        // Mirror the userQuestion guard: only resolve if the rendered prompt
        // is still active. Defends against any future remote resolver path.
        const state = useCliStore.getState();
        const currentPrompt = state.reviewGatePrompt;
        if (currentPrompt?.id !== promptId) return;
        // Dequeue before resolving so any sync consumer reads the post-removal
        // store before the resolved promise drives downstream effects.
        // Matches `resolvePermissionPromptById`'s ordering.
        dequeueReviewGatePrompt();
        currentPrompt.resolve(response);
        emitNextAwaitingStatus();
      }}
    />
  );
}

// Banner is rendered alongside startup messages in init()

// Non-blocking update check (best-effort, 3s timeout)
try {
  const updateResult = await Promise.race([
    checkForUpdate(packageJson.version),
    new Promise<null>(resolve => setTimeout(() => resolve(null), 3000)),
  ]);
  if (updateResult?.updateAvailable) {
    console.log(
      `\x1b[33m  ⬆ Update available: v${updateResult.currentVersion} → v${updateResult.latestVersion} (run: b4m update)\x1b[0m\n`
    );
  }
} catch {
  // Silently ignore update check failures
}

// Show dev mode indicator when running via tsx (pnpm dev)
const isDevMode = import.meta.url.includes('/src/') || process.env.NODE_ENV === 'development';
if (isDevMode) {
  logger.debug('🔧 Running in development mode (using TypeScript source)\n');
}

// Start warming file cache in background for instant @ autocomplete
warmFileCache();

// Render on the terminal's main screen so message history (rendered via
// <Static>) lands in terminal scrollback and the user can scroll up with
// the terminal's native mouse-wheel/scrollbar. Trade-off: Ink 7.0.1 has
// a known resize-render bug where widening the terminal can leave ghost
// frames in scrollback. Re-evaluate when upgrading Ink.
render(<CliApp />, {
  exitOnCtrlC: false,
});
