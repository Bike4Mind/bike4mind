import { randomUUID } from 'node:crypto';
import { copyFile, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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
  safeStorage,
  shell,
  type WebContents,
} from 'electron';
import { ChatModels } from '@bike4mind/common';
import type {
  ChatApprovalAnswer,
  ChatApprovalMode,
  ChatArtifactPublishRequest,
  ChatAttachmentInput,
  ChatQueueEvent,
  ChatSessionStatusEvent,
  ChatSessionSummary,
  ChatStreamEvent,
  ProjectInspection,
  SendMessageRequest,
  StartSpawnSuggestionRequest,
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
  type BrowserFreezeFrameRequest,
  type BrowserGoAction,
  type BrowserGoRequest,
  type BrowserNavigateRequest,
  type BrowserPaneBounds,
  type BrowserPaneRequest,
  type BrowserPaneState,
  type BrowserTabAction,
  type BrowserTabRequest,
} from '@shared/ipc';
import type { McpMutationResult, McpServerInput, McpServersState } from '@shared/mcp';
import type { AuthService } from '../auth';
import { createMainLogger } from '../logger';
import { ApprovalModePreference } from './ApprovalModePreference';
import { LocalContextPreference } from './LocalContextPreference';
import { registerLocalContextIpc } from './localContextIpc';
import { localContextSizing, localHardware } from './localContextSizing';
import { SidebarSectionStore } from './SidebarSectionStore';
import { registerImageMenuIpc } from './imageMenuIpc';
import { registerSessionCreateIpc } from './sessionCreateIpc';
import { placeNewSession, registerSidebarIpc } from './sidebarIpc';
import { AttachmentStore } from './AttachmentStore';
import { BrowserManager, NO_PAGE } from './browser/BrowserManager';
import { IMAGE_BYTE_CAP, IMAGE_MAX_EDGE, isImageMediaType } from './attachments';
import { ArtifactLibrary } from './artifacts/ArtifactLibrary';
import { SkillMarket } from './skills/SkillMarket';
import { ArtifactPublisher } from './artifacts/ArtifactPublisher';
import { SharePublisher } from './artifacts/SharePublisher';
import { registerArtifactProtocol } from './artifacts/sandboxProtocol';
import { ChatService, type ChatServiceDeps } from './ChatService';
import { CHAT_STREAM_TAG } from './devLogTag';
import { McpManager } from './mcp/McpManager';
import { McpServerStore } from './mcp/McpServerStore';
import { privateFile } from '../privateFile';
import { MediaApiClient } from './media/MediaApiClient';
import { MediaStore } from './media/MediaStore';
import { VideoJobScheduler } from './media/VideoJobScheduler';
import { VideoJobStore } from './media/VideoJobStore';
import { MessageQueue } from './MessageQueue';
import { registerMediaProtocol } from './media/protocol';
import { ModelCatalog } from './ModelCatalog';
import { ModelPreference } from './ModelPreference';
import { SessionActivity } from './SessionActivity';
import { SessionStore } from './SessionStore';
import { LocalHistory } from './LocalHistory';
import { registerHistoryIpc } from './historyIpc';
import { captureHistoryPage } from './captureHistoryPage';
import { forgetLocalContexts, OllamaLocal } from './OllamaLocal';
import { registerModelServersIpc } from '../modelServers/ipc';
import { LocalModels } from '../modelServers/LocalModels';
import { ModelServerRegistry } from '../modelServers/ModelServerRegistry';
import { ModelServerStore } from '../modelServers/ModelServerStore';
import { withEnteredSpecs } from '../models/enteredHardware';
import { machineView } from '../models/fit';
import { LOCAL_SERVER_ID } from '@shared/modelServers';
import { sessionScopeFor, sessionScopeForChat, sessionScopeKey } from './sessionScope';
import {
  branchCheckouts,
  currentBranch,
  isGitRepository,
  listBranches,
  projectDisplayName,
  unusableProjectReason,
} from './project/git';
import { readWorkspaceChanges } from './project/workspaceChanges';
import { accountSkillsProvider } from './skills/accountSkills';
import { ProjectTrustStore } from './skills/ProjectTrustStore';
import { ApprovalLog } from './permissions/ApprovalLog';
import { ClaudeCodeSettings, MANAGED_SETTINGS_PATH } from './permissions/ClaudeCodeSettings';
import { PermissionRuleStore } from './permissions/PermissionRuleStore';
import { PermissionService } from './permissions/PermissionService';
import { CapabilityLedger } from './capabilities/CapabilityLedger';
import {
  capabilityHandlers,
  completeCapabilityMutation,
  retireSessionApprovals,
} from './capabilities/capabilityHandlers';
import { SkillCatalog } from './skills/SkillCatalog';
import { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';
import { DependencyInstaller } from './project/dependencyInstall';
import { RecentFolderStore } from './project/RecentFolderStore';
import { SpareWorktrees } from './project/workspace';
import { folderToRemember } from './project/recentFolderToRecord';
import { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';
import { parseReasoningEffortSetting, storedReasoningEffortSetting } from './reasoningEffort';
import { ForegroundCommandRegistry } from './tools/ForegroundCommandRegistry';
import { keepSessionWritesIn } from './tools/sessionScripts';
import type { PreparedImage } from './tools/types';
import { desktopScreenCapturer } from './screen/desktopScreen';
import { devLog } from '../devlog/DevLogSink';
import { registerPullRequests } from '../pr';
import type { PrMonitor } from '../pr/PrMonitor';
import { appWindows } from '../windows';
import { registerClaudeImport } from '../claudeImport';
import type { ClaudeImportService } from '../claudeImport/ClaudeImportService';

const VERBOSE = process.env.B4M_DESKTOP_VERBOSE === '1';
/** Diagnosis only; see apps/desktop/docs/model-wait-findings.md. */
const TURN_TIMING = process.env.B4M_DESKTOP_TURN_TIMING === '1';

function sameSubject(left: CapabilitySubject, right: CapabilitySubject): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'desktop-user') return true;
  if (left.kind === 'project' && right.kind === 'project') return left.directory === right.directory;
  return left.kind === 'session' && right.kind === 'session' && left.sessionId === right.sessionId;
}

