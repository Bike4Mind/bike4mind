import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  COMPOSER_DRAFT_MAX_AGE_MS,
  COMPOSER_DRAFT_MAX_LENGTH,
  COMPOSER_DRAFT_SAVE_DELAY_MS,
  COMPOSER_DRAFT_SAVE_MAX_WAIT_MS,
  COMPOSER_DRAFTS_TOTAL_MAX_LENGTH,
  isKeptDraft,
  type ComposerDrafts,
} from '@shared/composerDrafts';

const storedSchema = z.object({
  drafts: z.record(z.string(), z.object({ text: z.string(), updatedAt: z.number() })),
});

type Entry = { text: string; updatedAt: number };

/**
 * Unsent composer text per conversation (composer-drafts.json), written the way
 * WatchPreferencesStore writes its file: atomically, owner-only, served from memory after `load`.
 *
 * The renderer sends every keystroke to `set`, so memory is always current; the file write waits for
 * a pause in typing (`saveDelayMs`), or `saveMaxWaitMs` into typing that never pauses, and `flushSync` at quit writes whatever is still waiting. The
 * file is bounded three ways: a deleted conversation's draft goes with it (ChatService.deleteSession), a
 * draft untouched for COMPOSER_DRAFT_MAX_AGE_MS is dropped on load, and past
 * COMPOSER_DRAFTS_TOTAL_MAX_LENGTH the least recently edited drafts are dropped first.
 */
export class ComposerDraftStore {
  private entries = new Map<string, Entry>();
  // Until the file is read, memory is empty rather than current: a quit then must not write it.
  private loaded = false;
  // True while memory differs from the file, so a quit with no edits leaves the file untouched.
  private dirty = false;
  // Async writes started but not yet renamed into place: a quit during one must still write.
  private inFlight = 0;
  // Serialised so a burst of saves lands in order and never interleaves two renames.
  private writes: Promise<void> = Promise.resolve();
  private pendingSave: ReturnType<typeof setTimeout> | undefined;
  // Started by the first unsaved change and never pushed back, unlike `pendingSave`.
  private maxWaitSave: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
    private readonly saveDelayMs: number = COMPOSER_DRAFT_SAVE_DELAY_MS,
    private readonly saveMaxWaitMs: number = COMPOSER_DRAFT_SAVE_MAX_WAIT_MS
  ) {}

  async load(): Promise<ComposerDrafts> {
    let stored: unknown;
    try {
      stored = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        this.entries = new Map();
        this.loaded = true;
        return {};
      }
      // Left unloaded so nothing overwrites a file that exists but could not be read.
      console.warn(`DRAFTS: could not read composer drafts, leaving the file alone: ${String(error)}`);
      this.entries = new Map();
      return {};
    }
    const parsed = storedSchema.safeParse(stored);
    if (!parsed.success) {
      console.warn('DRAFTS: composer drafts file has an unexpected shape, leaving it alone');
      this.entries = new Map();
      return {};
    }
    const oldest = this.now() - COMPOSER_DRAFT_MAX_AGE_MS;
    this.entries = new Map(
      Object.entries(parsed.data.drafts).filter(
        ([, entry]) =>
          entry.updatedAt >= oldest && isKeptDraft(entry.text) && entry.text.length <= COMPOSER_DRAFT_MAX_LENGTH
      )
    );
    this.loaded = true;
    if (this.entries.size !== Object.keys(parsed.data.drafts).length) this.dirty = true;
    this.enforceTotalLimit();
    // Written back only when something expired or was over a limit, so a plain launch never writes.
    if (this.dirty) void this.persist();
    return this.all();
  }

  all(): ComposerDrafts {
    return Object.fromEntries([...this.entries].map(([sessionId, entry]) => [sessionId, entry.text]));
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /**
   * Blank text clears the draft. Text over COMPOSER_DRAFT_MAX_LENGTH clears it too: see the constant.
   * A kept draft is in memory at once and on disk after `saveDelayMs` without another `set`.
   */
  set(sessionId: string, text: string): Promise<void> {
    const keep = isKeptDraft(text) && text.length <= COMPOSER_DRAFT_MAX_LENGTH;
    if (!keep) return this.forget(sessionId);
    if (this.entries.get(sessionId)?.text === text) return this.writes;
    this.entries.set(sessionId, { text, updatedAt: this.now() });
    this.dirty = true;
    this.enforceTotalLimit();
    this.scheduleSave();
    return this.writes;
  }

  /** Clearing is written at once, so a sent message's text cannot come back. */
  forget(sessionId: string): Promise<void> {
    if (!this.entries.delete(sessionId)) return this.writes;
    this.dirty = true;
    return this.persist();
  }

  /** Writes a save that is waiting on the typing pause now. */
  flush(): Promise<void> {
    return this.pendingSave === undefined ? this.writes : this.persist();
  }

  /** For `will-quit`, which cannot await: writes what is in memory now, synchronously. */
  flushSync(): void {
    this.cancelPendingSave();
    if (!this.loaded || (!this.dirty && this.inFlight === 0)) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const temporary = this.temporaryPath();
      writeFileSync(temporary, this.serialize(), { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, this.filePath);
      this.dirty = false;
    } catch (error) {
      console.warn(`DRAFTS: could not save composer drafts at quit: ${String(error)}`);
    }
  }

  private enforceTotalLimit(): void {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.text.length;
    if (total <= COMPOSER_DRAFTS_TOTAL_MAX_LENGTH) return;
    const byAge = [...this.entries].sort(([, a], [, b]) => a.updatedAt - b.updatedAt);
    for (const [sessionId, entry] of byAge) {
      if (total <= COMPOSER_DRAFTS_TOTAL_MAX_LENGTH) break;
      this.entries.delete(sessionId);
      this.dirty = true;
      total -= entry.text.length;
    }
  }

  private scheduleSave(): void {
    if (this.pendingSave !== undefined) clearTimeout(this.pendingSave);
    this.pendingSave = setTimeout(() => void this.persist(), this.saveDelayMs);
    this.maxWaitSave ??= setTimeout(() => void this.persist(), this.saveMaxWaitMs);
  }

  private cancelPendingSave(): void {
    if (this.pendingSave !== undefined) clearTimeout(this.pendingSave);
    if (this.maxWaitSave !== undefined) clearTimeout(this.maxWaitSave);
    this.pendingSave = undefined;
    this.maxWaitSave = undefined;
  }

  private persist(): Promise<void> {
    this.cancelPendingSave();
    if (!this.loaded) return this.writes;
    this.dirty = false;
    this.inFlight += 1;
    const snapshot = this.serialize();
    this.writes = this.writes
      .then(() => this.write(snapshot))
      .catch((error: unknown) => {
        console.warn(`DRAFTS: could not save composer drafts: ${String(error)}`);
      })
      .finally(() => {
        this.inFlight -= 1;
      });
    return this.writes;
  }

  private serialize(): string {
    return JSON.stringify({ drafts: Object.fromEntries(this.entries) });
  }

  private temporaryPath(): string {
    return `${this.filePath}.${randomUUID()}.tmp`;
  }

  private async write(contents: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = this.temporaryPath();
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
