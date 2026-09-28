import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import type { ChatMessage, ChatProject, ChatSession, ChatSessionSummary } from '@shared/chat';

/** Session ids are generated here, but arrive back from the renderer over IPC - see `filePath`. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const UNTITLED = 'New chat';

/** Long enough to tell two threads apart in the sidebar, short enough not to wrap. */
const TITLE_MAX_LENGTH = 60;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

/**
 * Derive a session title from its first user message, the way the sidebar wants to read:
 * one line, trimmed, ellipsized. Falls back to the placeholder for an empty or blank prompt.
 */
export function deriveTitle(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  if (!oneLine) return UNTITLED;
  if (oneLine.length <= TITLE_MAX_LENGTH) return oneLine;
  return `${oneLine.slice(0, TITLE_MAX_LENGTH - 3).trimEnd()}...`;
}

function summarize(session: ChatSession): ChatSessionSummary {
  const { messages, ...summary } = session;
  return { ...summary, messageCount: messages.length };
}

/**
 * A stored project binding, or null when it is not one the tools could be pointed at.
 *
 * `workingDirectory` and `directory` are both required because they are what the tools root
 * themselves at; a partial binding is dropped and the session reads back as Chat, which is the
 * safe direction - it loses the grouping, not the conversation.
 */
function normalizeProject(value: unknown): ChatProject | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<ChatProject>;
  if (typeof raw.directory !== 'string' || !raw.directory) return null;
  if (typeof raw.workingDirectory !== 'string' || !raw.workingDirectory) return null;
  return {
    directory: raw.directory,
    name: typeof raw.name === 'string' && raw.name ? raw.name : basename(raw.directory),
    branch: typeof raw.branch === 'string' ? raw.branch : '',
    workspace: raw.workspace === true,
    workingDirectory: raw.workingDirectory,
    contextDirectories: Array.isArray(raw.contextDirectories)
      ? raw.contextDirectories.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
}

/**
 * Conversations as one JSON file per session, mirroring the CLI's `~/.bike4mind/sessions`.
 *
 * Local because the completion endpoint this client uses is stateless; see @shared/chat.
 */
export class SessionStore {
  constructor(
    private readonly baseDirectory: string,
    private readonly defaultModel: string
  ) {}

  /**
   * A session id becomes a filesystem path component here, so it is validated at the sink
   * rather than only where it enters: ids round-trip through the renderer, and a caller
   * reaching this with `../auth-vault` would otherwise escape the sessions directory.
   */
  private filePath(id: string): string {
    if (!isValidSessionId(id)) throw new Error(`invalid session id: ${id}`);
    return join(this.baseDirectory, `${id}.json`);
  }

