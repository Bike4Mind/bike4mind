import type {
  IFabFileRepository,
  IProjectDocument,
  IProjectRepository,
  ISessionRepository,
  IUserShare,
} from '@bike4mind/common';
import { ConcurrencyConflictError } from '@bike4mind/common';
import { canonicalId } from '../utils/objectIds';
import { grantWrite } from './grantWrite';
import { projectGrantorCheck, projectParticipants, type GrantorUsers, type SharedItem } from './projectGrantor';

type GrantDocument = SharedItem & { knowledgeIds?: string[] };
type ItemKind = 'files' | 'sessions';
type TrackedItem = { kind: ItemKind; document: GrantDocument; persist: boolean; dirty: boolean; revision: number };
type TrackedProject = {
  document: IProjectDocument;
  persist: boolean;
  removedFiles: Set<string>;
  removedSessions: Set<string>;
};

export type GrantLossAdapters = {
  db: {
    projects: IProjectRepository;
    fabFiles?: IFabFileRepository;
    sessions?: ISessionRepository;
    users: GrantorUsers;
  };
  onAccessRemoved?: (userIds: string[]) => void;
};

export const requireGrantorUsers = (users: Partial<GrantorUsers> | undefined): GrantorUsers => {
  if (typeof users?.findById !== 'function' || typeof users.findUserIdsByGroupIds !== 'function') {
    throw new Error('Grant cleanup requires user lookup capabilities');
  }
  return { findById: users.findById.bind(users), findUserIdsByGroupIds: users.findUserIdsByGroupIds.bind(users) };
};

