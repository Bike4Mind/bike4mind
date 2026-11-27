import { z } from 'zod';
import { registerOrchestrationIpc } from './orchestrationIpc';
import { createStudioDiagnostics } from './studio/StudioDiagnostics';
import { registerStudio } from './studio/registerStudio';
import { homedir } from 'node:os';
import { registerLibrary } from './library/registerLibrary';
import { registerProductions } from './productions/registerProductions';
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { PERMISSION_LISTS, type PermissionRuleLists, type PermissionScope } from '@shared/permissions';
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  nativeImage,
  net,
  shell,
  type WebContents,
} from 'electron';
import { isPromptCacheTtl } from '@bike4mind/common';
import type {
  ChatApprovalAnswer,
  ChatApprovalMode,
  ChatArtifactPublishRequest,
  ChatAttachmentInput,
  ChatSessionStatusEvent,
  ChatStreamEvent,
  StartSpawnSuggestionRequest,
  StartSideChatRequest,
  UpdateProjectRequest,
} from '@shared/chat';
import type { CookieImportRequest } from '@shared/browserCookies';
import type { CapabilitySubject } from '@shared/capabilities';
import type {
  SkillMarketFilters,
  SkillMarketImportRequest,
  SkillMarketListingRef,
  SkillMarketWebTarget,
  SkillLocalRef,
  SkillPublishRequest,
  SkillSaveRequest,
  SkillSubmitVersionRequest,
} from '@shared/skillMarket';
import type { ShareDirectoryResult } from '@shared/directoryRequest';
import {
  IPC_CHANNELS,
  type ArchiveAnswer,
  type BrowserFreezeFrameRequest,
  type BrowserGoAction,
  type BrowserGoRequest,
  type BrowserNavigateRequest,
  type BrowserOpenArtifactRequest,
  type BrowserPaneBounds,
  type BrowserPaneRequest,
  type BrowserPaneState,
  type BrowserTabAction,
  type BrowserTabRequest,
} from '@shared/ipc';
import type { McpMutationResult, McpServerInput, McpServersState } from '@shared/mcp';
import { NO_SKILLS } from '@shared/skills';
import type { AuthService } from '../auth';
import { createMainLogger } from '../logger';
import { LocalContextPreference } from './LocalContextPreference';
import { SpawnLocationPreference } from './SpawnLocationPreference';
import { registerSpawnLocationIpc } from './spawnLocationIpc';
import { SPAWN_LOCATION_FILE_NAME } from '@shared/spawnLocation';
import { createLateReload } from './lateReload';
import { registerGenerationIpc } from './generationIpc';
import { modelSettingsChanged, registerModelSettingsIpc } from './modelSettingsIpc';
import { ModelSettingsStore } from './ModelSettingsStore';
import { registerLocalContextIpc } from './localContextIpc';
import { localContextSizing, localHardware, localLlamaServer, relistAfterSave } from './localContextSizing';
import { findOnPath, resolveUserPath } from './tools/userPath';
import { SidebarSectionStore } from './SidebarSectionStore';
import { ComposerDraftStore } from './ComposerDraftStore';
import { registerComposerDraftsIpc } from './composerDraftsIpc';
import { registerImageMenuIpc } from './imageMenuIpc';
import { registerFilePathLinkIpc } from './filePathLinks';
import { registerSessionExportIpc } from './sessionExportIpc';
import { registerLocalDataExportIpc } from './localDataExportIpc';
import { confirmArchiveFromIpc } from './sessionArchive';
import { registerSessionCreateIpc } from './sessionCreateIpc';
import { registerSessionOrchestrateIpc } from './sessionOrchestrateIpc';
import { placeNewSession, registerSidebarIpc } from './sidebarIpc';
import { AttachmentStore } from './AttachmentStore';
import { BrowserManager, NO_PAGE } from './browser/BrowserManager';
import { IMAGE_BYTE_CAP, IMAGE_MAX_EDGE, isImageMediaType } from './attachments';
import { ArtifactLibrary } from './artifacts/ArtifactLibrary';
import { SkillMarket } from './skills/SkillMarket';
import { ArtifactPublisher } from './artifacts/ArtifactPublisher';
import { SharePublisher } from './artifacts/SharePublisher';
import { registerArtifactProtocol } from './artifacts/sandboxProtocol';
import { registerModelProtocol } from './model3d/engineProtocol';
import { ModelLiveViews } from './model3d/ModelLiveViews';
import { ModelVersionStore } from './model3d/ModelVersionStore';
import { modelIpcHandlers } from './model3d/modelIpc';
import type { ChatService, ChatServiceDeps } from './ChatService';
import { logDownstream } from './devLogDownstream';
import { McpManager } from './mcp/McpManager';
import { McpServerStore } from './mcp/McpServerStore';
import { privateFile } from '../privateFile';
import { appSecretCipher } from '../secrets';
import { MediaApiClient } from './media/MediaApiClient';
import { MediaStore } from './media/MediaStore';
import { VideoJobScheduler } from './media/VideoJobScheduler';
import { VideoJobStore } from './media/VideoJobStore';
import { registerMediaProtocol } from './media/protocol';
import { ModelCatalog } from './ModelCatalog';
import type { SessionStore } from './SessionStore';
import { LocalHistory } from './LocalHistory';
import { registerHistoryIpc } from './historyIpc';
import { captureHistoryPage } from './captureHistoryPage';
import { forgetLocalContexts, forgetLocalContextOf, OllamaLocal } from './OllamaLocal';
import { registerModelServersIpc } from '../modelServers/ipc';
import { LocalModels, optionCatalogSampling, type CatalogSamplingHook } from '../modelServers/LocalModels';
import { hostLaunchers } from '../modelServers/LocalServerSupervisor';
import { ModelServerRegistry } from '../modelServers/ModelServerRegistry';
import { ModelServerStore } from '../modelServers/ModelServerStore';
import { readHostOllamaEnv } from '../modelServers/observedOllama';
import { withEnteredSpecs } from '../models/enteredHardware';
import { machineView } from '../models/fit';
import { LOCAL_SERVER_ID } from '@shared/modelServers';
import { MODEL_SETTINGS_FILE_NAME } from '@shared/modelSettings';
import { sessionScopeFor, sessionScopeForChat, sessionScopeKey } from './sessionScope';
import { readWorkspaceChanges } from './project/workspaceChanges';
import { formatApprovalSummary, readApprovalLog, summarizeApprovals } from './permissions/approvalSummary';
import { PermissionRuleStore } from './permissions/PermissionRuleStore';
import { CapabilityLedger } from './capabilities/CapabilityLedger';
import {
  capabilityHandlers,
  completeCapabilityMutation,
  retireSessionApprovals,
} from './capabilities/capabilityHandlers';
import { parseSkillsScope, skillsTrustTargetSchema } from './skills/scope';
import { detectLaunchSignals } from './launchSignals';
import { SpareWorktrees } from './project/workspace';
import { folderToRemember } from './project/recentFolderToRecord';
import type { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';
import { storedReasoningEffortSetting } from './reasoningEffort';
import type { PreparedImage } from './tools/types';
import { desktopScreenCapturer } from './screen/desktopScreen';
import { parsePaneInput, SimulatorLiveView } from './simulator/SimulatorLiveView';
import { XcodeSimulatorDriver } from './simulator/XcodeSimulatorDriver';
import { registerPullRequests } from '../pr';
import type { PrMonitor } from '../pr/PrMonitor';
import { appWindows, focusedAppWindow } from '../windows';
import { registerClaudeImport } from '../claudeImport';
import type { ClaudeImportService } from '../claudeImport/ClaudeImportService';
import { HostRuntime, hostProtectedLocations, type HostEnvironment, type HostEventSink } from '../../host';
import { HostEventRelay } from '../../host/server';
import { createHostPermissionStack, permissionRulesPath } from '../../host/permissionStack';
import type { LocalHost } from '../host/registerHostConnections';

const editMessageRequestSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  text: z.string(),
});

const VERBOSE = process.env.B4M_DESKTOP_VERBOSE === '1';

function sameSubject(left: CapabilitySubject, right: CapabilitySubject): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'desktop-user') return true;
  if (left.kind === 'project' && right.kind === 'project') return left.directory === right.directory;
  return left.kind === 'session' && right.kind === 'session' && left.sessionId === right.sessionId;
}

