import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ChatMessage, ChatSession, ChatSessionSummary } from '@shared/chat';

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
   */
  async create(model?: string): Promise<ChatSessionSummary> {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: randomUUID(),
      title: UNTITLED,
      model: model || this.defaultModel,
      createdAt: now,
      updatedAt: now,
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
    return {
      id: parsed.id ?? id,
      title: parsed.title || UNTITLED,
      model: parsed.model || this.defaultModel,
      createdAt: parsed.createdAt ?? now,
      updatedAt: parsed.updatedAt ?? parsed.createdAt ?? now,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
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
