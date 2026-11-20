/**
 * Whether Explore lists abliterated builds, remembered per machine like the other window
 * settings in localStorage. Off until the user turns it on; shown or not, they are never recommended.
 */
const STORAGE_KEY = 'b4m.models.showAbliterated';

export function readShowAbliterated(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeShowAbliterated(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    // Kept for this run only.
  }
}