/** Tracks only removals, using the existing independent owner/direct/group grantor rule. */
export const createGrantLossCleanup = ({ db, onAccessRemoved }: GrantLossAdapters) => {
  const items = new Map<string, TrackedItem>();
  const projects = new Map<string, TrackedProject>();
  const pending = new Map<string, { item: TrackedItem; userId: string }>();
  const processed = new Map<string, number>();
  const notifiedProjects = new Set<string>();
  const itemKey = (kind: ItemKind, id: string) => `${kind}:${canonicalId(id)}`;

  const track = (kind: ItemKind, document: GrantDocument, persist = true): TrackedItem => {
    if (kind === 'sessions' && !db.sessions) throw new Error('Grant cleanup requires the session repository');
    if (kind === 'files' && !db.fabFiles) throw new Error('Grant cleanup requires the file repository');
    const key = itemKey(kind, document.id);
    const existing = items.get(key);
    if (existing) return existing;
    const item = { kind, document, persist, dirty: false, revision: 0 };
    items.set(key, item);
    return item;
  };

  // A pending membership edit must win over a later database snapshot of the same project.
  const trackProject = (document: IProjectDocument, persist = true): TrackedProject => {
    const key = canonicalId(document.id);
    const existing = projects.get(key);
    if (existing) return existing;
    const project = { document, persist, removedFiles: new Set<string>(), removedSessions: new Set<string>() };
    projects.set(key, project);
    return project;
  };

  const enqueue = (item: TrackedItem, userIds: string[]) => {
    onAccessRemoved?.([...new Set(userIds)]);
    for (const userId of userIds) pending.set(`${itemKey(item.kind, item.document.id)}:${userId}`, { item, userId });
  };

  const removeRows = (item: TrackedItem, matches: (row: IUserShare) => boolean) => {
    const removed = item.document.users.filter(matches);
    if (removed.length === 0) return;
    item.document.users = item.document.users.filter(row => !matches(row));
    item.dirty = true;
    item.revision += 1;
    enqueue(
      item,
      removed.map(row => String(row.userId))
    );
  };

  const notifyProject = async (project: IProjectDocument) => {
    const key = canonicalId(project.id);
    if (notifiedProjects.has(key)) return;
    const groupIds = (project.groups ?? [])
      .filter(group => group.permissions?.some(permission => ['read', 'write'].includes(permission)))
      .map(group => group.groupId);
    const members = groupIds.length ? Object.values(await db.users.findUserIdsByGroupIds(groupIds)).flat() : [];
    onAccessRemoved?.([...new Set([...projectParticipants(project), ...members])]);
    notifiedProjects.add(key);
  };

  const removeReference = async (project: TrackedProject, item: TrackedItem) => {
    const sameItem = (id: string) => canonicalId(id) === canonicalId(item.document.id);
    if (item.kind === 'files') {
      const references = [
        ...(project.document.fileIds ?? []),
        ...(project.document.systemPrompts ?? []).map(prompt => prompt.fileId),
      ].filter(sameItem);
      if (references.length === 0) return false;
      references.forEach(id => project.removedFiles.add(id));
      project.document.fileIds = (project.document.fileIds ?? []).filter(id => !sameItem(id));
      project.document.systemPrompts = (project.document.systemPrompts ?? []).filter(
        prompt => !sameItem(prompt.fileId)
      );
    } else {
      const references = project.document.sessionIds.filter(sameItem);
      if (references.length === 0) return false;
      references.forEach(id => project.removedSessions.add(id));
      project.document.sessionIds = project.document.sessionIds.filter(id => !sameItem(id));
    }
    removeRows(item, row => !!row.projectId && canonicalId(row.projectId) === canonicalId(project.document.id));
    await notifyProject(project.document);
    return true;
  };

  const detachSessionKnowledge = async (session: GrantDocument, project: TrackedProject) => {
    const knowledgeIds = new Set((session.knowledgeIds ?? []).map(canonicalId));
    const ids = [
      ...(project.document.fileIds ?? []),
      ...(project.document.systemPrompts ?? []).map(prompt => prompt.fileId),
    ].filter(id => knowledgeIds.has(canonicalId(id)));
    if (ids.length === 0) return;
    if (!db.fabFiles) throw new Error('Grant cleanup requires the file repository');
    const hasGrantor = projectGrantorCheck(project.document, db);
    for (const file of await db.fabFiles.findAllByIds(ids, { includeDeleted: true })) {
      const item = track('files', file as SharedItem);
      if (!(await hasGrantor(item.document))) await removeReference(project, item);
    }
  };

  const drain = async () => {
    while (pending.size > 0) {
      const next = pending.entries().next().value;
      if (!next) break;
      const [key, { item, userId }] = next;
      pending.delete(key);
      if (processed.get(key) === item.revision) continue;
      processed.set(key, item.revision);
      const member = await db.users.findById(userId);
      if (!member) continue;
      const referenced = await db.projects.findParticipatingReferencing(
        member,
        item.kind === 'files' ? { fileId: item.document.id } : { sessionId: item.document.id }
      );
      const candidates = new Map(referenced.map(project => [canonicalId(project.id), project]));
      for (const project of projects.values()) {
        if (!project.persist) candidates.set(canonicalId(project.document.id), project.document);
      }
      for (const found of candidates.values()) {
        const project = trackProject(found);
        if (await projectGrantorCheck(project.document, db)(item.document)) continue;
        if (!(await removeReference(project, item))) continue;
        if (item.kind === 'sessions') await detachSessionKnowledge(item.document, project);
      }
    }
  };

  const detachDeletedSession = async (session: GrantDocument, referenced: IProjectDocument[]) => {
    const item = track('sessions', session, false);
    for (const found of referenced) {
      const project = trackProject(found);
      await removeReference(project, item);
      await detachSessionKnowledge(session, project);
    }
  };

  const saveItem = async (item: TrackedItem) => {
    if (item.kind === 'files') {
      if (!db.fabFiles?.updateGuarded) throw new Error('File grant cleanup requires guarded writes');
      return db.fabFiles.updateGuarded(grantWrite(item.document), { includeDeleted: true });
    }
    if (!db.sessions?.updateGuarded) throw new Error('Session grant cleanup requires guarded writes');
    return db.sessions.updateGuarded(grantWrite(item.document), { includeDeleted: true });
  };

  const flush = async () => {
    for (const item of items.values()) {
      if (!item.persist || !item.dirty) continue;
      const saved = await saveItem(item);
      if (saved === null) throw new ConcurrencyConflictError(item.kind, { id: item.document.id });
      item.dirty = false;
    }
    for (const project of projects.values()) {
      if (!project.persist) continue;
      if (project.removedFiles.size) {
        await db.projects.pullFileReferences([...project.removedFiles], { projectId: project.document.id });
      }
      if (project.removedSessions.size) {
        await db.projects.pullSessionReferences([...project.removedSessions], { projectId: project.document.id });
      }
      project.removedFiles.clear();
      project.removedSessions.clear();
    }
  };

  return {
    track,
    trackProject,
    enqueue,
    removeRows,
    removeReference,
    detachSessionKnowledge,
    detachDeletedSession,
    drain,
    flush,
  };
};

export type GrantLossCleanup = ReturnType<typeof createGrantLossCleanup>;
