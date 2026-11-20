import { join } from 'node:path';
import type { IpcMain, SaveDialogOptions, WebContents } from 'electron';
import type { ChatSession, ChatSessionExportResult } from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';
import { isValidSessionId } from './SessionStore';
import { sanitizeFilename, sessionToJson, sessionToMarkdown } from './sessionExport';

export interface SessionExportDeps {
  sessions: { get(id: string): Promise<ChatSession | null> };
  /** The chosen path, or null when the user cancelled. */
  pickSavePath(sender: WebContents, options: SaveDialogOptions): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  downloadsDirectory(): string;
}

/** The format follows the extension the user ended up with in the save dialog. */
export function registerSessionExportIpc(ipc: Pick<IpcMain, 'handle'>, deps: SessionExportDeps): void {
  ipc.handle(IPC_CHANNELS.chatExportSession, async (event, sessionId: unknown): Promise<ChatSessionExportResult> => {
    if (typeof sessionId !== 'string' || !isValidSessionId(sessionId)) throw new Error('Not a notebook id.');
    const session = await deps.sessions.get(sessionId);
    if (!session) throw new Error('That notebook no longer exists.');
    const path = await deps.pickSavePath(event.sender, {
      defaultPath: join(deps.downloadsDirectory(), `${sanitizeFilename(session.title)}.md`),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'JSON', extensions: ['json'] },
      ],
    });
    if (!path) return { saved: false };
    const content = path.toLowerCase().endsWith('.json') ? sessionToJson(session) : sessionToMarkdown(session);
    await deps.writeFile(path, content);
    return { saved: true, path };
  });
}
