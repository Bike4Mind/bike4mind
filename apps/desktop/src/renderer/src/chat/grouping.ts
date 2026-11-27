import type { ChatProject, ChatSessionMode, ChatSessionSummary } from '@shared/chat';
import { claudeWorktreeOf } from '@shared/claudeImport';
import { LOCAL_HOST_ID } from '@shared/hostBridge';
import { summaryHostId } from '../host/sessionDirectory';
import {
  EMPTY_SIDEBAR_SECTIONS,
  sectionOf,
  type SidebarSection,
  type SidebarSectionsState,
} from '@shared/sidebarSections';

export interface ProjectGroup {
  /**
   * The host the project's folder is on. With the directory it is the grouping identity: two
   * hosts with the same path are two projects, and two projects can share a name.
   */
  hostId: string;
  directory: string;
  /** Unique across hosts; see projectGroupKey. */
  key: string;
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
  /** Code sessions, one group per (host, project directory). */
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
  /**
   * Spawned sessions drawn under the session that started them, keyed by that parent's id. Empty
   * when nesting is off. A session listed here appears in no other list above - only under its
   * parent, wherever that parent is drawn.
   */
  children: ReadonlyMap<string, ChatSessionSummary[]>;
}

const NO_CHILDREN: ReadonlyMap<string, ChatSessionSummary[]> = new Map();

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
  importedInline = false,
  nested = false,
  /** Lower first, ahead of activity within every group; omitted, the order is activity alone. */
  attentionRank?: (session: ChatSessionSummary) => number
): SidebarSections {
  const inMode = sessions.filter(session => session.mode === mode);
  // Archiving outranks pinning: a pinned session that is then archived has been put away, and
  // leaving it at the top would make archive the one action with no visible effect.
  const archived = inMode.filter(session => session.archived);
  const visible = inMode.filter(session => !session.archived);
  const children = nested ? nestSpawned(visible, userSections) : NO_CHILDREN;
  const attached = new Set([...children.values()].flat().map(session => session.id));
  const byGroupActivity = withRank(activityOrder(children), attentionRank);
  const pinned = visible.filter(session => session.pinned).sort(byGroupActivity);
  const rest = visible.filter(session => !session.pinned && !attached.has(session.id)).sort(byGroupActivity);

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
  const byProject = new Map<string, ProjectGroup>();
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
    const hostId = summaryHostId(session);
    const key = projectGroupKey(hostId, directory);
    const group = byProject.get(key);
    if (group) group.sessions.push(session);
    else byProject.set(key, { hostId, directory, key, name, sessions: [session] });
  }

  return { pinned, custom, projects: [...byProject.values()], loose, archived, imported, children };
}

/**
 * Which visible sessions hang under which. A child stays where the user put it when they put it
 * somewhere on purpose - pinned, or filed in a section of their own - and falls back to its own
 * row when its parent is archived, deleted or in the other mode, since there is nothing visible
 * to hang it under.
 */
function nestSpawned(
  visible: readonly ChatSessionSummary[],
  userSections: SidebarSectionsState
): Map<string, ChatSessionSummary[]> {
  const byId = new Map(visible.map(session => [session.id, session]));
  const parentOf = (session: ChatSessionSummary): ChatSessionSummary | undefined => {
    const parentId = session.origin?.parentSessionId;
    if (!parentId || session.pinned || sectionOf(userSections, session.id) !== undefined) return undefined;
    return byId.get(parentId);
  };
  // Origins are written once at spawn, so a cycle needs a corrupt file - but one would hide every
  // session in it, so it is checked for rather than assumed away.
  const cyclic = (session: ChatSessionSummary): boolean => {
    const seen = new Set([session.id]);
    for (let parent = parentOf(session); parent; parent = parentOf(parent)) {
      if (seen.has(parent.id)) return true;
      seen.add(parent.id);
    }
    return false;
  };

  const children = new Map<string, ChatSessionSummary[]>();
  for (const session of visible) {
    const parent = parentOf(session);
    if (!parent || cyclic(session)) continue;
    const siblings = children.get(parent.id);
    if (siblings) siblings.push(session);
    else children.set(parent.id, [session]);
  }
  // Creation order keeps a group's rows still while its members work; recency decides the group's place.
  for (const siblings of children.values()) siblings.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return children;
}

/** The latest updatedAt among a session and everything nested under it, at any depth. */
function groupActivity(
  children: ReadonlyMap<string, readonly ChatSessionSummary[]>,
  session: ChatSessionSummary
): string {
  return descendantsOf(children, session.id).reduce(
    (latest, child) => (child.updatedAt > latest ? child.updatedAt : latest),
    session.updatedAt
  );
}

/**
 * Newest group first, judged by its most recently active member rather than the parent alone, so a
 * busy child keeps its group near the top. Stable, and a no-op on a list with nothing nested.
 */
