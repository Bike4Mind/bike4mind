import { basename, join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, nativeImage, type WebContents } from 'electron';
import { ChatModels } from '@bike4mind/common';
import type {
  ChatApprovalDecision,
  ChatAttachmentInput,
  ChatSessionStatusEvent,
  ChatStreamEvent,
  CreateCodeSessionRequest,
  ProjectInspection,
  SendMessageRequest,
  UpdateProjectRequest,
} from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AuthService } from '../auth';
import { createMainLogger } from '../logger';
import { AttachmentStore } from './AttachmentStore';
import { IMAGE_BYTE_CAP, isImageMediaType } from './attachments';
import { ArtifactPublisher } from './artifacts/ArtifactPublisher';
import { registerArtifactProtocol } from './artifacts/sandboxProtocol';
import { ChatService } from './ChatService';
import { MediaStore } from './media/MediaStore';
import { registerMediaProtocol } from './media/protocol';
import { ModelCatalog } from './ModelCatalog';
import { SessionActivity } from './SessionActivity';
import { SessionStore } from './SessionStore';
import { currentBranch, isGitRepository, listBranches, projectDisplayName } from './project/git';
import { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';
import { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';

const VERBOSE = process.env.B4M_DESKTOP_VERBOSE === '1';

/**
 * The model a new conversation prefers, matching the CLI's default so the two clients agree
 * about what "the default" means for one account.
 *
 * A PREFERENCE, not a list: the real set comes from the server (see ModelCatalog), and a
 * deployment that does not offer this one gets the first model it does offer instead. It is
 * still the fallback for a session file written before the catalog could be read.
 */
const PREFERRED_MODEL: string = ChatModels.CLAUDE_4_5_SONNET;

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
}

/** The OS folder picker, parented to the window that asked when there is one. */
async function pickDirectory(sender: WebContents): Promise<string | null> {
  const window = BrowserWindow.fromWebContents(sender);
  const properties: ('openDirectory' | 'createDirectory')[] = ['openDirectory', 'createDirectory'];
  const picked = await (window ? dialog.showOpenDialog(window, { properties }) : dialog.showOpenDialog({ properties }));
  return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0];
}

export function registerChat(auth: AuthService): RegisteredChat {
  const logger = createMainLogger(VERBOSE);
  const userData = app.getPath('userData');
  const store = new SessionStore(join(userData, 'sessions'), PREFERRED_MODEL);
  const access = new AccessStore(join(userData, 'tool-access.json'));
  const attachments = new AttachmentStore(join(userData, 'attachments'), logger, shrinkImage);
  const media = new MediaStore(join(userData, 'media'));
  registerMediaProtocol(media);
  registerArtifactProtocol();
  const artifacts = new ArtifactPublisher(() => auth.getApiClient(), logger);
  const models = new ModelCatalog({
    logger,
    getApiClient: () => auth.getApiClient(),
    getEnvironmentUrl: () => auth.getState().environment.url,
  });

  const send = (channel: string, payload: unknown) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(channel, payload);
    }
  };

  const broadcast = (event: ChatStreamEvent) => send(IPC_CHANNELS.chatStreamEvent, event);

  // Declared before the two things that feed it, because both take it as a constructor
  // argument: the gate reports who is waiting on the user, the service reports who is
  // replying, and this turns the pair into the one status a sidebar row draws.
  const activity = new SessionActivity((event: ChatSessionStatusEvent) => send(IPC_CHANNELS.chatSessionStatus, event));

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

  const service = new ChatService({
    store,
    access,
    attachments,
    models,
    logger,
    preferredModel: PREFERRED_MODEL,
    approvals,
    background,
    media,
    activity,
    artifacts,
    // userData holds the auth vault. Without this a user who shares their home folder would be
    // one `cat` away from the access token, which is T4's invariant broken through a side door.
    protectedPaths: [userData],
    getApiClient: () => auth.getApiClient(),
    getEnvironmentUrl: () => auth.getState().environment.url,
    emit: broadcast,
  });

  ipcMain.handle(IPC_CHANNELS.chatListModels, (_event, force: boolean) => service.listModels(force));
  ipcMain.handle(IPC_CHANNELS.chatSetSessionModel, (_event, sessionId: string, model: string) =>
    service.setSessionModel(sessionId, model)
  );
  ipcMain.handle(IPC_CHANNELS.chatSetSessionPinned, (_event, sessionId: string, pinned: boolean) =>
    service.setSessionPinned(sessionId, pinned)
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
      return { directory: resolved, name: basename(resolved), isRepository: false, branches: [], currentBranch: null };
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
  ipcMain.handle(IPC_CHANNELS.chatRespondToApproval, (_event, approvalId: string, decision: ChatApprovalDecision) =>
    approvals.resolve(approvalId, decision)
  );

  // The picker runs in main because that is where Electron's dialog lives, and it is the one
  // entry path that can name a file the renderer never saw.
  ipcMain.handle(IPC_CHANNELS.chatPickAttachments, async (event, sessionId: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const properties: ('openFile' | 'multiSelections')[] = ['openFile', 'multiSelections'];
    const picked = await (window
      ? dialog.showOpenDialog(window, { properties })
      : dialog.showOpenDialog({ properties }));
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

  ipcMain.handle(IPC_CHANNELS.chatListBackground, (_event, sessionId: string) => background.list(sessionId));
  ipcMain.handle(IPC_CHANNELS.chatReadBackground, (_event, sessionId: string, processId: string) =>
    background.tail(processId, sessionId, PANEL_TAIL_CHARS)
  );
  ipcMain.handle(IPC_CHANNELS.chatStopBackground, (_event, sessionId: string, processId: string) =>
    background.kill(processId, sessionId).then(() => undefined)
  );

  ipcMain.handle(IPC_CHANNELS.toolsGetAccess, async () => ({ roots: await access.list() }));
  // The picker is the ONLY way a root is added. Keeping the grant behind an OS dialog the user
  // drives is what stops a crafted prompt from widening the tools' reach on its own.
  ipcMain.handle(IPC_CHANNELS.toolsGrantAccess, async event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const picked = await (window
      ? dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      : dialog.showOpenDialog({ properties: ['openDirectory'] }));
    if (picked.canceled || picked.filePaths.length === 0) return { roots: await access.list() };
    return { roots: await access.grant(picked.filePaths[0]) };
  });
  ipcMain.handle(IPC_CHANNELS.toolsRevokeAccess, async (_event, root: string) => ({
    roots: await access.revoke(root),
  }));

  return { service, background };
}

export { ChatService } from './ChatService';
export { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';
