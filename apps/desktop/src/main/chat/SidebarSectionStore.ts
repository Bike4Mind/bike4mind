import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  EMPTY_SIDEBAR_SECTIONS,
  normalizeSectionName,
  sectionOf,
  SIDEBAR_SECTIONS_MAX,
  type SidebarSectionsState,
} from '@shared/sidebarSections';

// Only the outer shape is all-or-nothing; each entry is validated on its own in sanitize.
const storedSchema = z.object({
  sections: z.array(z.unknown()),
  assignments: z.record(z.string(), z.unknown()),
});

const sectionSchema = z.object({ id: z.string().min(1), name: z.string() });

/**
 * Drops hand-edit damage (a malformed entry, a blank name, a repeated id, an assignment to a gone
 * section) one entry at a time, so one bad entry does not cost the user every other section.
 */
function sanitize(stored: z.infer<typeof storedSchema>): SidebarSectionsState {
  const seen = new Set<string>();
  const sections = stored.sections.flatMap(entry => {
    const parsed = sectionSchema.safeParse(entry);
    if (!parsed.success) return [];
    const name = normalizeSectionName(parsed.data.name);
    if (!name || seen.has(parsed.data.id)) return [];
    seen.add(parsed.data.id);
    return [{ id: parsed.data.id, name }];
  });
  const assignments: Record<string, string> = {};
  for (const [sessionId, sectionId] of Object.entries(stored.assignments)) {
    if (typeof sectionId === 'string' && seen.has(sectionId)) assignments[sessionId] = sectionId;
  }
  return { sections, assignments };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Sections and assignments in userData, app-wide like approval-mode.json rather than per account,
 * so a second account on this machine sees the first one's section names.
 *
 * A missing file reads as empty. A file that cannot be parsed also reads as empty, but is moved aside
 * to `<file>.corrupt-<ms>` before the first write, so a bad hand edit never overwrites the user's
 * sections; if it cannot be moved, the write fails instead. Any other read error (EACCES, a Windows
 * lock) is not cached: the read and any change fail, and the next call tries the file again.
 */
export class SidebarSectionStore {
  private state: SidebarSectionsState | null = null;
  private loading: Promise<SidebarSectionsState> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private keepAside = false;

  constructor(
    private readonly filePath: string,
    private readonly newId: () => string = randomUUID
  ) {}

  read(): Promise<SidebarSectionsState> {
    if (this.state) return Promise.resolve(this.state);
    // One shared load, so a first read racing an update cannot restore state the update replaced.
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<SidebarSectionsState> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (!isMissingFile(error)) {
        this.loading = null;
        throw error;
      }
      this.state ??= EMPTY_SIDEBAR_SECTIONS;
      return this.state;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    const parsed = storedSchema.safeParse(raw);
    if (!parsed.success) this.keepAside = true;
    this.state ??= parsed.success ? sanitize(parsed.data) : EMPTY_SIDEBAR_SECTIONS;
    return this.state;
  }

  /** Makes a section at the end of the list and, when given a session, moves it in. */
  create(name: string, sessionId?: string): Promise<SidebarSectionsState> {
    return this.update(state => {
      const normalized = normalizeSectionName(name);
      if (!normalized || state.sections.length >= SIDEBAR_SECTIONS_MAX) return state;
      const id = this.newId();
      return {
        sections: [...state.sections, { id, name: normalized }],
        assignments: sessionId ? { ...state.assignments, [sessionId]: id } : state.assignments,
      };
    });
  }

  rename(sectionId: string, name: string): Promise<SidebarSectionsState> {
    return this.update(state => {
      const normalized = normalizeSectionName(name);
      if (!normalized || !state.sections.some(section => section.id === sectionId)) return state;
      return {
        ...state,
        sections: state.sections.map(section =>
          section.id === sectionId ? { ...section, name: normalized } : section
        ),
      };
    });
  }

  /** Deletes the section only: its sessions go back to the default groups, untouched. */
  remove(sectionId: string): Promise<SidebarSectionsState> {
    return this.update(state => {
      if (!state.sections.some(section => section.id === sectionId)) return state;
      return {
        sections: state.sections.filter(section => section.id !== sectionId),
        assignments: Object.fromEntries(
          Object.entries(state.assignments).filter(([, assigned]) => assigned !== sectionId)
        ),
      };
    });
  }

  /** Null takes the session out of whatever section it is in. */
  move(sessionId: string, sectionId: string | null): Promise<SidebarSectionsState> {
    return this.update(state => {
      if (sectionId === null) return withoutSession(state, sessionId);
      if (!state.sections.some(section => section.id === sectionId)) return state;
      if (sectionOf(state, sessionId) === sectionId) return state;
      return { ...state, assignments: { ...state.assignments, [sessionId]: sectionId } };
    });
  }

  /** Called when a session is deleted, so the file does not collect ids that will never come back. */
  forgetSession(sessionId: string): Promise<SidebarSectionsState> {
    return this.update(state => withoutSession(state, sessionId));
  }

  private update(change: (state: SidebarSectionsState) => SidebarSectionsState): Promise<SidebarSectionsState> {
    const next = this.queue.then(async () => {
      const current = await this.read();
      const changed = change(current);
      if (changed === current) return current;
      await this.persist(changed);
      this.state = changed;
      return changed;
    });
    // The queue only orders changes; a failed write is the caller's to see, not the next one's.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async persist(state: SidebarSectionsState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    if (this.keepAside) {
      try {
        await rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
      this.keepAside = false;
    }
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

function withoutSession(state: SidebarSectionsState, sessionId: string): SidebarSectionsState {
  if (!Object.hasOwn(state.assignments, sessionId)) return state;
  const { [sessionId]: _removed, ...assignments } = state.assignments;
  return { ...state, assignments };
}
