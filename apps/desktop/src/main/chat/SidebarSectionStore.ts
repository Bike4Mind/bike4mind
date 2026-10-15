import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { EMPTY_SIDEBAR_SECTIONS, normalizeSectionName, type SidebarSectionsState } from '@shared/sidebarSections';

const storedSchema = z.object({
  sections: z.array(z.object({ id: z.string().min(1), name: z.string() })),
  assignments: z.record(z.string(), z.string()),
});

/**
 * What a file that parsed can still get wrong by hand edit: a blank name, a repeated id, or an
 * assignment pointing at a section that is gone. Each is dropped rather than failing the whole
 * read, so one bad entry does not cost the user every other section.
 */
function sanitize(stored: z.infer<typeof storedSchema>): SidebarSectionsState {
  const seen = new Set<string>();
  const sections = stored.sections.flatMap(section => {
    const name = normalizeSectionName(section.name);
    if (!name || seen.has(section.id)) return [];
    seen.add(section.id);
    return [{ id: section.id, name }];
  });
  const assignments = Object.fromEntries(
    Object.entries(stored.assignments).filter(([, sectionId]) => seen.has(sectionId))
  );
  return { sections, assignments };
}

/**
 * The user's sidebar sections and which session sits in each, in userData beside the other
 * app-wide preferences.
 *
 * Not scoped to the backend or account the way sessions are: a section is how the user likes to
 * file their work, and session ids are UUIDs, so an assignment for a session from another scope
 * is simply never drawn. An unreadable file reads as no sections - never as an error the sidebar
 * has to handle - and the next change writes a clean one.
 *
 * Every change goes through one queue, so two clicks that land together cannot each read the
 * same state and have the second write erase the first.
 */
export class SidebarSectionStore {
  private state: SidebarSectionsState | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly newId: () => string = randomUUID
  ) {}

  async read(): Promise<SidebarSectionsState> {
    if (this.state) return this.state;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch {
      raw = undefined;
    }
    const parsed = storedSchema.safeParse(raw);
    this.state = parsed.success ? sanitize(parsed.data) : EMPTY_SIDEBAR_SECTIONS;
    return this.state;
  }

  /** Makes a section at the end of the list and, when given a session, moves it in. */
  create(name: string, sessionId?: string): Promise<SidebarSectionsState> {
    return this.update(state => {
      const normalized = normalizeSectionName(name);
      if (!normalized) return state;
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
      if (state.assignments[sessionId] === sectionId) return state;
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
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

function withoutSession(state: SidebarSectionsState, sessionId: string): SidebarSectionsState {
  if (!(sessionId in state.assignments)) return state;
  const { [sessionId]: _removed, ...assignments } = state.assignments;
  return { ...state, assignments };
}
