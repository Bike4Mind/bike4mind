import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_NOTIFY_SCOPE, type NotifyScope } from '@shared/attention';

/**
 * Which sessions raise needs-you alerts. Lives in main (main/attention/NotifyScopeStore.ts), since
 * main announces while no window is open; a change from any window is pushed back to every window.
 */
export function useNotifyScope(): [NotifyScope, (scope: NotifyScope) => void] {
  const [scope, setScope] = useState<NotifyScope>(DEFAULT_NOTIFY_SCOPE);
  useEffect(() => {
    let live = true;
    void window.b4m.attention
      .getNotifyScope()
      .then(stored => live && setScope(stored))
      .catch((error: unknown) => console.warn('Could not load the notification setting.', error));
    const off = window.b4m.attention.onNotifyScope(next => live && setScope(next));
    return () => {
      live = false;
      off();
    };
  }, []);
  const change = useCallback((next: NotifyScope) => {
    void window.b4m.attention
      .setNotifyScope(next)
      .then(setScope)
      .catch((error: unknown) => console.warn('Could not change the notification setting.', error));
  }, []);
  return [scope, change];
}

export function notifyScopeSummary(scope: NotifyScope): string {
  return scope === 'all'
    ? 'Any session waiting on you: notification and dock badge.'
    : 'Agents and orchestrations only. Other sessions stay quiet.';
}
