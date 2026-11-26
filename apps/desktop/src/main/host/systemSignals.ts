import { net, powerMonitor } from 'electron';
import type { SystemSignals } from './ConnectionManager';

/** How often the network state is read, in ms; main has no online event, and `net.isOnline()` is a local check. */
const ONLINE_POLL_MS = 5_000;

/** Wake from powerMonitor, and network-back from polling `net.isOnline()` while anyone listens. */
export function electronSystemSignals(): SystemSignals {
  const onlineListeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let online = net.isOnline();

  const poll = () => {
    const now = net.isOnline();
    const cameBack = now && !online;
    online = now;
    if (cameBack) for (const listener of onlineListeners) listener();
  };

  return {
    isOnline: () => net.isOnline(),
    onWake: listener => {
      powerMonitor.on('resume', listener);
      powerMonitor.on('unlock-screen', listener);
      return () => {
        powerMonitor.off('resume', listener);
        powerMonitor.off('unlock-screen', listener);
      };
    },
    onOnline: listener => {
      onlineListeners.add(listener);
      timer ??= setInterval(poll, ONLINE_POLL_MS);
      return () => {
        onlineListeners.delete(listener);
        if (onlineListeners.size > 0) return;
        clearInterval(timer);
        timer = undefined;
      };
    },
  };
}
