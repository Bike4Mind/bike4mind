import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, type WebContents } from 'electron';
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
  CreateCodeSessionRequest,
  ProjectInspection,
  SendMessageRequest,
  UpdateProjectRequest,
} from '@shared/chat';
import type { CookieImportRequest } from '@shared/browserCookies';
import {
  IPC_CHANNELS,
  type BrowserGoAction,
  type BrowserGoRequest,
  type BrowserNavigateRequest,
  type BrowserPaneBounds,
  type BrowserPaneRequest,
  type BrowserPaneState,
} from '@shared/ipc';
import type { McpMutationResult, McpServerInput, McpServersState } from '@shared/mcp';
import type { AuthService } from '../auth';
import { createMainLogger } from '../logger';
import { ApprovalModePreference } from './ApprovalModePreference';
import { AttachmentStore } from './AttachmentStore';
import { BrowserManager, NO_PAGE } from './browser/BrowserManager';
import { IMAGE_BYTE_CAP, isImageMediaType } from './attachments';
import { ArtifactLibrary } from './artifacts/ArtifactLibrary';
import { ArtifactPublisher } from './artifacts/ArtifactPublisher';
import { SharePublisher } from './artifacts/SharePublisher';
import { registerArtifactProtocol } from './artifacts/sandboxProtocol';
import { ChatService } from './ChatService';
import { CHAT_STREAM_TAG } from './devLogTag';
import { McpManager } from './mcp/McpManager';
import { McpServerStore, type StoreFile } from './mcp/McpServerStore';
import { MediaStore } from './media/MediaStore';
import { MessageQueue } from './MessageQueue';
import { registerMediaProtocol } from './media/protocol';
import { ModelCatalog } from './ModelCatalog';
import { ModelPreference } from './ModelPreference';
import { SessionActivity } from './SessionActivity';
import { SessionStore } from './SessionStore';
import { sessionScopeFor } from './sessionScope';
import { currentBranch, isGitRepository, listBranches, projectDisplayName, unusableProjectReason } from './project/git';
import { ProjectTrustStore } from './skills/ProjectTrustStore';
import { SkillCatalog } from './skills/SkillCatalog';
import { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';
import { DependencyInstaller } from './project/dependencyInstall';
import { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';
import { parseReasoningEffortSetting, storedReasoningEffortSetting } from './reasoningEffort';
import { ForegroundCommandRegistry } from './tools/ForegroundCommandRegistry';
import { devLog } from '../devlog/DevLogSink';
import { appWindows } from '../windows';

const VERBOSE = process.env.B4M_DESKTOP_VERBOSE === '1';
/** Diagnosis only; see apps/desktop/docs/model-wait-findings.md. */
const TURN_TIMING = process.env.B4M_DESKTOP_TURN_TIMING === '1';

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
 * Build the chat service and expose it over IPC.
 *
 * Every channel here is main-side work on purpose: sending a message needs the access token,
 * which never leaves this process, so the renderer asks for a turn and receives text.
 */
export interface RegisteredChat {
  service: ChatService;
  /** Background processes, exposed so main/index.ts can tear them down on every quit path. */
  background: BackgroundProcessRegistry;
  /** MCP connections, torn down on the same two quit passes for the same reason. */
  mcp: McpManager;
  /** The agent's hidden browser windows, closed with the last app window and on quit. */
  browser: BrowserManager;
}

/**
 * The MCP config file, written the same way the auth vault is: mode 0600 and write-then-rename,
 * because a crash mid-write would otherwise leave a truncated list of servers.
 */
function mcpStoreFile(path: string): StoreFile {
  return {
    read: () => readFile(path, 'utf8').catch(() => null),
    write: async contents => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
    },
  };
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

export function registerChat(auth: AuthService): RegisteredChat {
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
    () => sessionScopeFor(auth.getState()),
    approvalModes,
    REASONING_EFFORT
  );
  const access = new AccessStore(join(userData, 'tool-access.json'));
  // Its own file beside tool-access.json, and for the same reason: both record a consent the
  // user gave once and should not be asked for again on every launch.
  const skills = new SkillCatalog(new ProjectTrustStore(join(userData, 'project-skill-trust.json')));
  const attachments = new AttachmentStore(join(userData, 'attachments'), logger, shrinkImage);
  const media = new MediaStore(join(userData, 'media'));
  registerMediaProtocol(media);
  registerArtifactProtocol();
  const artifacts = new ArtifactPublisher(() => auth.getApiClient(), logger);
  const artifactLibrary = new ArtifactLibrary(() => auth.getApiClient(), logger);
  const models = new ModelCatalog({
    logger,
    getApiClient: () => auth.getApiClient(),
    getEnvironmentUrl: () => auth.getState().environment.url,
  });

  const send = (channel: string, payload: unknown) => {
    logDownstream(channel, payload);
    for (const window of appWindows()) {
      window.webContents.send(channel, payload);
    }
  };

  const broadcast = (event: ChatStreamEvent) => send(IPC_CHANNELS.chatStreamEvent, event);

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
  const activity = new SessionActivity((event: ChatSessionStatusEvent) => send(IPC_CHANNELS.chatSessionStatus, event));

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
  });

  // safeStorage for the same reason as the auth vault: an env variable holding an API key and a
  // header holding a bearer token are credentials, and neither goes to plain JSON in userData.
  const mcp = new McpManager(
    new McpServerStore(safeStorage, mcpStoreFile(join(userData, 'mcp-servers.json')), logger),
    logger,
    (state: McpServersState) => send(IPC_CHANNELS.mcpServersChanged, state)
  );

  const foreground = new ForegroundCommandRegistry();

  const browser = new BrowserManager(
    (sessionId, state) => send(IPC_CHANNELS.browserPageState, { sessionId, ...state }),
    state => send(IPC_CHANNELS.browserCookiesChanged, state)
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
    background,
    foreground,
    dependencies: new DependencyInstaller(background),
    media,
    activity,
    mcp,
    browser,
    artifacts,
    queue,
    skills,
    // userData holds the auth vault. Without this a user who shares their home folder would be
    // one `cat` away from the access token, which is T4's invariant broken through a side door.
    protectedPaths: [userData],
    getApiClient: () => auth.getApiClient(),
    getEnvironmentUrl: () => auth.getState().environment.url,
    emit: broadcast,
    summaryChanged: (summary: ChatSessionSummary) => send(IPC_CHANNELS.chatSessionSummary, summary),
  });

  ipcMain.handle(IPC_CHANNELS.chatListModels, (_event, force: boolean) => service.listModels(force));
  ipcMain.handle(IPC_CHANNELS.chatSetSessionArchived, (_event, sessionId: string, archived: boolean) =>
    service.setSessionArchived(sessionId, archived)
  );
  ipcMain.handle(IPC_CHANNELS.chatListSkills, (_event, sessionId: string) => service.listSkills(sessionId));
  // Coerced rather than trusted, like the approval mode above: this is the only door to project
  // trust, so anything that is not an explicit `true` has to land as "not trusted".
  ipcMain.handle(IPC_CHANNELS.chatSetProjectSkillsTrusted, (_event, sessionId: string, trusted: boolean) =>
    service.setProjectSkillsTrusted(sessionId, trusted === true)
  );
  ipcMain.handle(IPC_CHANNELS.chatSetSessionModel, (_event, sessionId: string, model: string) =>
    service.setSessionModel(sessionId, model)
  );
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
  ipcMain.handle(IPC_CHANNELS.chatGetSessionStatuses, () => service.sessionStatuses());
  ipcMain.handle(IPC_CHANNELS.chatCreateSession, () => service.createSession());
  ipcMain.handle(IPC_CHANNELS.chatCreateCodeSession, (_event, request: CreateCodeSessionRequest) =>
    service.createCodeSession(request)
  );

  ipcMain.handle(IPC_CHANNELS.chatUpdateProject, (_event, request: UpdateProjectRequest) =>
    service.updateProject(request)
  );

  ipcMain.handle(IPC_CHANNELS.chatPickProjectDirectory, (event): Promise<string | null> => pickDirectory(event.sender));

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
      const [branches, head] = await Promise.all([listBranches(resolved), currentBranch(resolved)]);
      return { ...base, isRepository: true, branches, currentBranch: head };
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

  ipcMain.handle(IPC_CHANNELS.chatAddContextDirectory, async (event, sessionId: string) => {
    const directory = await pickDirectory(event.sender);
    if (!directory) return null;
    return service.addContextDirectory(sessionId, directory);
  });

  ipcMain.handle(IPC_CHANNELS.chatRemoveContextDirectory, (_event, sessionId: string, directory: string) =>
    service.removeContextDirectory(sessionId, directory)
  );
  ipcMain.handle(IPC_CHANNELS.chatGetSession, (_event, sessionId: string) => service.getSession(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatRenameSession, (_event, sessionId: string, title: string) =>
    service.renameSession(sessionId, title)
  );
  ipcMain.handle(IPC_CHANNELS.chatDeleteSession, (_event, sessionId: string) => service.deleteSession(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatSendMessage, (_event, request: SendMessageRequest) =>
    service.send(request.sessionId, request.text, request.attachments)
  );
  ipcMain.handle(IPC_CHANNELS.chatStopReply, (_event, sessionId: string) => service.stop(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatContinueReply, (_event, sessionId: string) => service.continueReply(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatClearContext, (_event, sessionId: string) => service.clearContext(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatCompactContext, (_event, sessionId: string, focus?: string) =>
    service.compactContext(sessionId, focus ?? '')
  );
  ipcMain.handle(IPC_CHANNELS.chatSuggestNextPrompt, (_event, sessionId: string) =>
    service.suggestNextPrompt(sessionId)
  );
  ipcMain.handle(IPC_CHANNELS.chatGetQueued, (_event, sessionId: string) => service.queuedMessages(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatCancelQueued, (_event, sessionId: string, queuedId: string) =>
    service.cancelQueued(sessionId, queuedId)
  );
  ipcMain.handle(IPC_CHANNELS.chatSendQueuedNow, (_event, sessionId: string, queuedId: string) =>
    service.sendQueuedNow(sessionId, queuedId)
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
    return { roots: await access.grant(picked.filePaths[0]) };
  });
  ipcMain.handle(IPC_CHANNELS.toolsRevokeAccess, async (_event, root: string) => ({
    roots: await access.revoke(root),
  }));

  return { service, background, mcp, browser };
}

export { ChatService } from './ChatService';
export { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';