/**
 * The model a new conversation prefers until the user has picked one (see ModelPreference),
 * and when the deployment does not offer the one they picked.
 *
 * A PREFERENCE, not a list: the real set comes from the server (see ModelCatalog), and a
 * deployment that does not offer this one gets the first model it does offer instead. It is
 * also the fixed fallback for a session file with no model saved on it - deliberately not the
 * remembered pick, so an old conversation never changes model because of a choice made in
 * another one.
 */
const PREFERRED_MODEL: string = ChatModels.CLAUDE_5_OPUS;

/**
 * The reasoning effort a conversation starts on, read per launch so a benchmark can compare
 * efforts without a rebuild. The user's own choice is per session and outranks this - see
 * SessionStore - so this only reaches a conversation that has never been given one.
 */
const REASONING_EFFORT = parseReasoningEffortSetting(process.env.B4M_DESKTOP_REASONING_EFFORT);

/** How much of a background process's output the panel asks for when it rejoins after a reload. */
const PANEL_TAIL_CHARS = 20_000;

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
  /** Background processes, exposed so main/index.ts can tear them down on every quit path. */
  background: BackgroundProcessRegistry;
  /** MCP connections, torn down on the same two quit passes for the same reason. */
  mcp: McpManager;
  /** The agent's hidden browser windows, closed with the last app window and on quit. */
  browser: BrowserManager;
  /** Each conversation's pull request, and the timers that watch it. */
  pullRequests: PrMonitor;
  /** Import from Claude; started once the window is up so it never delays launch. */
  claudeImport: ClaudeImportService;
  /** Spare checkouts, removed on the quit pass that can wait for git. */
  spareWorktrees: SpareWorktrees;
  /** Saved model servers, which the Models screen also pulls to and removes from. */
  modelServers: ModelServerRegistry;
  /** The Settings choice of local model context, which the Models screen's fit badges also plan for. */
  localContext: LocalContextPreference;
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
 * Publish one renderer-bound push to the developer log.
 *
 * The downstream half of the chat stream, and a different thing from the upstream SSE frames
 * logged in completions.ts: these are what the UI is actually told, after the agent loop has
 * folded tool calls, reasoning and queue changes into it. Same source, so the same single tag -
 * the direction is a field. Seeing both texts side by side is the point: a delta that differs
 * from the frame it came from is the agent loop having rewritten it.
 *
 * Fields are named one at a time, never spread: a payload carries whatever a session put in it,
 * and an allowlist is the only reason this cannot start carrying something it should not.
 */
