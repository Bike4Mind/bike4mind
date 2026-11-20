import type { ChatSessionSummary } from '@shared/chat';
import { formatSessionMention, mentionTitle } from '@shared/sessionMention';

/**
 * The composer's `@` menu, as pure functions: when it is asking, which sessions answer, and how
 * the `@Title` the user sees becomes the markup that is sent (see shared/sessionMention.ts).
 */

/** The `@token` the caret is in, while a session name is being composed. */
export interface MentionQuery {
  /** What was typed after the `@`. Empty right after it. */
  query: string;
  /** Index of the `@`. */
  start: number;
  /** The caret: where the typed query ends and a picked title stops replacing. */
  end: number;
}

/**
 * The token the caret is composing, or null. An `@` at the start of the draft or after
 * whitespace, with no whitespace between it and the caret and nothing glued on after the caret.
 * `me@host` and `@a b|` are an address and a finished word, so neither opens a menu.
 */
export function mentionQuery(text: string, caret: number = text.length): MentionQuery | null {
  const after = text.charAt(caret);
  if (after && !/\s/.test(after)) return null;
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  return { query: match[2], start: match.index + match[1].length, end: caret };
}

export interface MentionableSession {
  id: string;
  title: string;
  /** Folder name of the session's project, or null when it has none. */
  projectName: string | null;
}

export const NO_PROJECT_LABEL = 'No project';

function folderName(directory: string): string {
  const parts = directory.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? directory;
}

/** Sessions worth offering: not the open one, not archived, most recently touched first. */
export function mentionableSessions(
  sessions: readonly ChatSessionSummary[],
  currentSessionId: string | null
): MentionableSession[] {
  return sessions
    .filter(session => session.id !== currentSessionId && !session.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(session => ({
      id: session.id,
      title: session.title,
      projectName: session.project?.directory ? folderName(session.project.directory) : null,
    }));
}

/** Lower is better; -1 means no match. Title matches outrank project-folder matches. */
function rank(session: MentionableSession, needle: string): number {
  if (!needle) return 0;
  const title = session.title.toLowerCase();
  if (title === needle) return 0;
  if (title.startsWith(needle)) return 1;
  if (title.includes(needle)) return 2;
  return session.projectName?.toLowerCase().includes(needle) ? 3 : -1;
}

/** Sessions matching `query`, best first; ties keep the recency order they arrived in. */
export function matchSessions(sessions: readonly MentionableSession[], query: string, limit = 8): MentionableSession[] {
  const needle = query.trim().toLowerCase();
  return sessions
    .map((session, index) => ({ session, index, score: rank(session, needle) }))
    .filter(entry => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map(entry => entry.session);
}

export interface RecordedMention {
  id: string;
  title: string;
}

/** What the textarea shows for a chosen session. */
export function mentionLabel(title: string): string {
  return `@${mentionTitle(title)}`;
}

/** The draft with the chosen title put in place of the token being composed, then a space. */
export function insertMention(text: string, token: MentionQuery, title: string): { text: string; caret: number } {
  const rest = text.slice(token.end);
  const head = `${text.slice(0, token.start)}${mentionLabel(title)}`;
  return { text: head + (rest.startsWith(' ') ? rest : ` ${rest}`), caret: head.length + 1 };
}

export interface LocatedMention {
  start: number;
  end: number;
  mention: RecordedMention;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Where each recorded `@Title` still stands in the text. A label only counts as a whole word, so
 * a recorded `@Fix` is not found inside `@Fixture`, and the longer of two overlapping labels
 * wins. When two sessions share a title, the nth occurrence takes the nth recorded one.
 */
export function locateMentions(text: string, recorded: readonly RecordedMention[]): LocatedMention[] {
  const candidates: { start: number; end: number; label: string }[] = [];
  for (const label of new Set(recorded.map(mention => mentionLabel(mention.title)))) {
    for (let from = text.indexOf(label); from !== -1; from = text.indexOf(label, from + 1)) {
      const end = from + label.length;
      const startsWord = from === 0 || /[\s([]/.test(text.charAt(from - 1));
      const endsWord = end === text.length || !WORD_CHAR.test(text.charAt(end));
      if (startsWord && endsWord) candidates.push({ start: from, end, label });
    }
  }
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);

  const taken: typeof candidates = [];
  for (const candidate of candidates) {
    const last = taken[taken.length - 1];
    if (!last || candidate.start >= last.end) taken.push(candidate);
  }

  const used = new Map<string, number>();
  return taken.map(({ start, end, label }) => {
    const sameLabel = recorded.filter(mention => mentionLabel(mention.title) === label);
    const nth = used.get(label) ?? 0;
    used.set(label, nth + 1);
    return { start, end, mention: sameLabel[Math.min(nth, sameLabel.length - 1)] as RecordedMention };
  });
}

/** The draft as it is sent: each surviving `@Title` becomes its markup, deleted ones are dropped. */
export function expandMentions(text: string, recorded: readonly RecordedMention[]): string {
  if (recorded.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const { start, end, mention } of locateMentions(text, recorded)) {
    out += text.slice(cursor, start) + formatSessionMention(mention.id, mention.title);
    cursor = end;
  }
  return out + text.slice(cursor);
}
