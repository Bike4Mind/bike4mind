import { useEffect, useState } from 'react';

/**
 * This Desktop's version, the one a host's program is compared with. Empty until main answers,
 * which reads as "unknown": nothing is offered an update on a guess.
 */
export function useDesktopVersion(): string {
  const [version, setVersion] = useState('');
  useEffect(() => {
    let live = true;
    window.b4m.update
      .getState()
      .then(state => live && setVersion(state.currentVersion))
      .catch((error: unknown) => console.warn('Could not read the app version', error));
    return () => {
      live = false;
    };
  }, []);
  return version;
}
