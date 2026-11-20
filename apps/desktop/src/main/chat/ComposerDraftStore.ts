import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  COMPOSER_DRAFT_MAX_AGE_MS,
  COMPOSER_DRAFT_MAX_LENGTH,
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
 * The renderer debounces keystrokes before they reach `set`, so each call is one write. The file is
 * bounded three ways: a deleted conversation's draft goes with it (ChatService.deleteSession), a
 * draft untouched for COMPOSER_DRAFT_MAX_AGE_MS is dropped on load, and past
 * COMPOSER_DRAFTS_TOTAL_MAX_LENGTH the least recently edited drafts are dropped first.
 */
export class ComposerDraftStore {
  private entries = new Map<string, Entry>();
  // Until the file is read, memory is empty rather than current: a quit then must not write it.
  private loaded = false;
  // Serialised so a burst of saves lands in order and never interleaves two renames.
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now
  ) {}

  async load(): Promise<ComposerDrafts> {
    let stored: unknown;
    try {
      stored = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch {
      // Missing or unreadable: no drafts, as on a first launch.
      stored = undefined;
    }
    const parsed = storedSchema.safeParse(stored);
    const oldest = this.now() - COMPOSER_DRAFT_MAX_AGE_MS;
    this.entries = new Map(
      parsed.success
        ? Object.entries(parsed.data.drafts).filter(
            ([, entry]) =>
              entry.updatedAt >= oldest && isKeptDraft(entry.text) && entry.text.length <= COMPOSER_DRAFT_MAX_LENGTH
          )
        : []
    );
    this.loaded = true;
    this.enforceTotalLimit();
    // Written back only when something expired or was over a limit, so a plain launch never writes.
    if (parsed.success && this.entries.size !== Object.keys(parsed.data.drafts).length) void this.persist();
    return this.all();
  }

  all(): ComposerDrafts {
    return Object.fromEntries([...this.entries].map(([sessionId, entry]) => [sessionId, entry.text]));
  }

  /** Blank text clears the draft. Text over COMPOSER_DRAFT_MAX_LENGTH clears it too: see the constant. */
  set(sessionId: string, text: string): Promise<void> {
    const keep = isKeptDraft(text) && text.length <= COMPOSER_DRAFT_MAX_LENGTH;
    if (!keep) return this.forget(sessionId);
    if (this.entries.get(sessionId)?.text === text) return this.writes;
    this.entries.set(sessionId, { text, updatedAt: this.now() });
    this.enforceTotalLimit();
    return this.persist();
  }

  forget(sessionId: string): Promise<void> {
    if (!this.entries.delete(sessionId)) return this.writes;
    return this.persist();
  }

  /** For `will-quit`, which cannot await: writes what is in memory now, synchronously. */
  flushSync(): void {
    if (!this.loaded) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const temporary = this.temporaryPath();
      writeFileSync(temporary, this.serialize(), { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, this.filePath);
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
      total -= entry.text.length;
    }
  }

  private persist(): Promise<void> {
    const snapshot = this.serialize();
    this.writes = this.writes
      .then(() => this.write(snapshot))
      .catch((error: unknown) => {
        console.warn(`DRAFTS: could not save composer drafts: ${String(error)}`);
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
