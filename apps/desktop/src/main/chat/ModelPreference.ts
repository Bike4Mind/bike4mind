import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The seam ChatService remembers through; see ModelPreference for the live implementation. */
export interface ModelMemory {
  read(): Promise<string | null>;
  record(model: string): Promise<void>;
}

/**
 * The model the user last chose in the picker, which a conversation started from now on prefers.
 *
 * The same shape as ApprovalModePreference, and for the same reason: the picker is the only
 * place a model is chosen, and a user who moves it is telling us about the next conversation
 * too. Only that path records - see ChatService.setSessionModel. A model swapped in because the
 * saved one is gone, or a spawned session inheriting its parent's, is the app choosing, not the
 * user.
 *
 * Never cleared because a deployment does not offer it. resolveDefaultModel skips it there, and
 * it applies again once the user is back on a server that does.
 *
 * One file for the app rather than one per backend: a pick another server lacks already falls
 * through, so a per-backend copy would only add a second pick to make on each server.
 */
export class ModelPreference implements ModelMemory {
  /** undefined until the file has been read once; null once read and nothing was there. */
  private model: string | null | undefined;

  constructor(private readonly filePath: string) {}

  async read(): Promise<string | null> {
    if (this.model !== undefined) return this.model;
    let stored: unknown;
    try {
      stored = (JSON.parse(await readFile(this.filePath, 'utf8')) as { model?: unknown }).model;
    } catch {
      stored = undefined;
    }
    this.model = typeof stored === 'string' && stored.trim() ? stored.trim() : null;
    return this.model;
  }

  async record(model: string): Promise<void> {
    const remembered = model.trim();
    if (!remembered) return;
    this.model = remembered;
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify({ model: remembered }, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