/** How much of a background process's output the panel asks for when it rejoins after a reload. */
const PANEL_TAIL_CHARS = 20_000;

/** Window (ms) that gathers late server listings into one chat model list reload; see lateReload.ts. */
const LATE_RELOAD_DEBOUNCE_MS = 250;

/** Re-encode quality for a downscaled screenshot. Text in a UI stays legible well below this. */
const SHRUNK_JPEG_QUALITY = 82;

/**
 * Downscale an oversized image with Electron's own decoder, so no image library is added.
 *
 * Returns null whenever it cannot help - a format nativeImage does not decode, or an image
 * already inside the limit - and the caller then keeps the original bytes. PNG is kept as PNG
 * when that is already small enough, because re-encoding a screenshot of text as JPEG blurs
 * exactly the part the user attached it for; JPEG is only the fallback for what is still large.
 */
function shrinkImage(bytes: Buffer, mediaType: string, maxEdge: number): { bytes: Buffer; mediaType: string } | null {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return null;

  const { width, height } = image.getSize();
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge && bytes.length <= IMAGE_BYTE_CAP) return null;

  const resized = longEdge > maxEdge ? image.resize(width >= height ? { width: maxEdge } : { height: maxEdge }) : image;
  if (resized.isEmpty()) return null;

  const asPng = resized.toPNG();
  if (asPng.length > 0 && asPng.length <= IMAGE_BYTE_CAP) return { bytes: asPng, mediaType: 'image/png' };

  const asJpeg = resized.toJPEG(SHRUNK_JPEG_QUALITY);
  if (asJpeg.length === 0) return null;
  return { bytes: asJpeg, mediaType: 'image/jpeg' };
}

/**
 * Fit an image a tool shows the model, as shrinkImage does an attachment. Unlike that one it
 * reports the sizes for the tool's result, and passes through what already fits so a GIF the
 * decoder reads keeps its frames.
 */
function prepareToolImage(bytes: Buffer, mediaType: string, maxBytes: number): PreparedImage | null {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return null;

  const { width: sourceWidth, height: sourceHeight } = image.getSize();
  const oversized = Math.max(sourceWidth, sourceHeight) > IMAGE_MAX_EDGE;
  if (!oversized && bytes.length <= maxBytes) {
    return { bytes, mediaType, width: sourceWidth, height: sourceHeight, sourceWidth, sourceHeight };
  }

  const edge = sourceWidth >= sourceHeight ? { width: IMAGE_MAX_EDGE } : { height: IMAGE_MAX_EDGE };
  const resized = oversized ? image.resize({ ...edge, quality: 'best' }) : image;
  if (resized.isEmpty()) return null;
  const sizes = { ...resized.getSize(), sourceWidth, sourceHeight };

  const asPng = resized.toPNG();
  if (asPng.length > 0 && asPng.length <= maxBytes) return { bytes: asPng, mediaType: 'image/png', ...sizes };
  for (const quality of [SHRUNK_JPEG_QUALITY, 60]) {
    const asJpeg = resized.toJPEG(quality);
    if (asJpeg.length > 0 && asJpeg.length <= maxBytes) return { bytes: asJpeg, mediaType: 'image/jpeg', ...sizes };
  }
  return null;
}

/**
 * Build the chat service and expose it over IPC.
 *
 * Every channel here is main-side work on purpose: sending a message needs the access token,
 * which never leaves this process, so the renderer asks for a turn and receives text.
 */
function permissionScope(value: unknown): PermissionScope | null {
  if (!value || typeof value !== 'object') return null;
  const scope = value as { kind?: unknown; directory?: unknown };
  if (scope.kind === 'user') return { kind: 'user' };
  if (scope.kind === 'project' && typeof scope.directory === 'string' && isAbsolute(scope.directory)) {
    return { kind: 'project', directory: scope.directory };
  }
  return null;
}

function permissionLists(value: unknown): PermissionRuleLists | null {
  if (!value || typeof value !== 'object') return null;
  const lists: PermissionRuleLists = { allow: [], ask: [], deny: [] };
  for (const list of PERMISSION_LISTS) {
    const entries = (value as Record<string, unknown>)[list];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || !entries.every(entry => typeof entry === 'string')) return null;
    lists[list] = entries;
  }
  return lists;
}

export interface RegisteredChat {
  service: ChatService;
  /** The runtime and a tee of its pushes, for main/host to serve through the host protocol. */
  host: LocalHost;
  /** Background processes, exposed so main/index.ts can tear them down on every quit path. */
  background: BackgroundProcessRegistry;
  /** MCP connections, torn down on the same two quit passes for the same reason. */
  mcp: McpManager;
  /** The agent's hidden browser windows, closed with the last app window and on quit. */
  browser: BrowserManager;
  /** The live iOS Simulator view, whose stream is stopped on quit. */
  simulatorView: SimulatorLiveView;
  /** Each conversation's open 3D model, whose watchers are stopped on quit. */
  modelViews: ModelLiveViews;
  /** Each conversation's pull request, and the timers that watch it. */
  pullRequests: PrMonitor;
  /** Unsent composer text, written once more on quit in case a debounced save is still in flight. */
  composerDrafts: Pick<ComposerDraftStore, 'flushSync'>;
  /** Import from Claude; started once the window is up so it never delays launch. */
  claudeImport: ClaudeImportService;
  /** Spare checkouts, removed on the quit pass that can wait for git. */
  spareWorktrees: SpareWorktrees;
  /** Saved model servers, which the Models screen also pulls to and removes from. */
  modelServers: ModelServerRegistry;
  /** Stops their health checks and any pending model list reload, on quit. */
  stopModelServers(): void;
  /** Stops the servers Desktop started, on the quit pass that can wait. */
  stopLocalServers(): Promise<void>;
  /** The Settings choice of local model context, which the Models screen's fit badges also plan for. */
  localContext: LocalContextPreference;
  /** Per-model defaults; the fit badges plan for each model's own context and draft too. */
  modelSettings: ModelSettingsStore;
  /** The capability ledger, which the Models screen records approved downloads in. */
  capabilityLedger: CapabilityLedger;
  /** The one path that answers a tool approval; the menu bar and mini Tavern answer through it too. */
  respondToApproval(approvalId: string, answer: ChatApprovalAnswer): void;
  /** The session store, which the profile screen's local usage is counted from. */
  store: SessionStore;
}

/**
 * The pane rectangle, or null for anything that is not one.
 *
 * Checked rather than trusted even though the renderer is ours: these numbers go straight to
 * `setBounds`, and a NaN there puts a web page somewhere nobody can find it - including over
 * the composer.
 */
function paneBounds(value: unknown): BrowserPaneBounds | null {
  const bounds = value as Partial<BrowserPaneBounds> | null | undefined;
  if (!bounds) return null;
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every(side => typeof side === 'number' && Number.isFinite(side))) return null;
  if (width! < 1 || height! < 1) return null;
  return { x: Math.round(x!), y: Math.round(y!), width: Math.round(width!), height: Math.round(height!) };
}

/**
 * Where every picker in this file opens.
 *
 * Read from Electron rather than taken from a caller: a starting folder is the one dialog
 * input a crafted prompt could otherwise aim, and the grant picker below is the only way the
 * tools' reach is widened. It sets the first view and nothing else - the user still drives the
 * dialog, and cancelling still grants nothing.
 *
 * Home rather than a guess at something more relevant: with no defaultPath at all macOS falls
 * back to whatever NSOpenPanel last remembered, which is how the folder picker came to open in
 * Downloads for a user who had never pointed a project there.
 */
function pickerStart(): string {
  return app.getPath('home');
}

/** The OS folder picker, parented to the window that asked when there is one. */
async function pickDirectory(sender: WebContents): Promise<string | null> {
  const window = BrowserWindow.fromWebContents(sender);
  const properties: ('openDirectory' | 'createDirectory')[] = ['openDirectory', 'createDirectory'];
  const options = { properties, defaultPath: pickerStart() };
  const picked = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
  return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0];
}

