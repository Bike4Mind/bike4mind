import type { ToolContext } from './types';

const MAX_FILES_PER_SESSION = 12;
const MAX_SESSIONS = 50;

/**
 * Files each session has read, edited or patched, newest last. Kept beside the tools rather than
 * in ChatService so no plumbing is needed: every tool already receives the session id. It only
 * feeds an error hint, so it is bounded and forgets the oldest session first.
 */
const bySession = new Map<string, string[]>();

export function recordRecentFile(context: ToolContext, target: string): void {
  const id = context.sessionId;
  if (!id) return;
  const files = (bySession.get(id) ?? []).filter(file => file !== target);
  files.push(target);
  if (files.length > MAX_FILES_PER_SESSION) files.shift();
  bySession.delete(id);
  bySession.set(id, files);
  if (bySession.size > MAX_SESSIONS) bySession.delete(bySession.keys().next().value as string);
}

/** Most recent first. */
export function recentFiles(context: ToolContext): string[] {
  const id = context.sessionId;
  return id ? [...(bySession.get(id) ?? [])].reverse() : [];
}
