import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ChatApprovalMode } from '@shared/chat';

/**
 * The mode a conversation started from now on begins in: the last one the user picked.
 *
 * Remembered rather than fixed, because the composer pill is the only place a mode is ever
 * chosen and a user who moves it is saying something about the conversations they are about to
 * start, not only the one in front of them. Nothing already on disk is touched - an existing
 * conversation keeps the mode it was given.
 *
 * 'auto' until they have picked anything, and 'auto' again whenever the file cannot be read.
 * That is the floor rather than a fallback: it is the mode the app now starts in, and every
 * call it lets through is one nothing in ChatService.autoApproves had a reason to stop.
 *
 * 'full' is never remembered. It is already scoped to the run of the app it was chosen in - see
 * SessionStore's `normalizeApprovalMode` - so a new conversation inheriting it would outlive
 * that choice, which is the same reason a spawned session does not inherit it either. A pick of
 * 'full' is therefore recorded as the mode that rule clamps it to.
 *
 * Not scoped to the backend or the account, unlike the conversations themselves: this records
 * how its one user likes to work, not anything belonging to a thread.
 */
export class ApprovalModePreference {
  private mode: ChatApprovalMode | null = null;

  constructor(private readonly filePath: string) {}

  async read(): Promise<ChatApprovalMode> {
    if (this.mode) return this.mode;
    let stored: unknown;
    try {
      stored = (JSON.parse(await readFile(this.filePath, 'utf8')) as { mode?: unknown }).mode;
    } catch {
      stored = undefined;
    }
    this.mode = stored === 'ask' ? 'ask' : 'auto';
    return this.mode;
  }

  /** Called from the one path a mode arrives on that the user chose; see SessionStore.setApprovalMode. */
  async record(mode: ChatApprovalMode): Promise<void> {
    const remembered: ChatApprovalMode = mode === 'full' ? 'auto' : mode;
    this.mode = remembered;
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify({ mode: remembered }, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
