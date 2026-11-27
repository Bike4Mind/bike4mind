type SingleInstanceHost = {
  requestSingleInstanceLock(): boolean;
  on(event: 'second-instance', listener: (event: unknown, argv: string[], workingDirectory: string) => void): unknown;
};

/**
 * Hold this profile's single-instance lock. Electron keys the lock on the userData folder, so it
 * must be taken after appIdentity has moved a dev run onto its own: a dev build and the installed
 * app then hold separate locks and still run side by side, while a second launch of either one
 * hands over to the first. Returns false when another process already holds it; that process is
 * told (onSecondLaunch) and this one should exit without opening anything.
 *
 * There is no deep-link scheme yet, so the second launch's argv is not acted on; a handler for
 * one would read it here.
 */
export function claimSingleInstance(host: SingleInstanceHost, onSecondLaunch: () => void): boolean {
  if (!host.requestSingleInstanceLock()) return false;
  host.on('second-instance', () => onSecondLaunch());
  return true;
}
