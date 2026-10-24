import type { AuthState } from '@shared/auth';
import { sessionScopeForChat, sessionScopeKey } from '../sessionScope';

/** Session ids can recur across accounts; an open page must stay with its original scope. */
export function closeBrowsersOnScopeChange(initial: AuthState, closeBrowsers: () => void): (state: AuthState) => void {
  const keyOf = (state: AuthState): string | null => {
    const scope = sessionScopeForChat(state);
    return scope ? sessionScopeKey(scope) : null;
  };
  let current = keyOf(initial);
  return state => {
    const next = keyOf(state);
    if (next === current) return;
    current = next;
    closeBrowsers();
  };
}