function activityOrder(children: ReadonlyMap<string, readonly ChatSessionSummary[]>) {
  if (children.size === 0) return () => 0;
  return (a: ChatSessionSummary, b: ChatSessionSummary): number =>
    groupActivity(children, b).localeCompare(groupActivity(children, a));
}

type SessionOrder = (a: ChatSessionSummary, b: ChatSessionSummary) => number;

/** `order`, untouched when there is no rank, so the default sidebar sorts exactly as before. */
function withRank(order: SessionOrder, rank?: (session: ChatSessionSummary) => number): SessionOrder {
  if (!rank) return order;
  return (a, b) => rank(a) - rank(b) || order(a, b);
}

/**
 * The title of the parent a spawned session is drawn away from, for its small "from X" label: its
 * parent is archived or in another mode, the user pinned or filed it, or a search flattened the
 * list. `all` is every session, not just the matching ones, so a hint survives a search that skips
 * the parent. A deleted parent has no title to show, so its child gets none.
 */
export function parentHints(
  all: readonly ChatSessionSummary[],
  children: ReadonlyMap<string, readonly ChatSessionSummary[]>
): ReadonlyMap<string, string> {
  const byId = new Map(all.map(session => [session.id, session]));
  const nestedIds = new Set([...children.values()].flat().map(session => session.id));

  const hints = new Map<string, string>();
  for (const session of all) {
    const parent = session.origin && byId.get(session.origin.parentSessionId);
    if (!parent || parent.id === session.id || nestedIds.has(session.id)) continue;
    hints.set(session.id, parent.title);
  }
  return hints;
}

/**
 * Every live session started from `sessionId`, at any depth, by origin rather than by sidebar
 * placement: deleting a parent offers these whether or not they are drawn under it.
 */
export function nestedSessionsOf(sessions: readonly ChatSessionSummary[], sessionId: string): ChatSessionSummary[] {
  const found: ChatSessionSummary[] = [];
  const seen = new Set([sessionId]);
  for (let frontier = [sessionId]; frontier.length > 0;) {
    const next = sessions.filter(
      session =>
        !seen.has(session.id) &&
        !session.archived &&
        session.origin !== undefined &&
        frontier.includes(session.origin.parentSessionId)
    );
    for (const session of next) seen.add(session.id);
    found.push(...next);
    frontier = next.map(session => session.id);
  }
  return found;
}

/** Every session nested under `sessionId`, at any depth, in drawn order. */
export function descendantsOf(
  children: ReadonlyMap<string, readonly ChatSessionSummary[]>,
  sessionId: string
): ChatSessionSummary[] {
  return (children.get(sessionId) ?? []).flatMap(child => [child, ...descendantsOf(children, child.id)]);
}

/** A project picked inside a Claude Code worktree belongs with its repository, not a group of its own. */
function projectGroupOf(project: ChatProject): { directory: string; name: string } {
  const repository = claudeWorktreeOf(project.directory)?.repository;
  if (!repository) return { directory: project.directory, name: project.name };
  return { directory: repository, name: repository.split(/[\\/]/).filter(Boolean).pop() ?? repository };
}

/** The sidebar group directory a project belongs to: its repository when picked inside a Claude Code worktree. */
export function projectGroupDirectory(project: ChatProject): string {
  return projectGroupOf(project).directory;
}

/**
 * A project group's identity. A local project keeps its bare directory, the key it had before
 * remote hosts, so state stored under it (folded groups) stays valid; a remote one is prefixed
 * with its host.
 */
export function projectGroupKey(hostId: string, directory: string): string {
  return hostId === LOCAL_HOST_ID ? directory : `${hostId}\n${directory}`;
}

/** The most recent session's project for a sidebar group on `hostId`, including grouped Claude worktrees. */
export function projectForGroup(
  sessions: readonly ChatSessionSummary[],
  hostId: string,
  directory: string
): ChatProject | undefined {
  return sessions.find(
    session =>
      session.project && summaryHostId(session) === hostId && projectGroupOf(session.project).directory === directory
  )?.project;
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
export function orderedSessions(
  sections: SidebarSections,
  {
    isOpen = () => false,
    includeImported = false,
  }: { isOpen?: (sessionId: string) => boolean; includeImported?: boolean } = {}
): ChatSessionSummary[] {
  // A folded parent's children are left out too: the sidebar does not draw them.
  const withChildren = (session: ChatSessionSummary): ChatSessionSummary[] => [
    session,
    ...(isOpen(session.id) ? (sections.children.get(session.id) ?? []).flatMap(withChildren) : []),
  ];
  // Archived and imported rows are left out: the shortcut counts what the sidebar draws, and
  // those sit behind disclosures that are shut by default. SessionList asks for the imported
  // rows while their section is open.
  return [
    ...sections.pinned,
    ...sections.custom.flatMap(group => group.sessions),
    ...sections.projects.flatMap(group => group.sessions),
    ...sections.loose,
    ...(includeImported ? sections.imported : []),
  ].flatMap(withChildren);
}
