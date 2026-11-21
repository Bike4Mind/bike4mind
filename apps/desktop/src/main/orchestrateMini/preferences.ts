import { z } from 'zod';
import type { WindowBounds } from '../floatingWindow';
import { privateFile } from '../privateFile';

const boundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export type OrchestrateMiniPreferences = {
  /** Open when the app last quit, so it reopens; off until the user first turns it on. */
  open: boolean;
  bounds: WindowBounds | null;
};

export const DEFAULT_ORCHESTRATE_MINI_PREFERENCES: OrchestrateMiniPreferences = { open: false, bounds: null };

/** Field by field, so one bad value (a hand edit, an older file) does not reset the other. */
export function parseOrchestrateMiniPreferences(value: unknown): OrchestrateMiniPreferences {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const bounds = boundsSchema.safeParse(record.bounds);
  return {
    open: typeof record.open === 'boolean' ? record.open : DEFAULT_ORCHESTRATE_MINI_PREFERENCES.open,
    bounds: bounds.success ? bounds.data : null,
  };
}

/**
 * The Orchestrate mini window's bounds and visibility (orchestrate-mini.json). Reads are served from
 * memory after `load`, so the window can ask for its bounds synchronously while it is created.
 */
export class OrchestrateMiniPreferencesStore {
  private value = DEFAULT_ORCHESTRATE_MINI_PREFERENCES;
  // Serialised so a burst of bound saves lands in order and never interleaves two renames.
  private writes: Promise<void> = Promise.resolve();
  private readonly file;

  constructor(filePath: string) {
    this.file = privateFile(filePath);
  }

  async load(): Promise<OrchestrateMiniPreferences> {
    let stored: unknown;
    try {
      const contents = await this.file.read();
      stored = contents === null ? undefined : JSON.parse(contents);
    } catch (error) {
      console.warn(`ORCHESTRATE-MINI: could not read preferences, using defaults: ${String(error)}`);
    }
    this.value = parseOrchestrateMiniPreferences(stored);
    return this.value;
  }

  current(): OrchestrateMiniPreferences {
    return this.value;
  }

  update(patch: Partial<OrchestrateMiniPreferences>): Promise<void> {
    this.value = parseOrchestrateMiniPreferences({ ...this.value, ...patch });
    const contents = JSON.stringify(this.value, null, 2);
    this.writes = this.writes
      .then(() => this.file.write(contents))
      .catch((error: unknown) => {
        console.warn(`ORCHESTRATE-MINI: could not save preferences: ${String(error)}`);
      });
    return this.writes;
  }
}
