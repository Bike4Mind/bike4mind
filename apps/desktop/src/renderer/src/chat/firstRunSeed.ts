import type { ChatSessionMode } from '@shared/chat';

/**
 * Whether to make a session for a mode the window has just arrived in, marking that arrival as
 * it goes. The set it mutates is the whole of the state: modes this window has already landed
 * in, written on the FIRST render after loading settles and never cleared.
 *
 * Marking BEFORE answering is what makes this first-arrival-only rather than a standing
 * invariant that every empty mode must hold a session, and that one line settles the three ways
 * an effect like this goes wrong:
 *
 * - It cannot loop. The mark lands before the caller has even issued the create, so the
 *   re-render the new session causes - or a create that FAILS and leaves the mode still empty -
 *   comes back to a marked mode and stops. Retrying is the user's, through the button in the
 *   empty pane.
 * - Toggling Chat/Code seeds each mode at most once per window, so flipping back and forth
 *   piles up nothing.
 * - Deleting the last session brings no replacement back: by then the mode is long marked, so
 *   the pane falls to its empty state and the delete reads as having worked, which respawning
 *   would make it look like it had not. A relaunch with nothing on disk is a fresh arrival and
 *   does seed - that is the dead end this exists to close, and not a delete.
 */
export function seedOnArrival(
  arrived: Set<ChatSessionMode>,
  input: { loading: boolean; mode: ChatSessionMode; hasSessionInMode: boolean }
): boolean {
  if (input.loading) return false;
  if (arrived.has(input.mode)) return false;
  arrived.add(input.mode);
  return !input.hasSessionInMode;
}
