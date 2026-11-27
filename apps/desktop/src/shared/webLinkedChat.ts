import { isLocalModel, OPTIMISTIC_ID_PREFIX, type ChatSession } from './chat';
import { isImportedMessageId, type ChatImportOrigin } from './claudeImport';

/**
 * A Bike4Mind web chat the desktop still mirrors, where a typed message is added to the web
 * session itself (POST /api/v1/turns) rather than run by the local agent loop. See
 * ChatService.sendLinkedTurn.
 */

type LinkedSessionFields = Pick<
  ChatSession,
  'mode' | 'importOrigin' | 'messages' | 'grantedDirectories' | 'orchestrate' | 'model'
>;

/**
 * How long a running mark holds without being renewed. Each sync that still sees the reply
 * unsettled stamps it again (every few minutes while sync is on), so it lapses only when nothing
 * can refresh it: sync turned off, the notebook gone, or a stop the server never confirmed.
 */
export const LINKED_RUNNING_LEASE_MS = 10 * 60_000;

/** A reply in the notebook is still being written, as far as this copy knows. */
export function isLinkedReplyRunning(
  origin: Pick<ChatImportOrigin, 'runningSince'> | undefined,
  now = Date.now()
): boolean {
  const since = origin?.runningSince ? Date.parse(origin.runningSince) : NaN;
  return Number.isFinite(since) && now - since < LINKED_RUNNING_LEASE_MS;
}

/**
 * Still synced with its web notebook: a basic chat (no folders shared with its local tools, no
 * orchestration) that nothing has continued locally. A prompt the renderer is still drawing
 * optimistically is not stored yet, so it does not count as a local message.
 */
export function isLinkedWebSession(session: LinkedSessionFields): boolean {
  const origin = session.importOrigin;
  if (origin?.kind !== 'b4m-web' || origin.forkedAt) return false;
  if (session.mode !== 'chat' || session.orchestrate) return false;
  if (session.grantedDirectories?.length) return false;
  return session.messages.every(
    message => isImportedMessageId(message.id) || message.id.startsWith(OPTIMISTIC_ID_PREFIX)
  );
}

/** What about one send decides whether the server can run it. */
export interface LinkedSendRequest {
  attachments: number;
  /** An edit of an earlier prompt, which rewinds the thread. */
  replaces?: boolean;
  /** A `/skill` invocation or a skill named mid-message: both run locally. */
  skill?: boolean;
  notes?: number;
  /** Anything not typed in this window's composer: a queue release, relay, loop or spawn seed. */
  automated?: boolean;
}

/**
 * Whether this send goes to the web session. Anything a server turn cannot do (local files,
 * local tools, skills, rewinding history, a model on this machine or none at all) keeps the
 * local path, which continues the chat here and stops it syncing.
 */
export function isLinkedWebSend(session: LinkedSessionFields, request: LinkedSendRequest): boolean {
  if (!isLinkedWebSession(session)) return false;
  if (!session.model || isLocalModel(session.model)) return false;
  return request.attachments === 0 && !request.replaces && !request.skill && !request.notes && !request.automated;
}

/** A linked chat takes no new message while a reply in its notebook is being written, here or on the web. */
export function isLinkedChatBusy(session: LinkedSessionFields, replying: boolean, now = Date.now()): boolean {
  return isLinkedWebSession(session) && (replying || isLinkedReplyRunning(session.importOrigin, now));
}