  /**
   * `model` is what the caller resolved against the server's catalog; omitting it falls back to
   * the build's preferred model, which is the right answer only until that catalog is readable.
   *
   * `project` makes it a Code session. It is fixed here rather than settable later, because the
   * working directory it names is what the tools have been running in.
   */
  async create(model?: string, project?: ChatProject): Promise<ChatSessionSummary> {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: randomUUID(),
      // Left untitled even for a Code session: the project name is already the group header it
      // sits under, so the row itself is still best named after the first thing asked.
      title: UNTITLED,
      model: model || this.defaultModel,
      createdAt: now,
      updatedAt: now,
      mode: project ? 'code' : 'chat',
      ...(project ? { project } : {}),
      messages: [],
    };
    await this.write(session);
    return summarize(session);
  }

  async get(id: string): Promise<ChatSession | null> {
    let contents: string;
    try {
      contents = await readFile(this.filePath(id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return this.parse(contents, id);
  }

  /** Newest first. A file that no longer parses is skipped, not fatal - one bad file must not hide the rest. */
  async list(): Promise<ChatSessionSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.baseDirectory);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const sessions = await Promise.all(
      entries
        .filter(name => name.endsWith('.json'))
        .map(async name => {
          try {
            return await this.get(name.slice(0, -'.json'.length));
          } catch {
            return null;
          }
        })
    );

    return sessions
      .filter((session): session is ChatSession => session !== null)
      .map(summarize)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async rename(id: string, title: string): Promise<ChatSessionSummary | null> {
    const session = await this.get(id);
    if (!session) return null;
    session.title = deriveTitle(title);
    session.updatedAt = new Date().toISOString();
    await this.write(session);
    return summarize(session);
  }

  /**
   * Pin a conversation to a model. Stored per session rather than as one app-wide setting so
   * reopening a thread resumes the model it was held on - switching model for a new question
   * must not silently rewrite what an old conversation was answered with.
   */
  async setModel(id: string, model: string): Promise<ChatSessionSummary | null> {
    const session = await this.get(id);
    if (!session) return null;
    if (session.model === model) return summarize(session);
    session.model = model;
    session.updatedAt = new Date().toISOString();
    await this.write(session);
    return summarize(session);
  }

  /**
   * Remember the b4m notebook this conversation's generations are filed under. Written once,
   * on the first generation; see `remoteSessionId` in @shared/chat for why it exists at all.
   *
   * Leaves `updatedAt` alone: this is bookkeeping about a turn, not a turn, and bumping it
   * would reorder the sidebar behind the user's back.
   */
  async setRemoteSessionId(id: string, remoteSessionId: string): Promise<void> {
    const session = await this.get(id);
    if (!session || session.remoteSessionId === remoteSessionId) return;
    session.remoteSessionId = remoteSessionId;
    await this.write(session);
  }

  /**
   * Pin or unpin a conversation.
   *
   * Leaves `updatedAt` alone: pinning is about where a row sits, and bumping the timestamp
   * would also reorder it within its section, which is not what the user asked for.
   */
  async setPinned(id: string, pinned: boolean): Promise<ChatSessionSummary | null> {
    const session = await this.get(id);
    if (!session) return null;
    if (pinned) session.pinned = true;
    else delete session.pinned;
    await this.write(session);
    return summarize(session);
  }

  /** Grant one more folder to a Code session alone. No-op for a Chat session, which has no project. */
  async addContextDirectory(id: string, directory: string): Promise<ChatSessionSummary | null> {
    const session = await this.get(id);
    if (!session?.project) return null;
    if (!session.project.contextDirectories.includes(directory)) {
      session.project.contextDirectories.push(directory);
      await this.write(session);
    }
    return summarize(session);
  }

  async removeContextDirectory(id: string, directory: string): Promise<ChatSessionSummary | null> {
    const session = await this.get(id);
    if (!session?.project) return null;
    session.project.contextDirectories = session.project.contextDirectories.filter(entry => entry !== directory);
    await this.write(session);
    return summarize(session);
  }

  /**
   * Forget the conversation. Deliberately does NOT touch the project directory or its worktree:
   * a worktree can hold uncommitted work, and deleting a chat must never be a way to lose code.
   * Removing one stays a git operation the user performs themselves (`rmworktree <branch>`).
   */
  async delete(id: string): Promise<void> {
    await rm(this.filePath(id), { force: true });
  }

  /**
   * Append a message, titling the session from the first user prompt so the sidebar stops
   * saying "New chat" as soon as there is something to call it.
   */
  async appendMessage(id: string, message: ChatMessage): Promise<ChatSession | null> {
    const session = await this.get(id);
    if (!session) return null;

    const isFirstPrompt = message.role === 'user' && !session.messages.some(m => m.role === 'user');
    // A turn can be an attachment with no words ("look at this" is the screenshot), so the
    // filenames are the only thing left to name the conversation after.
    if (isFirstPrompt && session.title === UNTITLED) {
      const attachmentNames = (message.attachments ?? []).map(attachment => attachment.name).join(', ');
      session.title = deriveTitle(message.content || attachmentNames);
    }

    session.messages.push(message);
    session.updatedAt = new Date().toISOString();
    await this.write(session);
    return session;
  }

  /** Replace an already-appended message, for settling a streamed reply into its final text. */
  async updateMessage(id: string, messageId: string, changes: Partial<ChatMessage>): Promise<ChatSession | null> {
    const session = await this.get(id);
    if (!session) return null;

    const target = session.messages.find(m => m.id === messageId);
    if (!target) return session;

    Object.assign(target, changes);
    session.updatedAt = new Date().toISOString();
    await this.write(session);
    return session;
  }

  private parse(contents: string, id: string): ChatSession {
    const parsed = JSON.parse(contents) as Partial<ChatSession>;
    const now = new Date().toISOString();
    // Tolerant rather than schema-validated: these are this app's own files, and a field added
    // in a later version must not make an existing conversation unreadable.
    const project = normalizeProject(parsed.project);
    return {
      id: parsed.id ?? id,
      title: parsed.title || UNTITLED,
      model: parsed.model || this.defaultModel,
      createdAt: parsed.createdAt ?? now,
      updatedAt: parsed.updatedAt ?? parsed.createdAt ?? now,
      // Every session written before modes existed is a Chat session, which is why 'chat' is
      // the fallback and not merely the default for new ones. A file claiming 'code' without a
      // usable project is downgraded rather than trusted: a Code session with no working
      // directory would send its tools to whatever the first global grant happens to be.
      mode: parsed.mode === 'code' && project ? 'code' : 'chat',
      ...(parsed.mode === 'code' && project ? { project } : {}),
      ...(parsed.pinned ? { pinned: true } : {}),
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      ...(typeof parsed.remoteSessionId === 'string' ? { remoteSessionId: parsed.remoteSessionId } : {}),
    };
  }

  private async write(session: ChatSession): Promise<void> {
    const path = this.filePath(session.id);
    await mkdir(this.baseDirectory, { recursive: true });
    // Write-then-rename, as the auth vault does: a crash mid-write would otherwise truncate a
    // conversation into unparseable JSON and lose the whole thread rather than one turn.
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(session, null, 2), 'utf8');
    await rename(temporary, path);
  }
}