function logDownstream(channel: string, payload: unknown): void {
  devLog.publish(() => {
    const event = (payload ?? {}) as { type?: unknown; sessionId?: unknown; text?: unknown; status?: unknown };
    // The event's own kind, or the channel's name without its namespace.
    const kind = typeof event.type === 'string' ? event.type : (channel.split(':')[1] ?? channel);
    const text = typeof event.text === 'string' ? event.text : '';
    return {
      tags: [CHAT_STREAM_TAG],
      message: `downstream ${kind}${text ? `: ${text}` : ''}`,
      fields: {
        channel,
        ...(text ? { chars: text.length } : {}),
        ...(typeof event.sessionId === 'string' ? { session: event.sessionId } : {}),
        ...(typeof event.status === 'string' ? { status: event.status } : {}),
      },
    };
  });
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
  } = {}
): RegisteredChat {
  const logger = createMainLogger(VERBOSE);
  const userData = app.getPath('userData');
  // Beside approval-mode.json and app-wide like it; see ModelPreference for why.
  const modelPreference = new ModelPreference(join(userData, 'model-preference.json'));
  // Unconditional, unlike everything else at this level: it is the one way to check which model
  // a launch will start conversations on without opening the picker. The read also warms the
  // cache, so the first new conversation does not wait on the file.
  void modelPreference
    .read()
    .then(remembered =>
      logger.warn(
        `CHAT: preferred model for new conversations: ${remembered ?? PREFERRED_MODEL} (${remembered ? 'remembered pick' : 'built-in default'})`
      )
    );
  // Beside the sessions directory rather than inside it: everything in there is migrated into
  // a scope folder on first use, and this records how the user likes to work rather than
  // anything belonging to one conversation or one account.
  const approvalModes = new ApprovalModePreference(join(userData, 'approval-mode.json'));
  // Scoped to the backend and the account, not just to this machine: one install reaches
  // production and a local server, and can be signed in as a different person on each. The
  // provider is read per operation, so a switch takes effect on the next list with nothing
  // here to invalidate. See ./sessionScope for the key and the one-time migration.
  const store = new SessionStore(
    join(userData, 'sessions'),
    PREFERRED_MODEL,
    randomUUID(),
    () => sessionScopeForChat(auth.getState()),
    approvalModes,
    REASONING_EFFORT
  );
  keepSessionWritesIn(store);
  const access = new AccessStore(join(userData, 'tool-access.json'));
  const capabilityLedger = new CapabilityLedger(join(userData, 'capability-ledger.json'));
  // App-wide like approval-mode.json; see SidebarSectionStore.
  const sidebarSections = new SidebarSectionStore(join(userData, 'sidebar-sections.json'));
  const recentFolders = new RecentFolderStore(join(userData, 'recent-folders.json'));
  const spareWorktrees = new SpareWorktrees();
  // The trust file is its own file beside tool-access.json, and for the same reason: both record
  // a consent the user gave once and should not be asked for again on every launch.
  const projectTrust = new ProjectTrustStore(join(userData, 'project-skill-trust.json'));
  const skills = new SkillCatalog(projectTrust, accountSkillsProvider(auth, userData), logger);
  // App-wide like approval-mode.json. Claude Code's files are only ever read; the protected roots
  // are folders no allow rule may cover, since a call writing there would grant itself more.
  const home = app.getPath('home');
  const claudeCode = new ClaudeCodeSettings({ home, logger, onChange: () => permissions.invalidate() });
  const permissions: PermissionService = new PermissionService({
    store: new PermissionRuleStore(join(userData, 'permission-rules.json')),
    claudeCode,
    isTrusted: directory => projectTrust.isTrusted(directory),
    home,
    protectedRoots: [userData, join(home, '.claude'), dirname(MANAGED_SETTINGS_PATH)],
    logger,
  });
  void permissions.start().catch(error => logger.warn(`PERMISSIONS: could not load rules: ${String(error)}`));
  const capabilitiesReady = Promise.all([
    access.list(),
    projectTrust.list(),
    new PermissionRuleStore(join(userData, 'permission-rules.json')).read(),
  ])
    .then(async ([roots, trustedProjects, stored]) => {
      await retireSessionApprovals(capabilityLedger);
      await capabilityLedger.migrate({ roots, trustedProjects, permissions: stored });
    })
    .catch(error => logger.warn(`CAPABILITIES: could not migrate grants: ${String(error)}`));
  const attachments = new AttachmentStore(join(userData, 'attachments'), logger, shrinkImage);
  const media = new MediaStore(join(userData, 'media'));
  registerMediaProtocol(media);
  registerArtifactProtocol();
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
  void localHardware.profile();
  const localSizing = localContextSizing({ setting: () => localContext.read() });
  // safeStorage like the MCP secrets: a server's token or header value never goes to plain JSON.
  const modelServers = new ModelServerRegistry({
    store: new ModelServerStore(safeStorage, privateFile(join(userData, 'model-servers.json')), logger),
    logger,
    changed: servers => {
      models.forgetLocal();
      send(IPC_CHANNELS.modelServersChanged, servers);
    },
    localSpecsChanged: () => {
      forgetLocalContexts();
      localSizing.forget?.();
      models.forgetLocal();
    },
  });
  localHardware.setOverride(probed => withEnteredSpecs(probed, modelServers.specs(LOCAL_SERVER_ID)));
  void modelServers.start().catch(error => logger.warn(`MODEL SERVERS: could not load: ${String(error)}`));
  const local = new LocalModels(new OllamaLocal((url, init) => net.fetch(url, init), localSizing), modelServers);
  const models = new ModelCatalog(
    {
      logger,
      getApiClient: () => auth.getApiClient(),
      getEnvironmentUrl: () => auth.getState().environment.url,
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

  // Built before the service so the service's tool results can bind a PR. It reaches the
  // service only through `chat`, which is first called long after both exist.
  const pullRequests = registerPullRequests({
    path: join(userData, 'pull-requests.json'),
    chat: () => service,
    store,
    logger,
    send,
  });
  const broadcast = (event: ChatStreamEvent) => {
    send(IPC_CHANNELS.chatStreamEvent, event);
    if (event.type === 'tool-end') pullRequests.observeToolEnd(event.sessionId, event.call);
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
    emit: (sessionId, job) => broadcast({ type: 'video-job', sessionId, job }),
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

  // Declared before the two things that feed it, because both take it as a constructor
  // argument: the gate reports who is waiting on the user, the service reports who is
  // replying, and this turns the pair into the one status a sidebar row draws.
  const activity = new SessionActivity((event: ChatSessionStatusEvent) => {
    send(IPC_CHANNELS.chatSessionStatus, event);
    // Only reached once a turn has run, long after pullRequests below exists.
    if (event.status === 'done') pullRequests.turnSettled(event.sessionId);
  });

  // Typed-ahead messages, on their own channel: this is per-session state that outlives any
  // one reply, so it travels beside the status pushes rather than inside the reply stream.
  const queue = new MessageQueue((event: ChatQueueEvent) => send(IPC_CHANNELS.chatQueueChanged, event));

  const approvals = new ApprovalGate({
    requested: sessionId => activity.approvalRequested(sessionId),
    settled: sessionId => activity.approvalSettled(sessionId),
  });

  // Output and status go out on the same channel as reply tokens: a background process is
  // still something that conversation is doing, and a renderer that reloads re-subscribes to
  // one stream rather than two.
  const background = new BackgroundProcessRegistry({
    output: (sessionId, processId, stream, text) =>
      broadcast({ type: 'background-output', sessionId, processId, stream, text }),
    status: (sessionId, process) => broadcast({ type: 'background-status', sessionId, process }),
    // Only ever fires once a process has run, long after `service` below exists.
    exited: (sessionId, processId) => service.backgroundExited(sessionId, processId),
  });

  // safeStorage for the same reason as the auth vault: an env variable holding an API key and a
  // header holding a bearer token are credentials, and neither goes to plain JSON in userData.
  const mcp = new McpManager(
    new McpServerStore(safeStorage, privateFile(join(userData, 'mcp-servers.json')), logger),
    logger,
    (state: McpServersState) => send(IPC_CHANNELS.mcpServersChanged, state)
  );

  const foreground = new ForegroundCommandRegistry();

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

  const service = new ChatService({
    store,
    access,
    attachments,
    models,
    logger,
    turnTiming: TURN_TIMING,
    preferredModel: PREFERRED_MODEL,
    modelMemory: modelPreference,
    approvals,
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
    // App-wide like approval-mode.json: a record of decisions, kept after their conversations.
    approvalLog: new ApprovalLog(join(userData, 'approval-log.jsonl'), message => logger.warn(message)),
    background,
    foreground,
    dependencies: new DependencyInstaller(background),
    spareWorktrees,
    media,
    videoJobs,
    activity,
    sidebarSections,
    mcp,
    browser,
    screen: desktopScreenCapturer(app.getName()),
    prepareImage: prepareToolImage,
    history,
    local,
    artifacts,
    queue,
    skills,
    // userData holds the auth vault. Without this a user who shares their home folder would be
    // one `cat` away from the access token, which breaks the rule that tokens never leave the main process.
    protectedPaths: [userData],
    getApiClient: () => auth.getApiClient(),
    isDeviceLocal: () => sessionScopeForChat(auth.getState())?.local === true,
    getEnvironmentUrl: () => auth.getState().environment.url,
    emit: event => {
      broadcast(event);
      try {
        hooks.observeStream?.(event);
      } catch {
        logger.warn('FLEET: activity observer failed');
      }
    },
    summaryChanged: (summary: ChatSessionSummary) => send(IPC_CHANNELS.chatSessionSummary, summary),
    sessionClosed: hooks.sessionClosed,
    releaseSessionTerminals: hooks.releaseSessionTerminals,
  });

  ipcMain.handle(IPC_CHANNELS.chatListModels, (_event, force: boolean) => service.listModels(force));
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
  ipcMain.handle(IPC_CHANNELS.chatSetSessionArchived, (_event, sessionId: string, archived: boolean) =>
    service.setSessionArchived(sessionId, archived)
  );
  ipcMain.handle(IPC_CHANNELS.chatListSkills, (_event, sessionId: string) => service.listSkills(sessionId));
  // Coerced rather than trusted, like the approval mode above: this is the only door to project
  // trust, so anything that is not an explicit `true` has to land as "not trusted".
  ipcMain.handle(IPC_CHANNELS.chatSetProjectSkillsTrusted, (_event, sessionId: string, trusted: boolean) =>
    service.setProjectSkillsTrusted(sessionId, trusted === true)
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
  ipcMain.handle(IPC_CHANNELS.chatSetSessionPinned, (_event, sessionId: string, pinned: boolean) =>
    service.setSessionPinned(sessionId, pinned)
  );
  // Validated here rather than trusted, for the same reason the folder grant goes through a
  // native picker: this is the only door to the approval mode, so an unrecognised value must
  // not reach the store and land as something looser than the user asked for.
  ipcMain.handle(IPC_CHANNELS.chatSetApprovalMode, (_event, sessionId: string, mode: ChatApprovalMode) =>
    mode === 'ask' || mode === 'auto' || mode === 'full' ? service.setApprovalMode(sessionId, mode) : null
  );
  ipcMain.handle(IPC_CHANNELS.chatListSessions, () => service.listSessions());
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
    },
  });
  ipcMain.handle(IPC_CHANNELS.capabilitiesGetState, () => capabilityIpc.getState());
  ipcMain.handle(IPC_CHANNELS.capabilitiesRevoke, (_event, grantId: unknown) => capabilityIpc.revoke(grantId));
  ipcMain.handle(IPC_CHANNELS.chatGetSessionStatuses, () => service.sessionStatuses());
  const rememberFolder = (directory: string | null): void => {
    if (!directory) return;
    recentFolders
      .record(directory)
      .catch(error => logger.warn(`CHAT: could not remember recent folder: ${String(error)}`));
  };
  registerSessionCreateIpc(ipcMain, {
    createSession: () => service.createSession(),
    createCodeSession: request => service.createCodeSession(request),
    place: (sessionId, sectionId) =>
      placeNewSession(sidebarSections, sessionId, sectionId, error =>
        logger.warn(`CHAT: could not place new session in its sidebar section: ${String(error)}`)
      ),
    rememberFolder,
  });

  ipcMain.handle(IPC_CHANNELS.chatUpdateProject, async (_event, request: UpdateProjectRequest) => {
    const result = await service.updateProject(request);
    rememberFolder(folderToRemember(request, result));
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.chatPickProjectDirectory, (event): Promise<string | null> => pickDirectory(event.sender));
  ipcMain.handle(IPC_CHANNELS.chatListRecentFolders, () => recentFolders.list());
  ipcMain.handle(IPC_CHANNELS.chatRemoveRecentFolder, async (_event, directory: unknown) => {
    if (typeof directory === 'string') {
      await recentFolders.remove(directory);
      void spareWorktrees.forget(directory);
    }
    return recentFolders.list();
  });

  // Reading branches is a git call on a path the user just chose in a native dialog, so it is
  // not gated: nothing here writes, and the alternative is a branch field the user must type
  // from memory.
  ipcMain.handle(IPC_CHANNELS.chatInspectProject, async (_event, directory: string): Promise<ProjectInspection> => {
    const resolved = resolve(directory);
    if (!(await isGitRepository(resolved))) {
      const base = {
        directory: resolved,
        name: basename(resolved),
        isRepository: false,
        branches: [],
        currentBranch: null,
      };
      const refusal = await unusableProjectReason(resolved);
      return refusal ? { ...base, refusal } : base;
    }
    const base = { directory: resolved, name: await projectDisplayName(resolved) };
    try {
      // The marks are an aid, not the list: a worktree listing git cannot answer leaves the
      // branches standing, and a toggle-off pick is still checked against git in main.
      const [branches, head, checkedOutElsewhere] = await Promise.all([
        listBranches(resolved),
        currentBranch(resolved),
        branchCheckouts(resolved).catch(() => ({})),
      ]);
      return { ...base, isRepository: true, branches, currentBranch: head, checkedOutElsewhere };
    } catch (err) {
      return {
        ...base,
        isRepository: true,
        branches: [],
        currentBranch: null,
        error: err instanceof Error ? err.message : 'Could not read this repository.',
      };
    }
  });

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
  ipcMain.handle(IPC_CHANNELS.chatGetSession, (_event, sessionId: string) => service.getSession(sessionId));
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
  ipcMain.handle(IPC_CHANNELS.chatRenameSession, (_event, sessionId: string, title: string) =>
    service.renameSession(sessionId, title)
  );
  ipcMain.handle(IPC_CHANNELS.chatInspectWorktreeRemoval, (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('Invalid conversation id');
    return service.inspectSessionWorktreeRemoval(sessionId);
  });
  // Only a repository the user already has a conversation or recent folder for is ever touched.
  const knownRepository = async (directory: string) => {
    const recent = await recentFolders.list();
    if (
      !(await service.isKnownRepository(
        directory,
        recent.map(folder => folder.path)
      ))
    ) {
      throw new Error('Unknown project directory');
    }
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
  ipcMain.handle(IPC_CHANNELS.chatDeleteSession, async (_event, sessionId: unknown, removeWorktree: unknown) => {
    if (typeof sessionId !== 'string' || (removeWorktree !== undefined && typeof removeWorktree !== 'boolean')) {
      throw new Error('Invalid delete request');
    }
    await service.deleteSession(sessionId, removeWorktree === true);
    await pullRequests.forget(sessionId);
  });
  registerSidebarIpc(ipcMain, sidebarSections, sessionId =>
    store.get(sessionId).then(
      session => session !== null,
      () => false
    )
  );
  ipcMain.handle(IPC_CHANNELS.chatSendMessage, (_event, request: SendMessageRequest) =>
    service.send(request.sessionId, request.text, request.attachments)
  );
  ipcMain.handle(IPC_CHANNELS.chatStopReply, (_event, sessionId: string) => service.stop(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatContinueReply, (_event, sessionId: string) => service.continueReply(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatClearContext, (_event, sessionId: string) => service.clearContext(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatCompactContext, (_event, sessionId: string, focus?: string) =>
    service.compactContext(sessionId, focus ?? '')
  );
  ipcMain.handle(IPC_CHANNELS.chatSuggestNextPrompt, (_event, sessionId: string, model: unknown) =>
    service.suggestNextPrompt(sessionId, typeof model === 'string' && model ? model : null)
  );
  ipcMain.handle(IPC_CHANNELS.chatGetQueued, (_event, sessionId: string) => service.queuedMessages(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatCancelQueued, (_event, sessionId: string, queuedId: string) =>
    service.cancelQueued(sessionId, queuedId)
  );
  ipcMain.handle(IPC_CHANNELS.chatSendQueuedNow, (_event, sessionId: string, queuedId: string) =>
    service.sendQueuedNow(sessionId, queuedId)
  );
  ipcMain.handle(IPC_CHANNELS.chatStartSpawnSuggestion, (_event, request: StartSpawnSuggestionRequest) =>
    service.startSpawnSuggestion(request)
  );
  ipcMain.handle(IPC_CHANNELS.chatDismissSpawnSuggestion, (_event, sessionId: string, suggestionId: string) =>
    service.dismissSpawnSuggestion(sessionId, suggestionId)
  );
  ipcMain.handle(IPC_CHANNELS.chatRespondToApproval, (_event, approvalId: string, answer: ChatApprovalAnswer) =>
    approvals.resolve(approvalId, answer)
  );

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
    background.kill(processId, sessionId).then(() => undefined)
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
  });

  return { service, background, mcp, browser, pullRequests, claudeImport, spareWorktrees, modelServers, localContext };
}

export { ChatService } from './ChatService';
export { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';
