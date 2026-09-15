// Per-session move history tracker for chess games.
//
// The chess artifact metadata only carries the latest FEN + lastMove, not full
// move history. We need the full SAN move list for opening recognition, so we
// track it client-side, keyed by sessionId.
//
// PromptReplies pushes moves into the tracker as new chess artifacts arrive
// (it already has player+AI SAN from validateChessFen). InteractiveChessBoard
// reads from it to display the opening name.
//
// Persistence: we write through to localStorage on every mutation so reloading
// the tab mid-game doesn't lose the opening label. The in-memory Map is the
// source of truth at runtime; localStorage is the cold-start backstop.

const STORAGE_PREFIX = 'lumina5-chess-moves-';
// Hard cap to keep localStorage entries small even for absurdly long games.
// Real chess games are < 200 plies; 400 is well outside the realistic range.
const MAX_MOVES_PER_SESSION = 400;

const moveListBySession = new Map<string, string[]>();
// Tracks which sessions we've already attempted to hydrate from localStorage,
// so the first read of a fresh session pays the cost once.
const hydratedSessions = new Set<string>();

function storageKey(sessionId: string): string {
  return `${STORAGE_PREFIX}${sessionId}`;
}

function hydrateFromStorage(sessionId: string): void {
  if (hydratedSessions.has(sessionId)) return;
  hydratedSessions.add(sessionId);
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(storageKey(sessionId));
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(m => typeof m === 'string')) {
      moveListBySession.set(sessionId, parsed as string[]);
    }
  } catch {
    // Quota / parse / SecurityError - fall back to empty in-memory state.
  }
}

function persistToStorage(sessionId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const moves = moveListBySession.get(sessionId);
    if (!moves || moves.length === 0) {
      window.localStorage.removeItem(storageKey(sessionId));
    } else {
      window.localStorage.setItem(storageKey(sessionId), JSON.stringify(moves));
    }
  } catch {
    // Quota exceeded / private mode / etc. - purely a polish feature, swallow.
  }
}

/** Reset move history for a session (e.g. on new_game). */
export function resetSessionMoves(sessionId: string): void {
  hydratedSessions.add(sessionId); // skip hydration after explicit reset
  moveListBySession.delete(sessionId);
  persistToStorage(sessionId);
}

/** Append SAN moves to a session's history. Caller is responsible for de-duping. */
export function appendSessionMoves(sessionId: string, sanMoves: string[]): void {
  if (sanMoves.length === 0) return;
  hydrateFromStorage(sessionId);
  const existing = moveListBySession.get(sessionId) ?? [];
  const next = [...existing, ...sanMoves];
  // Cap defensively - pathological inputs shouldn't blow up localStorage quota.
  const capped = next.length > MAX_MOVES_PER_SESSION ? next.slice(-MAX_MOVES_PER_SESSION) : next;
  moveListBySession.set(sessionId, capped);
  persistToStorage(sessionId);
}

/** Get the current move list for a session. */
export function getSessionMoves(sessionId: string): string[] {
  hydrateFromStorage(sessionId);
  return moveListBySession.get(sessionId) ?? [];
}

// Test-only helper. Clears in-memory + storage state for ALL sessions, used to
// reset state between tests. Not exported from the component public API.
export function __resetAllSessionMovesForTests(): void {
  if (typeof window !== 'undefined') {
    try {
      // Walk localStorage and delete only our prefixed keys.
      const toDelete: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) toDelete.push(k);
      }
      for (const k of toDelete) window.localStorage.removeItem(k);
    } catch {
      // ignore
    }
  }
  moveListBySession.clear();
  hydratedSessions.clear();
}
