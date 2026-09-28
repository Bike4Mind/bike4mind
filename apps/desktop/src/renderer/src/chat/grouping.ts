import type { ChatSessionMode, ChatSessionSummary } from '@shared/chat';

export interface ProjectGroup {
  /** The project directory, which is the grouping identity - two projects can share a name. */
  directory: string;
  name: string;
  sessions: ChatSessionSummary[];
}

export interface SidebarSections {
  pinned: ChatSessionSummary[];
  /** Code sessions, one group per project directory. */
  projects: ProjectGroup[];
  /** Chat sessions, which have no project and sit outside the groups. */
  loose: ChatSessionSummary[];
  /**
   * Archived conversations, in one collapsed section at the bottom regardless of project.
   *
   * Out of everything above rather than greyed out inside it: archiving is how a project group
   * that has accumulated twenty finished sessions becomes readable again, which it does not if
   * the rows are still there.
   */
  archived: ChatSessionSummary[];
}

/**
 * Split the session list into what the sidebar draws.
 *
 * A pinned session appears ONLY in the pinned section, not a second time inside its project
 * group: two rows for one conversation, one of which silently mirrors the other, reads as a
 * duplicate rather than as emphasis.
 *
 * Group order follows the most recently updated session in each group, so the project being
 * worked on now rises to the top - the same rule the flat list already used for rows.
 */
export function groupSessions(sessions: readonly ChatSessionSummary[], mode: ChatSessionMode): SidebarSections {
  const inMode = sessions.filter(session => session.mode === mode);
  // Archiving outranks pinning: a pinned session that is then archived has been put away, and
  // leaving it at the top would make archive the one action with no visible effect.
  const archived = inMode.filter(session => session.archived);
  const visible = inMode.filter(session => !session.archived);
  const pinned = visible.filter(session => session.pinned);
  const rest = visible.filter(session => !session.pinned);

  const byDirectory = new Map<string, ProjectGroup>();
  const loose: ChatSessionSummary[] = [];

  for (const session of rest) {
    const project = session.project;
    if (!project) {
      loose.push(session);
      continue;
    }
    const group = byDirectory.get(project.directory);
    if (group) group.sessions.push(session);
    else byDirectory.set(project.directory, { directory: project.directory, name: project.name, sessions: [session] });
  }

  return { pinned, projects: [...byDirectory.values()], loose, archived };
}

/** How many rows the modifier-plus-digit shortcut reaches. */
export const QUICK_SWITCH_LIMIT = 9;

/**
 * Every row the sidebar draws, in the order it draws them.
 *
 * The quick-switch shortcut counts positions in THIS list, so it has to come from the same
 * order the eye reads rather than from any one section.
 */
export function orderedSessions(sections: SidebarSections): ChatSessionSummary[] {
  // Archived rows are left out: the shortcut counts what the sidebar draws, and those sit
  // behind a disclosure that is shut by default.
  return [...sections.pinned, ...sections.projects.flatMap(group => group.sessions), ...sections.loose];
}
