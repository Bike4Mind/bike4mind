import type { ChatSessionMode } from '@shared/chat';

/**
 * Where the user is working: the rail picks one, and the sidebar and main pane show its contents.
 *
 * Chat and Code are the two session modes, so a place of either one filters the session list and
 * is what New starts. Studio is not a session mode: the conversation open before it stays open
 * underneath, so coming back to Chat or Code lands where the user left.
 */
export type Place = 'chat' | 'code' | 'studio';

export type StudioArea = 'create' | 'productions';

export const PLACES: readonly { place: Place; label: string; digit: number }[] = [
  { place: 'chat', label: 'Chat', digit: 1 },
  { place: 'code', label: 'Code', digit: 2 },
  { place: 'studio', label: 'Studio', digit: 3 },
];

export const placeLabel = (place: Place) => PLACES.find(entry => entry.place === place)?.label ?? place;

export function isSessionPlace(place: Place): place is ChatSessionMode {
  return place === 'chat' || place === 'code';
}

/**
 * The last place, and the last item open in each one. Window chrome like the sidebar width and
 * the last session, so localStorage with the same blocked-storage fallback (see lastSession.ts).
 */
export interface PlaceMemory {
  place: Place;
  /** Last session id open in each session place. */
  chat?: string;
  code?: string;
  studio?: StudioArea;
}

const STORAGE_KEY = 'b4m.chat.places';

const isPlace = (value: unknown): value is Place => value === 'chat' || value === 'code' || value === 'studio';

export function readPlaceMemory(): PlaceMemory | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { place, chat, code, studio } = parsed as Record<string, unknown>;
    if (!isPlace(place)) return null;
    return {
      place,
      ...(typeof chat === 'string' ? { chat } : {}),
      ...(typeof code === 'string' ? { code } : {}),
      ...(studio === 'create' || studio === 'productions' ? { studio } : {}),
    };
  } catch {
    // Storage blocked or the value unreadable: start in Chat, as a fresh install does.
    return null;
  }
}

export function writePlaceMemory(memory: PlaceMemory): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Kept for this run by the shell's own state; only the next launch loses it.
  }
}
