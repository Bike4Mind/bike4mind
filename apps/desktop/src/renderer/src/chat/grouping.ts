import type { ChatProject, ChatSessionMode, ChatSessionSummary } from '@shared/chat';
import { claudeWorktreeOf } from '@shared/claudeImport';
import {
  EMPTY_SIDEBAR_SECTIONS,
  sectionOf,
  type SidebarSection,
  type SidebarSectionsState,
} from '@shared/sidebarSections';

export interface ProjectGroup {
  /** The project directory, which is the grouping identity - two projects can share a name. */
  directory: string;
  name: string;
  sessions: ChatSessionSummary[];
}

export interface CustomGroup {
  section: SidebarSection;
  sessions: ChatSessionSummary[];
}

export interface SidebarSections {
  pinned: ChatSessionSummary[];
  /**
   * Empty sections included, so they can still be renamed or deleted; one whose sessions are all
   * in the other mode is left out, so it does not show as empty here.
   */
  custom: CustomGroup[];
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
  /**
   * Imported from Claude and not yet continued here, when the user asked for them in their own
   * collapsed section rather than their project groups. Pinned, filed or archived ones go where
   * the user put them.
   */
  imported: ChatSessionSummary[];
}

/** A Claude import the user has not carried on with; a continued one is ordinary work. */
export function isUntouchedImport(session: Pick<ChatSessionSummary, 'importOrigin'>): boolean {
  return !!session.importOrigin && !session.importOrigin.forkedAt;
}

/**
 * Splits sessions into what the sidebar draws; each shows once, archived over pinned over a section.
 *
 * A pinned session is not repeated inside its group: two rows for one conversation reads as a
 * duplicate rather than emphasis. Groups are ordered by their most recently updated session, so
 * the project being worked on now rises to the top.
 */
export function groupSessions(
  sessions: readonly ChatSessionSummary[],
  mode: ChatSessionMode,
  userSections: SidebarSectionsState = EMPTY_SIDEBAR_SECTIONS,
  importedInline = false
): SidebarSections {
  const inMode = sessions.filter(session => session.mode === mode);
  // Archiving outranks pinning: a pinned session that is then archived has been put away, and
  // leaving it at the top would make archive the one action with no visible effect.
  const archived = inMode.filter(session => session.archived);
  const visible = inMode.filter(session => !session.archived);
  const pinned = visible.filter(session => session.pinned);
  const rest = visible.filter(session => !session.pinned);

  const modesBySection = new Map<string, Set<ChatSessionMode>>();
  for (const session of sessions) {
    const sectionId = sectionOf(userSections, session.id);
    if (sectionId === undefined) continue;
    const modes = modesBySection.get(sectionId) ?? new Set<ChatSessionMode>();
    modes.add(session.mode);
    modesBySection.set(sectionId, modes);
  }
  const custom = userSections.sections
    .filter(section => {
      const modes = modesBySection.get(section.id);
      return !modes || modes.has(mode);
    })
    .map(section => ({ section, sessions: [] as ChatSessionSummary[] }));
  const bySection = new Map(custom.map(group => [group.section.id, group]));
  const byDirectory = new Map<string, ProjectGroup>();
  const loose: ChatSessionSummary[] = [];
  const imported: ChatSessionSummary[] = [];

  for (const session of rest) {
    const sectionId = sectionOf(userSections, session.id);
    const sectionGroup = sectionId === undefined ? undefined : bySection.get(sectionId);
    if (sectionGroup) {
      sectionGroup.sessions.push(session);
      continue;
    }
    if (!importedInline && isUntouchedImport(session)) {
      imported.push(session);
      continue;
    }
    const project = session.project;
    if (!project) {
      loose.push(session);
      continue;
    }
    const { directory, name } = projectGroupOf(project);
    const group = byDirectory.get(directory);
    if (group) group.sessions.push(session);
    else byDirectory.set(directory, { directory, name, sessions: [session] });
  }

  return { pinned, custom, projects: [...byDirectory.values()], loose, archived, imported };
}

/** A project picked inside a Claude Code worktree belongs with its repository, not a group of its own. */
function projectGroupOf(project: ChatProject): { directory: string; name: string } {
  const repository = claudeWorktreeOf(project.directory)?.repository;
  if (!repository) return { directory: project.directory, name: project.name };
  return { directory: repository, name: repository.split(/[\\/]/).filter(Boolean).pop() ?? repository };
}

/** The most recent session's project for a sidebar group, including grouped Claude worktrees. */
export function projectForGroup(sessions: readonly ChatSessionSummary[], directory: string): ChatProject | undefined {
  return sessions.find(session => session.project && projectGroupOf(session.project).directory === directory)?.project;
}

/** How many rows the modifier-plus-digit shortcut reaches. */
export const QUICK_SWITCH_LIMIT = 9;

/**
 * Every row in the sidebar, in the order it draws them - including the ones a long group keeps
 * behind "Show more". Positions match the drawn order for each group's first GROUP_ROW_CAP rows
 * (groupCap.ts); a kept row past the cap draws out of order, which is why the shortcut reaches
 * no further than it.
 *
 * The quick-switch shortcut counts positions in THIS list, so it has to come from the same
 * order the eye reads rather than from any one section.
 */
export function orderedSessions(sections: SidebarSections): ChatSessionSummary[] {
  // Archived and imported rows are left out: the shortcut counts what the sidebar draws, and
  // those sit behind disclosures that are shut by default. SessionList appends the imported
  // rows while their section is open.
  return [
    ...sections.pinned,
    ...sections.custom.flatMap(group => group.sessions),
    ...sections.projects.flatMap(group => group.sessions),
    ...sections.loose,
  ];
}
