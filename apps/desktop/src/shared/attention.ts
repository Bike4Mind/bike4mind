/**
 * A session that wants the user while the app is in the background. `rootId` is the top of its
 * spawn tree (the session itself when it spawned from nothing), which is where a click lands.
 */
export interface AttentionNotice {
  sessionId: string;
  rootId: string;
  title: string;
  body: string;
}

/** main -> renderer: the user clicked a notice; open `sessionId` under `rootId`. */
export type AttentionOpenEvent = Pick<AttentionNotice, 'sessionId' | 'rootId'>;

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== '';

export const MAX_NOTICE_TITLE_LENGTH = 120;
export const MAX_NOTICE_BODY_LENGTH = 240;

/**
 * The renderer is untrusted input to main, so a notice is checked field by field and its text
 * trimmed and capped before it is shown. Null when any field is missing or not a string.
 */
export function parseAttentionNotice(value: unknown): AttentionNotice | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const { sessionId, rootId, title, body } = candidate;
  if (!isNonEmptyString(sessionId) || !isNonEmptyString(rootId)) return null;
  if (typeof title !== 'string' || typeof body !== 'string') return null;
  const trimmedTitle = title.trim().slice(0, MAX_NOTICE_TITLE_LENGTH);
  if (trimmedTitle === '') return null;
  return { sessionId, rootId, title: trimmedTitle, body: body.trim().slice(0, MAX_NOTICE_BODY_LENGTH) };
}
