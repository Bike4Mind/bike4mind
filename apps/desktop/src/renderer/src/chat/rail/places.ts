import type { ChatSessionMode } from '@shared/chat';

/**
 * Where the user is working: the rail picks one, and the sidebar and main pane show its contents.
 *
 * Chat and Code are the session places: either one filters the session list and is what New
 * starts. Studio keeps its own conversation (a 'studio' session, never listed) for Create to save
 * into, and leaves the Chat or Code conversation open underneath, so coming back lands where the
 * user left. Library is the account's generated media; like Studio it leaves the conversation
 * underneath alone.
 *
 * Agents is a board, not a list: every session waiting on the user, whatever place it lives in.
 * It has no sidebar of its own, and opening an entry takes the user to that session's place.
 */
export type Place = 'chat' | 'code' | 'studio' | 'agents' | 'library';

/** The session modes a sidebar lists and New starts. */
export type SessionPlace = Exclude<ChatSessionMode, 'studio'>;

export type StudioArea = 'create' | 'productions' | 'library';

export const PLACES: readonly { place: Place; label: string; digit: number }[] = [
  { place: 'chat', label: 'Chat', digit: 1 },
  { place: 'code', label: 'Code', digit: 2 },
  { place: 'studio', label: 'Studio', digit: 3 },
  { place: 'agents', label: 'Agents', digit: 4 },
  { place: 'library', label: 'Library', digit: 5 },
];

export const placeLabel = (place: Place) => PLACES.find(entry => entry.place === place)?.label ?? place;

export function isSessionPlace(place: Place): place is SessionPlace {
  return place === 'chat' || place === 'code';
}

/** Whether the place has a sidebar beside it, which its active rail icon shows and hides. */
export function placeHasSidebar(place: Place): boolean {
  return place !== 'agents';
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
  /** The Studio session Create last saved into. */
  studioSession?: string;
}

const STORAGE_KEY = 'b4m.chat.places';

const isPlace = (value: unknown): value is Place => PLACES.some(entry => entry.place === value);

export function readPlaceMemory(): PlaceMemory | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { place, chat, code, studio, studioSession } = parsed as Record<string, unknown>;
    if (!isPlace(place)) return null;
    return {
      place,
      ...(typeof chat === 'string' ? { chat } : {}),
      ...(typeof code === 'string' ? { code } : {}),
      ...(studio === 'create' || studio === 'productions' || studio === 'library' ? { studio } : {}),
      ...(typeof studioSession === 'string' ? { studioSession } : {}),
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
