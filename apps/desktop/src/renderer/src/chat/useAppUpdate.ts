import { useCallback, useEffect, useState } from 'react';
import { initialUpdateState, type UpdateBusyReport, type UpdateState, type UpdateStatus } from '@shared/update';

export interface AppUpdateController {
  state: UpdateState;
  /** Work an install would interrupt, set only after one was refused for that reason. */
  blockedBy: UpdateBusyReport | null;
  /** A download this view watched fell back to the offer. Cleared by the next try or by `dismiss`. */
  downloadFailed: boolean;
  check: () => void;
  download: () => void;
  /** Asks main to restart. Returns true when the app is going; false means `blockedBy` is set. */
  install: (force: boolean) => Promise<boolean>;
  dismissBlock: () => void;
  /** Closes the update notice for `version`. */
  dismiss: (version: string) => void;
}

/**
 * The update state, kept live from main.
 *
 * Pushed rather than polled, like the MCP list and auth: a check runs on a timer hours after
 * launch, and a download reports progress the renderer did not ask for. The seed value is the
 * shared initial state so the first paint has a version-shaped row rather than an empty one.
 */
export function useAppUpdate(): AppUpdateController {
  const [state, setState] = useState<UpdateState>(() => initialUpdateState('', false));
  const [blockedBy, setBlockedBy] = useState<UpdateBusyReport | null>(null);
  const [downloadFailed, setDownloadFailed] = useState(false);

  useEffect(() => {
    let last: UpdateStatus | null = null;
    // Judged per push, not per render: a download that fails at once sends 'downloading' and then
    // 'available' back to back, and a render may only see the second. Only a failure goes that way.
    const receive = (next: UpdateState) => {
      if (last === 'downloading' && next.status === 'available') setDownloadFailed(true);
      else if (next.status !== 'available') setDownloadFailed(false);
      last = next.status;
      setState(next);
    };
    void window.b4m.update.getState().then(receive);
    return window.b4m.update.onStateChanged(receive);
  }, []);

  const check = useCallback(() => void window.b4m.update.check(), []);
  const download = useCallback(() => void window.b4m.update.download(), []);

  const install = useCallback(async (force: boolean) => {
    const result = await window.b4m.update.install(force);
    if (result.ok) return true;
    // 'not-ready' needs no dialog: the button that reaches it is only rendered when it is.
    setBlockedBy(result.reason === 'busy' ? result.busy : null);
    return false;
  }, []);

  const dismissBlock = useCallback(() => setBlockedBy(null), []);

  const dismiss = useCallback((version: string) => {
    setDownloadFailed(false);
    void window.b4m.update.dismiss(version);
  }, []);

  return { state, blockedBy, downloadFailed, check, download, install, dismissBlock, dismiss };
}
