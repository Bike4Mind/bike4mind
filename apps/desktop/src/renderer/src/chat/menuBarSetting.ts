import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_WATCH_PREFERENCES } from '@shared/watch';

/**
 * Whether the menu-bar summary is shown. Lives in main (main/watch/WatchPreferencesStore.ts), since
 * main owns the Tray; the menu's own "Hide menu-bar item" writes the same preference and is pushed
 * back here.
 */
export function useMenuBarSetting(): [boolean, () => void] {
  const [shown, setShown] = useState(DEFAULT_WATCH_PREFERENCES.showInMenuBar);
  useEffect(() => {
    let live = true;
    void window.b4m.watch
      .getPreferences()
      .then(preferences => live && setShown(preferences.showInMenuBar))
      .catch((error: unknown) => console.warn('Could not load the menu-bar setting.', error));
    const off = window.b4m.watch.onPreferences(preferences => live && setShown(preferences.showInMenuBar));
    return () => {
      live = false;
      off();
    };
  }, []);
  const toggle = useCallback(() => {
    void window.b4m.watch
      .setPreferences({ showInMenuBar: !shown })
      .then(preferences => setShown(preferences.showInMenuBar))
      .catch((error: unknown) => console.warn('Could not change the menu-bar setting.', error));
  }, [shown]);
  return [shown, toggle];
}