export function registerChat(
  auth: AuthService,
  hooks: Pick<ChatServiceDeps, 'sessionClosed' | 'releaseSessionTerminals'> & {
    observeStream?(event: ChatStreamEvent): void;
    /** Every session status push, as the renderers get it; main's needs-you watch reads these. */
    observeSessionStatus?(event: ChatSessionStatusEvent): void;
    /** Revoking a model-pull grant in Settings stops that download; true once it no longer runs. */
    cancelModelPull?(key: string): Promise<boolean>;
    /** The curated list's projector sizes, so chat sizes a vision model the way the Models screen does. */
    pinnedProjectors?(): ReadonlyMap<string, number>;
    /** The curated family sampling for an installed local model; see ModelHubService.catalogSampling. */
    catalogSampling?: CatalogSamplingHook;
  } = {}
): RegisteredChat {
  const logger = createMainLogger(VERBOSE);
  const environment: HostEnvironment = {
    dataDirectory: app.getPath('userData'),
    homeDirectory: app.getPath('home'),
    appName: app.getName(),
    platform: process.platform,
  };
  const userData = environment.dataDirectory;
  const protection = hostProtectedLocations(environment, logger);
  const capabilityLedger = new CapabilityLedger(join(userData, 'capability-ledger.json'));
  // App-wide like approval-mode.json; see SidebarSectionStore.
  const sidebarSections = new SidebarSectionStore(join(userData, 'sidebar-sections.json'));
  const spareWorktrees = new SpareWorktrees();
  const { projectTrust, skills, permissions } = createHostPermissionStack({ environment, protection, auth, logger });
  const home = environment.homeDirectory;
  const attachmentsDir = join(userData, 'attachments');
  const attachments = new AttachmentStore(attachmentsDir, logger, shrinkImage);
  // App-wide like sidebar-sections.json: session ids are unique across scopes.
  const composerDrafts = new ComposerDraftStore(join(userData, 'composer-drafts.json'));
  const composerDraftsLoaded = composerDrafts.load();
  const media = new MediaStore(join(userData, 'media'));
  registerMediaProtocol(media);
  registerArtifactProtocol();
  registerModelProtocol();
  const artifacts = new ArtifactPublisher(() => auth.getApiClient(), logger);
  const artifactLibrary = new ArtifactLibrary(() => auth.getApiClient(), logger);
  const skillMarket = new SkillMarket({
    getApiClient: () => auth.getApiClient(),
    getEnvironmentUrl: () => auth.getState().environment.url,
    catalog: skills,
    openExternal: url => shell.openExternal(url),
    getUserId: () => auth.getState().user?.id ?? null,
    // The same root listSkills resolves, so only a skill Customize could show is readable.
    localSkill: async (sessionId, name) => {
      const session = sessionId ? await store.get(sessionId) : null;
      return skills.get(session?.project?.workingDirectory ?? null, name);
    },
    writeClipboard: text => clipboard.writeText(text),
    logger,
  });
  const localContext = new LocalContextPreference(join(userData, 'local-context.json'));
  const spawnLocation = new SpawnLocationPreference(join(userData, SPAWN_LOCATION_FILE_NAME));
  const localSizing = localContextSizing({
    setting: () => localContext.read(),
    pinnedProjectors: () => hooks.pinnedProjectors?.() ?? new Map(),
    kvCacheType: () => modelServers.localKvCacheType(),
    flashAttention: () => modelServers.flashAttention(LOCAL_SERVER_ID),
  });
  const lateReload = createLateReload(() => {
    models.forgetLocal();
    send(IPC_CHANNELS.chatModelsChanged, undefined);
  }, LATE_RELOAD_DEBOUNCE_MS);
  const modelSettings = new ModelSettingsStore(join(userData, MODEL_SETTINGS_FILE_NAME), message =>
    logger.warn(message)
  );
  const loadSettings = (modelId: string) => modelSettings.get(modelId);
  // Encrypted like the MCP secrets: a server's token or header value never goes to plain JSON.
  const modelServerStore = new ModelServerStore(
    appSecretCipher(),
    privateFile(join(userData, 'model-servers.json')),
    logger
  );
  void modelServerStore
    .reencrypt()
    .catch(error => logger.warn(`MODEL SERVERS: could not re-save stored credentials: ${String(error)}`));
  const modelServers = new ModelServerRegistry({
    loadSettings,
    store: modelServerStore,
    logger,
    changed: servers => {
      models.expireLocal();
      send(IPC_CHANNELS.modelServersChanged, servers);
    },
    edited: () => models.forgetLocal(),
    listedLate: lateReload.notify,
    readOllamaEnv: url => readHostOllamaEnv(url),
    launchers: hostLaunchers({
      unifiedMemory: async () => (await localHardware.profile())?.memoryKind === 'unified',
      // The probe itself: hardware entered in Settings carries no vendor.
      gpuVendor: async () => (await localHardware.probed())?.gpuVendor ?? null,
    }),
    ownedServers: privateFile(join(userData, 'local-servers.json')),
    ownedCipher: appSecretCipher(),
    localSpecsChanged: () => {
      forgetLocalContexts();
      localSizing.forget?.();
      models.forgetLocal();
    },
  });
  localHardware.setOverride(probed => withEnteredSpecs(probed, modelServers.specs(LOCAL_SERVER_ID)));
  const serversLoaded = modelServers
    .start()
    .catch(error => logger.warn(`MODEL SERVERS: could not load: ${String(error)}`));
  localHardware.setLlamaServer(
    localLlamaServer({
      views: () => serversLoaded.then(() => modelServers.views()),
      onPath: async () => findOnPath('llama-server', await resolveUserPath()),
    }),
    message => logger.warn(message)
  );
  modelServers.onServerSaved(relistAfterSave(localHardware, () => modelServers.views(), logger));
  void localHardware.profile();
  const local = new LocalModels(
    new OllamaLocal((url, init) => net.fetch(url, init), localSizing, undefined, loadSettings),
    modelServers,
    // Matched on every server; requestGeneration keeps each server to the fields it takes.
    optionCatalogSampling(hooks.catalogSampling)
  );
  const models = new ModelCatalog(
    {
      logger,
      getApiClient: () => auth.getApiClient(),
      getEnvironmentUrl: () => auth.getState().environment.url,
      changed: () => send(IPC_CHANNELS.chatModelsChanged, null),
    },
    local
  );
  const send = (channel: string, payload: unknown) => {
    logDownstream(channel, payload);
    for (const window of appWindows()) {
      window.webContents.send(channel, payload);
    }
  };

  // History is an opt-in, rebuildable index: an unopenable file must not take chat down with it.
  let history: LocalHistory | undefined;
  try {
    history = new LocalHistory(
      join(userData, 'local-history.sqlite'),
      () => {
        const scope = sessionScopeForChat(auth.getState());
        return scope ? sessionScopeKey(scope) : null;
      },
      () => {
        try {
          send(IPC_CHANNELS.chatHistoryChanged, undefined);
        } catch (error) {
          logger.warn(`CHAT: could not notify local history change: ${String(error)}`);
        }
      }
    );
  } catch (err) {
    logger.warn(`CHAT: local history is unavailable: ${err instanceof Error ? err.message : err}`);
  }

  // Windows get stream events from the host protocol (HostServer); this is main's own reaction to them.
  const observeStreamEvent = (event: ChatStreamEvent) => {
    logDownstream('session/event', event);
    if (event.type === 'tool-end') pullRequests.observeToolEnd(event.sessionId, event.call);
    if (event.type === 'tool-end' && event.call.media?.length) {
      void studioIntegration
        .indexChatSession(event.sessionId)
        .catch(() => createStudioDiagnostics(logger)('asset-index', { sessionId: event.sessionId }));
    }
  };

  const videoJobs = new VideoJobScheduler({
    store: new VideoJobStore(media),
    media,
    connection: () => {
      const api = auth.getApiClient();
      const scope = sessionScopeFor(auth.getState());
      return api && scope
        ? { client: new MediaApiClient(api), scope: `${scope.environmentUrl}|${scope.accountId}` }
        : null;
    },
    emit: (sessionId, job) => {
      // Through the relay, so windows hear it over the host protocol as well as main reacting.
      runtimeEvents.streamEvent(runtime.eventLog.append({ type: 'video-job', sessionId, job }));
      if (job.state === 'succeeded' && job.media)
        void studioIntegration
          .indexChatSession(sessionId, true)
          .catch(() => createStudioDiagnostics(logger)('asset-index', { sessionId }));
    },
    logger,
  });

  // Constructed here rather than beside ArtifactPublisher because it needs `send`, which is
  // declared above. Note what it is NOT given: no hook into the turn, no tool registration.
  // Publishing happens only when the IPC handler below is invoked from the publish button.
  const sharePublisher = new SharePublisher(
    () => auth.getApiClient(),
    () => auth.getState().user?.id,
    logger,
    progress => send(IPC_CHANNELS.chatArtifactPublishProgress, progress)
  );

  // Encrypted for the same reason as the auth vault: an env variable holding an API key and a
  // header holding a bearer token are credentials, and neither goes to plain JSON in userData.
  const mcpServerStore = new McpServerStore(appSecretCipher(), privateFile(join(userData, 'mcp-servers.json')), logger);
  void mcpServerStore
    .reencrypt()
    .catch(error => logger.warn(`MCP: could not re-save stored secrets: ${String(error)}`));
  const mcp = new McpManager(mcpServerStore, logger, (state: McpServersState) =>
    send(IPC_CHANNELS.mcpServersChanged, state)
  );

  const browser = new BrowserManager(
    (sessionId, state) => send(IPC_CHANNELS.browserPageState, { sessionId, ...state }),
    state => send(IPC_CHANNELS.browserCookiesChanged, state),
    (sessionId, snapshot) =>
      captureHistoryPage(sessionId, snapshot.model, {
        history,
        store,
        scopeKey: () => {
          const scope = sessionScopeForChat(auth.getState());
          return scope ? sessionScopeKey(scope) : null;
        },
      })
  );

  const modelViews = new ModelLiveViews(
    {
      state: (sessionId, state) => send(IPC_CHANNELS.modelState, { sessionId, state }),
      // One rendering is enough: the focused app window, else the first.
      captureTarget: () => {
        const target = focusedAppWindow();
        return target && !target.isDestroyed() ? target.webContents.id : null;
      },
      captureRequest: (target, request) => {
        const window = appWindows().find(entry => !entry.isDestroyed() && entry.webContents.id === target);
        if (!window) return false;
        window.webContents.send(IPC_CHANNELS.modelCaptureRequest, request);
        return true;
      },
      versionsChanged: sessionId => send(IPC_CHANNELS.modelVersions, { sessionId }),
    },
    {},
    new ModelVersionStore(join(userData, 'model-versions'), { warn: message => logger.warn(message) })
  );

  const simulatorDriver = new XcodeSimulatorDriver();
  const simulatorView = new SimulatorLiveView(
    simulatorDriver,
    {
      state: state => send(IPC_CHANNELS.simulatorState, state),
      // Not through `send`: it logs every payload, and these are frames at 10 a second.
      frame: (udid, jpeg) => {
        for (const window of appWindows()) window.webContents.send(IPC_CHANNELS.simulatorFrame, { udid, bytes: jpeg });
      },
    },
    { available: process.platform === 'darwin' }
  );

  const events: HostEventSink = {
    streamEvent: observeStreamEvent,
    sessionSummary: summary => logDownstream('session/summaryChanged', summary),
    sessionStatus: (event, statusChanged) => {
      logDownstream('session/statusChanged', event);
      hooks.observeSessionStatus?.(event);
      // Only reached once a turn has run, long after pullRequests below exists. A background job
      // starting or ending re-sends 'done' without a new turn, so only a real change settles one.
      if (statusChanged && (event.status === 'done' || event.unreadReply)) pullRequests.turnSettled(event.sessionId);
    },
    queueChanged: event => logDownstream('session/queueChanged', event),
    taskDecisions: decisions => logDownstream('session/taskDecisionsChanged', decisions),
    // Loops are not on the host protocol yet, so their state still reaches windows over IPC.
    loopChanged: (sessionId, state) => send(IPC_CHANNELS.chatLoopChanged, { sessionId, state }),
  };

  // Annotated: the machine tools' callbacks read the runtime's store, so inference would cycle.
  const hostEvents = new HostEventRelay(error => logger.warn(`HOST: a protocol listener failed: ${String(error)}`));
  // The runtime's own sink, so a change main makes outside the runtime reaches the host protocol too.
  const runtimeEvents = hostEvents.tee(events);
  const runtime: HostRuntime = new HostRuntime({
    environment,
    events: runtimeEvents,
    auth,
    logger,
    protection,
    machine: {
      browser,
      screen: desktopScreenCapturer(environment.appName),
      ...(environment.platform === 'darwin' ? { simulator: { driver: simulatorDriver, view: simulatorView } } : {}),
      model: modelViews,
      prepareImage: prepareToolImage,
    },
    collaborators: {
      attachments,
      composerDrafts,
      models,
      modelSettings,
      spawnLocation,
      permissions,
      capabilities: {
        grant: async input => {
          await capabilitiesReady;
          return capabilityLedger.grant(input);
        },
        revokeMatching: async match => {
          await capabilitiesReady;
          return capabilityLedger.revokeMatching(match);
        },
      },
      spareWorktrees,
      media,
      videoJobs,
      sidebarSections,
      mcp,
      pullRequests: () => pullRequests,
      history,
      local,
      artifacts,
      skills,
      // Attachments sit inside userData but hold only what the user attached, so the agent may be
      // given a folder of them to hand to another tool; the file tools still refuse every write there.
      shareableUnderProtected: [attachmentsDir],
    },
    hooks: {
      observeStream: hooks.observeStream,
      sessionClosed: hooks.sessionClosed,
      releaseSessionTerminals: hooks.releaseSessionTerminals,
    },
  });
  const { service, store, access, approvals, approvalLog, background, foreground } = runtime;
  const capabilitiesReady = Promise.all([
    access.list(),
    projectTrust.list(),
    new PermissionRuleStore(permissionRulesPath(userData)).read(),
  ])
    .then(async ([roots, trustedProjects, stored]) => {
      await retireSessionApprovals(capabilityLedger);
      await capabilityLedger.migrate({ roots, trustedProjects, permissions: stored });
    })
    .catch(error => logger.warn(`CAPABILITIES: could not migrate grants: ${String(error)}`));

  // Reaches the service only through `chat`, which is first called long after both exist.
  const pullRequests = registerPullRequests({
    path: join(userData, 'pull-requests.json'),
    autoFixAttemptsPath: join(userData, 'auto-fix-attempts.json'),
    chat: () => service,
    store,
    logger,
    send,
    sessionSummary: summary => runtimeEvents.sessionSummary(summary),
  });

  const studioIntegration = registerStudio({
    logger,
    ipc: ipcMain,
    directory: userData,
    sessions: store,
    service,
    attachments,
    media,
    models,
    auth,
    videoJobs: sessionId => videoJobs.list(sessionId),
    changed: event => send(IPC_CHANNELS.studioChanged, event),
  });
  registerLibrary({ ipc: ipcMain, directory: userData, sessions: store, media, auth });
  registerProductions({ ipc: ipcMain, sessions: store, media, auth });
  service.studioDisposed = studioIntegration.dispose;
  service.studioWithSessionDeletion = studioIntegration.withSessionDeletion;

  registerModelServersIpc(ipcMain, modelServers, async () => {
    const probed = await localHardware.probed();
    return probed && machineView(probed);
  });
  ipcMain.handle(IPC_CHANNELS.chatListSuggestionModels, () => service.listSuggestionModels());
  registerLocalContextIpc(ipcMain, {
    preference: localContext,
    forget: () => {
      forgetLocalContexts();
      localSizing.forget?.();
      models.forgetLocal();
    },
    fit: () => local.contextFit(),
  });
  registerSpawnLocationIpc(ipcMain, {
    preference: spawnLocation,
    broadcast: location => send(IPC_CHANNELS.chatSpawnLocation, location),
  });
  ipcMain.handle(IPC_CHANNELS.chatListCreationTools, (_event, model: string) => service.listCreationTools(model));
  // Archiving itself goes through session/setArchived; only the question is asked here, where
  // Electron's dialog lives.
  ipcMain.handle(IPC_CHANNELS.chatConfirmArchive, async (event, raw: unknown): Promise<ArchiveAnswer | null> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return confirmArchiveFromIpc(raw, options =>
      window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)
    );
  });
  ipcMain.handle(IPC_CHANNELS.chatListSkills, (_event, raw: unknown) => {
    const scope = parseSkillsScope(raw);
    return scope ? service.listSkills(scope) : NO_SKILLS;
  });
  // Coerced rather than trusted, like the approval mode above: this is the only door to project
  // trust, so anything that is not an explicit `true` has to land as "not trusted".
  ipcMain.handle(
    IPC_CHANNELS.chatSetProjectSkillsTrusted,
    (_event, raw: unknown, trusted: boolean, expectedProjectDirectory: unknown) => {
      const scope = parseSkillsScope(raw);
      const target = skillsTrustTargetSchema.safeParse(expectedProjectDirectory);
      return scope && target.success
        ? service.setProjectSkillsTrusted(scope, trusted === true, target.data)
        : NO_SKILLS;
    }
  );
  ipcMain.handle(IPC_CHANNELS.skillMarketBrowse, (_event, filters: SkillMarketFilters, page: number) =>
    skillMarket.browse(filters, Number.isInteger(page) && page > 0 ? page : 1)
  );
  ipcMain.handle(IPC_CHANNELS.skillMarketRecommended, () => skillMarket.recommended());
  ipcMain.handle(IPC_CHANNELS.skillMarketListing, (_event, ref: SkillMarketListingRef) =>
    skillMarket.listing(ref ?? {})
  );
  ipcMain.handle(IPC_CHANNELS.skillMarketImport, (_event, request: SkillMarketImportRequest) =>
    skillMarket.importListing(request)
  );
  ipcMain.handle(IPC_CHANNELS.skillMarketImports, () => skillMarket.imports());
  ipcMain.handle(IPC_CHANNELS.skillMarketOpenOnWeb, (_event, target: SkillMarketWebTarget) =>
    skillMarket.openOnWeb(target)
  );
  ipcMain.handle(IPC_CHANNELS.skillMarketReadLocal, (_event, ref: SkillLocalRef) => skillMarket.readLocalSkill(ref));
  ipcMain.handle(IPC_CHANNELS.skillMarketPickUpload, event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return skillMarket.pickUploadSource(options =>
      window
        ? dialog.showOpenDialog(window, { ...options, defaultPath: pickerStart() })
        : dialog.showOpenDialog(options)
    );
  });
  ipcMain.handle(IPC_CHANNELS.skillMarketSave, (_event, request: SkillSaveRequest) => skillMarket.saveSkill(request));
  ipcMain.handle(IPC_CHANNELS.skillMarketOrgs, () => skillMarket.organizations());
  ipcMain.handle(IPC_CHANNELS.skillMarketPublish, (_event, request: SkillPublishRequest) =>
    skillMarket.publish(request)
  );
  ipcMain.handle(IPC_CHANNELS.skillMarketSubmitVersion, (_event, request: SkillSubmitVersionRequest) =>
    skillMarket.submitVersion(request)
  );
  ipcMain.handle(IPC_CHANNELS.skillMarketMine, () => skillMarket.mine());
  ipcMain.handle(IPC_CHANNELS.skillMarketWithdraw, (_event, listingId: string) => skillMarket.withdraw(listingId));
  ipcMain.handle(IPC_CHANNELS.skillMarketCopyShareLink, (_event, listingId: string) =>
    skillMarket.copyShareLink(listingId)
  );
  ipcMain.handle(IPC_CHANNELS.skillMarketOpenSource, (_event, url: string) => skillMarket.openSourceUrl(url));
  ipcMain.handle(IPC_CHANNELS.chatSetSessionModel, (_event, sessionId: string, model: string) =>
    service.setSessionModel(sessionId, model)
  );
  ipcMain.handle(IPC_CHANNELS.chatSettleLocalModel, (_event, sessionId: string) =>
    service.settleSessionModel(sessionId)
  );
  registerHistoryIpc(ipcMain, service, history);
  // Validated here rather than trusted, like the approval mode below: an unrecognised value
  // must not reach the store, where it would be sent verbatim on the next turn.
  ipcMain.handle(IPC_CHANNELS.chatSetSessionReasoningEffort, (_event, sessionId: string, effort: unknown) => {
    const setting = storedReasoningEffortSetting(effort);
    return setting ? service.setSessionReasoningEffort(sessionId, setting) : null;
  });
  ipcMain.handle(IPC_CHANNELS.chatSetSessionPromptCacheTtl, (_event, sessionId: string, ttl: unknown) =>
    isPromptCacheTtl(ttl) ? service.setSessionPromptCacheTtl(sessionId, ttl) : null
  );
  ipcMain.handle(IPC_CHANNELS.chatGetTurnExtensions, () => runtime.turnExtensions.read());
  // Coerced by the preference: anything out of range is saved as the default.
  ipcMain.handle(IPC_CHANNELS.chatSetTurnExtensions, (_event, extensions: unknown) =>
    runtime.turnExtensions.record(extensions)
  );
  registerGenerationIpc(ipcMain, service);
  registerModelSettingsIpc(ipcMain, modelSettings, {
    offer: (modelId, draftTokens) => local.loadOffer(modelId, draftTokens),
    changed: modelSettingsChanged({
      forgetContext: forgetLocalContextOf,
      refreshModels: () => models.forgetLocal(),
      announce: () => send(IPC_CHANNELS.chatModelsChanged, undefined),
    }),
  });
  ipcMain.handle(IPC_CHANNELS.chatSetSessionPinned, (_event, sessionId: string, pinned: boolean) =>
    service.setSessionPinned(sessionId, pinned)
  );
  registerSessionOrchestrateIpc(ipcMain, service);
  registerOrchestrationIpc(ipcMain, service);
  // Decisions asked before a restart badge the dock and notify even before a window asks for them.
  void service.listTaskDecisions();
  // Validated here rather than trusted, for the same reason the folder grant goes through a
  // native picker: this is the only door to the approval mode, so an unrecognised value must
  // not reach the store and land as something looser than the user asked for.
  ipcMain.handle(IPC_CHANNELS.chatSetApprovalMode, (_event, sessionId: string, mode: ChatApprovalMode) =>
    mode === 'ask' || mode === 'auto' || mode === 'full' ? service.setApprovalMode(sessionId, mode) : null
  );
  ipcMain.handle(IPC_CHANNELS.chatListSessions, () => runtime.listSessions());
  ipcMain.handle(IPC_CHANNELS.permissionsGetState, () => permissions.state());
  // Shapes checked here: this is the only door a rule comes in by besides the approval card.
  ipcMain.handle(IPC_CHANNELS.permissionsSetRules, async (_event, scope: unknown, lists: unknown) => {
    const parsedScope = permissionScope(scope);
    const parsedLists = permissionLists(lists);
    if (!parsedScope || !parsedLists) return { ok: false, error: 'Not a permission rule list.' };
    await capabilitiesReady;
    const result = await permissions.setRules(parsedScope, parsedLists);
    if (!result.ok) return result;
    return completeCapabilityMutation(
      result,
      async () => {
        const subject =
          parsedScope.kind === 'project'
            ? ({ kind: 'project', directory: resolve(parsedScope.directory) } as const)
            : ({ kind: 'desktop-user' } as const);
        await capabilityLedger.revokeMatching(
          grant =>
            grant.capability === 'tool' &&
            grant.scope.kind === 'permission-rule' &&
            sameSubject(grant.subject, subject) &&
            !parsedLists.allow.includes(grant.scope.value)
        );
        const active = (await capabilityLedger.state()).grants.filter(
          grant => !grant.revokedAt && grant.scope.kind === 'permission-rule' && sameSubject(grant.subject, subject)
        );
        for (const rule of parsedLists.allow) {
          if (active.some(grant => grant.scope.kind === 'permission-rule' && grant.scope.value === rule)) continue;
          await capabilityLedger.grant({
            subject,
            capability: 'tool',
            scope: { kind: 'permission-rule', value: rule },
            source: 'permission-rule',
          });
        }
      },
      logger,
      () => {
        void approvals.settleCovered();
      }
    );
  });
  ipcMain.handle(IPC_CHANNELS.permissionsSetSharing, (_event, share: unknown) =>
    permissions.setShareClaudeCode(share === true)
  );
  // Written only where the user picks in the save dialog: the digest never leaves the machine otherwise.
  ipcMain.handle(IPC_CHANNELS.permissionsExportApprovalSummary, async event => {
    const options = {
      defaultPath: join(app.getPath('downloads'), `approval-summary-${new Date().toISOString().slice(0, 10)}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    };
    const window = BrowserWindow.fromWebContents(event.sender);
    const picked = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options));
    if (picked.canceled || !picked.filePath) return false;
    const entries = await readApprovalLog([approvalLog.rotatedPath, approvalLog.filePath]);
    await writeFile(picked.filePath, formatApprovalSummary(summarizeApprovals(entries)), 'utf8');
    return true;
  });
  const capabilityIpc = capabilityHandlers({
    ledger: capabilityLedger,
    ready: capabilitiesReady,
    scopeKey: () => store.scopeKey(),
    sessions: () => store.list(),
    targets: {
      approvals,
      removeSessionDirectory: async (sessionId, directory) => {
        const scopeKey = store.scopeKey();
        const session = await store.get(sessionId);
        const directories = [...(session?.grantedDirectories ?? []), ...(session?.project?.contextDirectories ?? [])];
        if (scopeKey !== store.scopeKey() || !directories.includes(directory)) return false;
        return (await service.removeContextDirectory(sessionId, directory, false, scopeKey)) !== null;
      },
      revokeRoot: async root => {
        if (!(await access.list()).includes(root)) return false;
        await access.revoke(root);
        service.refreshAccessScopes();
        return true;
      },
      untrustProject: async directory => {
        if (!(await projectTrust.isTrusted(directory))) return false;
        await skills.setTrusted(directory, false);
        permissions.invalidate();
        return true;
      },
      revokeAllow: (scope, rule) => permissions.revokeAllow(scope, rule),
      cancelModelPull: key => hooks.cancelModelPull?.(key) ?? Promise.resolve(false),
    },
  });
  ipcMain.handle(IPC_CHANNELS.capabilitiesGetState, () => capabilityIpc.getState());
  ipcMain.handle(IPC_CHANNELS.capabilitiesRevoke, (_event, grantId: unknown) => capabilityIpc.revoke(grantId));
  registerSessionCreateIpc(ipcMain, {
    createSession: mode => runtime.createSession(mode),
    place: (sessionId, sectionId) =>
      placeNewSession(sidebarSections, sessionId, sectionId, error =>
        logger.warn(`CHAT: could not place new session in its sidebar section: ${String(error)}`)
      ),
  });

  ipcMain.handle(IPC_CHANNELS.chatUpdateProject, async (_event, request: UpdateProjectRequest) => {
    const result = await service.updateProject(request);
    void runtime.rememberRecentFolder(folderToRemember(request, result));
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.chatPickProjectDirectory, (event): Promise<string | null> => pickDirectory(event.sender));
  ipcMain.handle(IPC_CHANNELS.chatLaunchSignals, () =>
    detectLaunchSignals({ home: homedir(), recentFolders: () => runtime.listRecentFolders() })
  );

  ipcMain.handle(
    IPC_CHANNELS.chatAddContextDirectory,
    async (event, sessionId: string, path?: unknown): Promise<ShareDirectoryResult> => {
      if (typeof path === 'string') return service.shareDirectory(sessionId, path);
      const directory = await pickDirectory(event.sender);
      if (!directory) return { status: 'cancelled' };
      return service.shareDirectory(sessionId, directory);
    }
  );

  ipcMain.handle(IPC_CHANNELS.chatRemoveContextDirectory, (_event, sessionId: string, directory: string) =>
    service.removeContextDirectory(sessionId, directory)
  );
  // Keyed by session rather than by a path from the renderer, so this only ever reads the folder
  // the session's own tools run in. A failure is logged, not shown: the bar is a passive readout,
  // and a repository git cannot read already says so on the branch chip beside it.
  ipcMain.handle(IPC_CHANNELS.chatWorkspaceChanges, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return null;
    const session = await store.get(sessionId);
    try {
      return await readWorkspaceChanges(session?.project);
    } catch (err) {
      logger.warn(`CHAT: could not read workspace changes for ${sessionId}: ${String(err)}`);
      return null;
    }
  });
  const isIdList = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every(id => typeof id === 'string');
  ipcMain.handle(IPC_CHANNELS.chatInspectWorktreeRemoval, (_event, sessionId: unknown, alsoDeleting: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('Invalid conversation id');
    if (alsoDeleting !== undefined && !isIdList(alsoDeleting)) throw new Error('Invalid conversation list');
    return service.inspectSessionWorktreeRemoval(sessionId, alsoDeleting);
  });
  // Only a repository the user already has a conversation or recent folder for is ever touched.
  const knownRepository = async (directory: string) => {
    if (!(await runtime.isKnownRepository(directory))) throw new Error('Unknown project directory');
  };
  ipcMain.handle(IPC_CHANNELS.chatListWorktrees, async (_event, directory: unknown) => {
    if (typeof directory !== 'string') throw new Error('Invalid project directory');
    await knownRepository(directory);
    return service.listWorktrees(directory);
  });
  ipcMain.handle(IPC_CHANNELS.chatRemoveWorktrees, async (_event, directory: unknown, paths: unknown) => {
    if (typeof directory !== 'string') throw new Error('Invalid project directory');
    if (paths !== undefined && (!Array.isArray(paths) || !paths.every(path => typeof path === 'string'))) {
      throw new Error('Invalid worktree list');
    }
    await knownRepository(directory);
    return service.removeWorktrees(directory, paths);
  });
  ipcMain.handle(IPC_CHANNELS.chatRevealWorktree, async (_event, directory: unknown, path: unknown) => {
    if (typeof directory !== 'string' || typeof path !== 'string') throw new Error('Invalid worktree');
    await knownRepository(directory);
    return service.revealWorktree(directory, path, listed => shell.showItemInFolder(listed));
  });
  const isKnownSession = (sessionId: string) =>
    store.get(sessionId).then(
      session => session !== null,
      () => false
    );
  registerSidebarIpc(ipcMain, sidebarSections, isKnownSession);
  registerComposerDraftsIpc(ipcMain, composerDrafts, composerDraftsLoaded, isKnownSession);
  ipcMain.handle(IPC_CHANNELS.chatLoopCommand, (_event, sessionId: string, args: string) =>
    service.loopCommand(sessionId, args)
  );
  ipcMain.handle(IPC_CHANNELS.chatGetLoop, (_event, sessionId: string) => service.getLoop(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatContinueReply, (_event, sessionId: string) => service.continueReply(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatEditMessage, (_event, request: unknown) => {
    const parsed = editMessageRequestSchema.safeParse(request);
    if (!parsed.success) return { ok: false, error: 'That edit could not be read.' };
    return service.editMessage(parsed.data.sessionId, parsed.data.messageId, parsed.data.text);
  });
  ipcMain.handle(IPC_CHANNELS.chatRegenerateReply, (_event, sessionId: unknown) =>
    typeof sessionId === 'string'
      ? service.regenerateReply(sessionId)
      : { ok: false, error: 'That conversation no longer exists.' }
  );
  ipcMain.handle(IPC_CHANNELS.chatClearContext, (_event, sessionId: string) => service.clearContext(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatCompactContext, (_event, sessionId: string, focus?: string) =>
    service.compactContext(sessionId, focus ?? '')
  );
  ipcMain.handle(IPC_CHANNELS.chatSuggestNextPrompt, (_event, sessionId: string, model: unknown) =>
    service.suggestNextPrompt(sessionId, typeof model === 'string' && model ? model : null)
  );
  ipcMain.handle(IPC_CHANNELS.chatGetRunSpend, (_event, rootSessionId: unknown) =>
    typeof rootSessionId === 'string' ? service.getRunSpend(rootSessionId) : { status: 'unattributed' }
  );
  ipcMain.handle(IPC_CHANNELS.chatGetHeldRelays, (_event, sessionId: string) => service.heldRelaysFor(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatResolveHeldRelay, (_event, sessionId: string, heldId: string, deliver: boolean) =>
    service.resolveHeldRelay(sessionId, heldId, deliver === true)
  );
  ipcMain.handle(IPC_CHANNELS.chatStartSpawnSuggestion, (_event, request: StartSpawnSuggestionRequest) =>
    service.startSpawnSuggestion(request)
  );
  ipcMain.handle(IPC_CHANNELS.chatStartSideChat, (_event, request: StartSideChatRequest) =>
    service.startSideChat(request)
  );
  ipcMain.handle(IPC_CHANNELS.chatDismissSpawnSuggestion, (_event, sessionId: string, suggestionId: string) =>
    service.dismissSpawnSuggestion(sessionId, suggestionId)
  );
  // The menu-bar item and mini Tavern (main/watch) answer approvals through the returned
  // `respondToApproval`; the app's own cards go through the host server's request/respond.
  const respondToApproval = (approvalId: string, answer: ChatApprovalAnswer) =>
    runtime.respondToApproval(approvalId, answer);

  // The picker runs in main because that is where Electron's dialog lives, and it is the one
  // entry path that can name a file the renderer never saw.
  ipcMain.handle(IPC_CHANNELS.chatPickAttachments, async (event, sessionId: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const properties: ('openFile' | 'multiSelections')[] = ['openFile', 'multiSelections'];
    const options = { properties, defaultPath: pickerStart() };
    const picked = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
    if (picked.canceled || picked.filePaths.length === 0) return { attachments: [], rejected: [] };
    return attachments.add(
      sessionId,
      picked.filePaths.map(path => ({ source: 'path' as const, path }))
    );
  });

  ipcMain.handle(IPC_CHANNELS.chatAddAttachments, (_event, sessionId: string, inputs: ChatAttachmentInput[]) =>
    attachments.add(sessionId, Array.isArray(inputs) ? inputs : [])
  );

  // One channel for both kinds, because the renderer wants one thing from each: something it
  // can put in an <img src> or in a <pre>.
  // `mediaType` comes from the descriptor the renderer already holds, and is validated against
  // the image allowlist here rather than trusted: it ends up inside a `data:` URL, and the one
  // thing that must not be reachable is an attacker-chosen scheme in an <img src>.
  ipcMain.handle(
    IPC_CHANNELS.chatReadAttachment,
    async (_event, sessionId: string, attachmentId: string, mediaType: string) => {
      const bytes = await attachments.read(sessionId, attachmentId);
      if (!bytes) return null;
      return isImageMediaType(mediaType)
        ? `data:${mediaType};base64,${bytes.toString('base64')}`
        : bytes.toString('utf8');
    }
  );

  ipcMain.handle(IPC_CHANNELS.chatDiscardAttachment, (_event, sessionId: string, attachmentId: string) =>
    attachments.discard(sessionId, attachmentId)
  );
  ipcMain.handle(IPC_CHANNELS.chatCopyDraftAttachments, (_event, draftId: string, sessionId: string, ids: string[]) =>
    attachments.copyDraft(draftId, sessionId, ids)
  );
  ipcMain.handle(IPC_CHANNELS.chatDiscardDraftAttachments, (_event, draftId: string) => {
    if (!draftId.startsWith('draft-')) throw new Error('Invalid draft id.');
    return attachments.disposeDraft(draftId);
  });

  registerImageMenuIpc(ipcMain, {
    media,
    attachments,
    readFile: path => readFile(path),
    // Decoded from the bytes, not the path: attachment files carry no extension to decode by.
    // Re-encoded as PNG, the one image type every platform clipboard takes.
    copyImage: async bytes => {
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) return false;
      const png = image.toPNG();
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
      return true;
    },
    copyText: text => clipboard.writeText(text),
    pickSavePath: async (sender, options) => {
      const window = BrowserWindow.fromWebContents(sender);
      const picked = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options));
      return picked.canceled || !picked.filePath ? null : picked.filePath;
    },
    copyFile: (from, to) => copyFile(from, to),
    reveal: path => shell.showItemInFolder(path),
    downloadsDirectory: () => app.getPath('downloads'),
  });

  registerFilePathLinkIpc(ipcMain, {
    scopeFor: sessionId => service.fileLinkScope(sessionId),
    protectedPaths: () => protection.tool.paths(),
    home,
    stat: path => stat(path),
    openPath: path => shell.openPath(path),
    reveal: path => shell.showItemInFolder(path),
    copyText: async text => clipboard.writeText(text),
    attach: (sessionId, path) => attachments.add(sessionId, [{ source: 'path', path }]),
  });

  registerSessionExportIpc(ipcMain, {
    sessions: store,
    pickSavePath: async (sender, options) => {
      const window = BrowserWindow.fromWebContents(sender);
      const picked = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options));
      return picked.canceled || !picked.filePath ? null : picked.filePath;
    },
    writeFile: (path, content) => writeFile(path, content, 'utf8'),
    downloadsDirectory: () => app.getPath('downloads'),
  });

  registerLocalDataExportIpc(ipcMain, {
    sessions: store,
    attachments,
    media,
    userData,
    pickFolder: sender => pickDirectory(sender),
  });

  ipcMain.handle(IPC_CHANNELS.chatListArtifacts, () => artifactLibrary.list());
  ipcMain.handle(IPC_CHANNELS.chatReadArtifact, (_event, artifactId: string) => artifactLibrary.read(artifactId));
  ipcMain.handle(IPC_CHANNELS.chatPublishArtifact, (_event, request: ChatArtifactPublishRequest) =>
    sharePublisher.publish(request)
  );
  ipcMain.handle(IPC_CHANNELS.chatReadArtifactPublishState, (_event, artifactId: string) =>
    sharePublisher.readState(artifactId)
  );
  ipcMain.handle(IPC_CHANNELS.chatListBackground, (_event, sessionId: string) => background.list(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatReadBackground, (_event, sessionId: string, processId: string) =>
    background.tail(processId, sessionId, PANEL_TAIL_CHARS)
  );
  ipcMain.handle(IPC_CHANNELS.chatStopBackground, (_event, sessionId: string, processId: string) =>
    runtime.stopBackgroundProcess(sessionId, processId).then(() => undefined)
  );
  ipcMain.handle(IPC_CHANNELS.chatMoveToBackground, (_event, sessionId: string, callId: string) =>
    foreground.moveToBackground(sessionId, callId)
  );

  // Every mutation returns the whole state rather than the one row: a change to one server can
  // move another (a rename frees a name, a removal drops its tools), and a renderer that
  // patched one entry would be showing a list main no longer agrees with.
  const mutate = async (work: () => Promise<McpServersState>): Promise<McpMutationResult> => {
    try {
      return { ok: true, state: await work() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not save that server.' };
    }
  };

  ipcMain.handle(IPC_CHANNELS.mcpGetServers, () => mcp.state());
  ipcMain.handle(IPC_CHANNELS.mcpAddServer, (_event, input: McpServerInput) => mutate(() => mcp.addServer(input)));
  ipcMain.handle(IPC_CHANNELS.mcpUpdateServer, (_event, id: string, input: McpServerInput) =>
    mutate(() => mcp.updateServer(id, input))
  );
  ipcMain.handle(IPC_CHANNELS.mcpRemoveServer, (_event, id: string) => mcp.removeServer(id));
  ipcMain.handle(IPC_CHANNELS.mcpSetServerEnabled, (_event, id: string, enabled: boolean) =>
    mcp.setEnabled(id, enabled)
  );
  ipcMain.handle(IPC_CHANNELS.mcpReconnectServer, async (_event, id: string) => {
    await mcp.disconnect(id);
    await mcp.connect(id);
    return mcp.state();
  });

  modelIpcHandlers(modelViews);
  ipcMain.handle(IPC_CHANNELS.simulatorGetState, () => simulatorView.current());
  ipcMain.handle(IPC_CHANNELS.simulatorListDevices, async () =>
    process.platform === 'darwin' ? (await simulatorDriver.devices()).devices : []
  );
  ipcMain.handle(IPC_CHANNELS.simulatorAttach, (_event, udid: unknown) => {
    if (typeof udid !== 'string' || !udid) throw new Error('No simulator was named.');
    return simulatorView.attach(udid);
  });
  ipcMain.handle(IPC_CHANNELS.simulatorDetach, () => simulatorView.detach());
  ipcMain.handle(IPC_CHANNELS.simulatorInput, (_event, value: unknown) => {
    const input = parsePaneInput(value);
    if (!input) throw new Error('That simulator input is not one the pane sends.');
    return simulatorView.input(input);
  });

  // The view is attached to the window that asked, so the request carries no window id: a
  // second app window asking puts the page in ITS pane, and the first one's pane falls back to
  // its empty state on its next report.
  ipcMain.handle(IPC_CHANNELS.browserSetPane, (event, request: BrowserPaneRequest): BrowserPaneState => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : null;
    if (!window) return NO_PAGE;
    return browser.setPane(window, sessionId, paneBounds(request?.bounds));
  });
  ipcMain.handle(IPC_CHANNELS.browserFreezeFrame, (event, request: BrowserFreezeFrameRequest) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || typeof request?.sessionId !== 'string') return null;
    return browser.freezeFrame(window, request.sessionId);
  });

  // The url bar. Its requests name a conversation rather than being implied by the open pane,
  // for the same reason setPane does: a second app window has a pane of its own.
  ipcMain.handle(IPC_CHANNELS.browserNavigate, (_event, request: BrowserNavigateRequest) => {
    if (typeof request?.sessionId !== 'string' || typeof request?.url !== 'string') {
      throw new Error('A conversation and a url are required.');
    }
    return browser.navigate(request.sessionId, request.url);
  });
  ipcMain.handle(IPC_CHANNELS.browserOpenArtifact, (_event, request: BrowserOpenArtifactRequest) => {
    if (
      typeof request?.sessionId !== 'string' ||
      typeof request?.title !== 'string' ||
      typeof request?.content !== 'string' ||
      (request.artifactKey !== undefined && typeof request.artifactKey !== 'string')
    ) {
      throw new Error('A conversation, a title and the artifact content are required.');
    }
    return browser.openArtifact(request.sessionId, request.title, request.content, request.artifactKey);
  });
  ipcMain.handle(IPC_CHANNELS.browserGo, (_event, request: BrowserGoRequest): BrowserPaneState => {
    const actions: readonly BrowserGoAction[] = ['back', 'forward', 'reload'];
    if (typeof request?.sessionId !== 'string' || !actions.includes(request?.action)) {
      throw new Error('A conversation and one of back, forward or reload are required.');
    }
    return browser.go(request.sessionId, request.action);
  });
  ipcMain.handle(IPC_CHANNELS.browserTab, (_event, request: BrowserTabRequest): Promise<BrowserPaneState> => {
    const actions: readonly BrowserTabAction[] = ['new', 'select', 'close'];
    if (typeof request?.sessionId !== 'string' || !actions.includes(request?.action)) {
      throw new Error('A conversation and one of new, select or close are required.');
    }
    const tabId = typeof request.tabId === 'number' && Number.isInteger(request.tabId) ? request.tabId : undefined;
    return browser.tab(request.sessionId, request.action, tabId);
  });

  /**
   * Importing the user's own Chrome cookies.
   *
   * Every one of these answers a click in the pane's menu. None of them is reachable from a
   * tool, and the sites an import reads come from the request the chooser built out of the
   * user's own Chrome profile - never from the open page, a reply, or anything the model said.
   */
  ipcMain.handle(IPC_CHANNELS.browserCookiesGetState, () => browser.cookies.state());
  ipcMain.handle(IPC_CHANNELS.browserCookiesListProfiles, () => browser.cookies.profiles());
  ipcMain.handle(IPC_CHANNELS.browserCookiesListHosts, (_event, profileDir: unknown) =>
    browser.cookies.hosts(typeof profileDir === 'string' ? profileDir : '')
  );
  ipcMain.handle(IPC_CHANNELS.browserCookiesImport, (_event, request: CookieImportRequest) => {
    const hosts = Array.isArray(request?.hosts) ? request.hosts.filter(host => typeof host === 'string') : [];
    return browser.cookies.importSites(typeof request?.profileDir === 'string' ? request.profileDir : '', hosts);
  });
  ipcMain.handle(IPC_CHANNELS.browserCookiesForget, (_event, host: unknown) =>
    browser.cookies.forget(typeof host === 'string' ? host : '')
  );
  ipcMain.handle(IPC_CHANNELS.browserCookiesClear, () => browser.cookies.clear());

  ipcMain.handle(IPC_CHANNELS.toolsGetAccess, async () => ({ roots: await access.list() }));
  // The picker is the ONLY way a root is added. Keeping the grant behind an OS dialog the user
  // drives is what stops a crafted prompt from widening the tools' reach on its own.
  ipcMain.handle(IPC_CHANNELS.toolsGrantAccess, async event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ['openDirectory' as const], defaultPath: pickerStart() };
    const picked = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
    if (picked.canceled || picked.filePaths.length === 0) return { roots: await access.list() };
    await capabilitiesReady;
    const roots = await access.grant(picked.filePaths[0]);
    service.refreshAccessScopes();
    return completeCapabilityMutation(
      { roots },
      async () => {
        const active = (await capabilityLedger.state()).grants.filter(
          grant =>
            !grant.revokedAt &&
            grant.subject.kind === 'desktop-user' &&
            grant.capability === 'files' &&
            grant.scope.kind === 'path'
        );
        await capabilityLedger.revokeMatching(
          grant =>
            grant.subject.kind === 'desktop-user' &&
            grant.capability === 'files' &&
            grant.scope.kind === 'path' &&
            !roots.includes(grant.scope.value)
        );
        for (const root of roots) {
          if (active.some(grant => grant.scope.kind === 'path' && grant.scope.value === root)) continue;
          await capabilityLedger.grant({
            subject: { kind: 'desktop-user' },
            capability: 'files',
            scope: { kind: 'path', value: root },
            source: 'folder-picker',
          });
        }
      },
      logger
    );
  });
  ipcMain.handle(IPC_CHANNELS.toolsRevokeAccess, async (_event, root: string) => {
    await capabilitiesReady;
    const roots = await access.revoke(root);
    service.refreshAccessScopes();
    return completeCapabilityMutation(
      { roots },
      async () => {
        await capabilityLedger.revokeMatching(
          grant =>
            grant.subject.kind === 'desktop-user' &&
            grant.capability === 'files' &&
            grant.scope.kind === 'path' &&
            grant.scope.value === resolve(root)
        );
      },
      logger
    );
  });

  ipcMain.handle(IPC_CHANNELS.chatListVideoJobs, (_event, sessionId: string) => videoJobs.list(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatCancelVideoJob, (_event, sessionId: string, jobId: string) =>
    videoJobs.cancel(sessionId, jobId)
  );
  ipcMain.handle(IPC_CHANNELS.chatRecheckVideoJob, (_event, sessionId: string, jobId: string) =>
    videoJobs.recheck(sessionId, jobId)
  );
  // Open and Save act on the local copy only, resolved by job id: nothing the renderer passes
  // names a path, so neither can be pointed at another file.
  ipcMain.handle(IPC_CHANNELS.chatOpenVideo, async (_event, sessionId: string, jobId: string) => {
    const file = await videoJobs.localFile(sessionId, jobId);
    if (file) await shell.openPath(file.path);
  });
  ipcMain.handle(IPC_CHANNELS.chatSaveVideo, async (event, sessionId: string, jobId: string) => {
    const file = await videoJobs.localFile(sessionId, jobId);
    if (!file) return false;
    const extension = file.mimeType === 'video/webm' ? 'webm' : 'mp4';
    const options = {
      defaultPath: join(app.getPath('downloads'), `video-${jobId}.${extension}`),
      filters: [{ name: 'Video', extensions: [extension] }],
    };
    const window = BrowserWindow.fromWebContents(event.sender);
    const picked = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options));
    if (picked.canceled || !picked.filePath) return false;
    await copyFile(file.path, picked.filePath);
    return true;
  });
  // The link is copied here rather than returned, so a signed storage URL never enters the renderer.
  ipcMain.handle(IPC_CHANNELS.chatCopyVideoLink, async (_event, sessionId: string, jobId: string) => {
    const link = await videoJobs.freshLink(sessionId, jobId);
    if (!link.ok) return link;
    clipboard.writeText(link.url);
    return { ok: true, expiresAt: link.expiresAt };
  });

  const claudeImport = registerClaudeImport(ipcMain, {
    home,
    userData,
    store,
    attachments,
    scopeKey: () => {
      const scope = sessionScopeFor(auth.getState());
      return scope ? sessionScopeKey(scope) : null;
    },
    pickModel: () => service.modelForNewSession().catch(() => undefined),
    listSessions: () => store.list(),
    deleteImported: async (sessionId, scopeKey) => {
      const outcome = await service.deleteImportedSession(sessionId, scopeKey);
      if (outcome === 'removed') await pullRequests.forget(sessionId);
      return outcome;
    },
    send,
    logger,
    webApi: () => auth.getApiClient(),
  });

  return {
    service,
    host: { runtime, events: hostEvents, logger },
    background,
    mcp,
    browser,
    simulatorView,
    modelViews,
    pullRequests,
    composerDrafts,
    claudeImport,
    spareWorktrees,
    modelServers,
    stopModelServers: () => {
      lateReload.stop();
      modelServers.stop();
    },
    stopLocalServers: () => modelServers.stopLocalServers(),
    localContext,
    modelSettings,
    capabilityLedger,
    respondToApproval,
    store,
  };
}

export { ChatService } from './ChatService';
export { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';
