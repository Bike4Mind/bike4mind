/**
 * Persistence for the opt-in WebSocket debug chip (`NetworkStatus`).
 *
 * The chip is gated on `?debug=ws`, but Tanstack Router's `navigate()` drops the query
 * string on in-app SPA navigation, so the chip used to vanish the moment you clicked
 * around. Stash the opt-in in `sessionStorage` on first detection and fall back to it when
 * the URL no longer carries the param - the chip then stays visible for the whole tab
 * session once enabled, without threading the param through every `navigate()` call.
 *
 * Off-switch: `?debug=off` clears the stored flag. Client-only - callers must guard on
 * `typeof window`.
 */
const SESSION_KEY = 'debug-ws';

export function resolveWsDebugChipVisible(search: string): boolean {
  const param = new URLSearchParams(search).get('debug');
  try {
    if (param === 'ws') {
      // Sticky-enable for the rest of the tab session.
      sessionStorage.setItem(SESSION_KEY, '1');
      return true;
    }
    if (param === 'off') {
      // Explicit off-switch - clears the sticky flag so the chip hides again.
      sessionStorage.removeItem(SESSION_KEY);
      return false;
    }
    // No (relevant) param this navigation - honor the stored opt-in.
    return sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    // sessionStorage can throw (private mode / storage disabled or blocked). This runs on
    // every NetworkStatus mount, so never let a storage failure break the effect - degrade
    // gracefully: honor an in-URL ?debug=ws for the current view, otherwise stay hidden.
    return param === 'ws';
  }
}
