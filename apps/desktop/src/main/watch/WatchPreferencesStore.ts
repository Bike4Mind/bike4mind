import { parseWatchPreferences, type WatchPreferences } from '@shared/watch';
import { PreferenceFile } from '../preferenceFile';

/**
 * The menu-bar toggle and the mini Tavern's bounds and visibility (watch-preferences.json). See
 * PreferenceFile for how it is read and written.
 */
export class WatchPreferencesStore extends PreferenceFile<WatchPreferences> {
  constructor(filePath: string) {
    super(filePath, parseWatchPreferences, 'WATCH');
  }
}
