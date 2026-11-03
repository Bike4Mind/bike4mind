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

/** The renderer is untrusted input to main, so a notice is checked field by field before it is shown. */
export function isAttentionNotice(value: unknown): value is AttentionNotice {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.sessionId) &&
    isNonEmptyString(candidate.rootId) &&
    isNonEmptyString(candidate.title) &&
    typeof candidate.body === 'string'
  );
}
