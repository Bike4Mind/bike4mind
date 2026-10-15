import { useEffect, useState } from 'react';

let known: string | undefined;
let asking: Promise<string> | undefined;

function readHomeDirectory(): Promise<string> {
  asking ??= window.b4m.getAppInfo().then(
    info => (known = info.homeDirectory),
    () => {
      asking = undefined;
      return '';
    }
  );
  return asking;
}

/**
 * The user's home folder, or '' until main has answered. Asked once per window and shared, so a
 * row of chips per session costs one IPC round trip in all.
 */
export function useHomeDirectory(): string {
  const [home, setHome] = useState(known ?? '');

  useEffect(() => {
    if (known !== undefined) return;
    let live = true;
    void readHomeDirectory().then(value => live && setHome(value));
    return () => {
      live = false;
    };
  }, []);

  return home;
}
