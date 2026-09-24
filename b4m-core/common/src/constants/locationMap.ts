/**
 * The fence language the model writes to place an inline map of search-result places in a reply.
 *
 * Same contract as SEARCH_RESULT_CARDS_LANGUAGE (searchResultCards.ts): `\w`-only and lowercase,
 * taught by WEB_SEARCH_MAP_PROMPT (@bike4mind/services), rendered by the reply renderer
 * (apps/client .../Session/PromptReplies.tsx), and rewritten to a plain list for every other
 * surface by `stripSearchResultCardFences`.
 */
export const LOCATION_MAP_LANGUAGE = 'b4m_map';

/**
 * One place web_search found with provider coordinates, stored on its citable as
 * `metadata.place`. The map reads coordinates ONLY from here, never from the model-authored
 * fence, which refers to a place by `id` alone.
 */
export interface WebSearchPlace {
  /** Provider place id (a Google place_id, or an OpenStreetMap `type/id` from SearXNG). */
  id: string;
  name: string;
  lat: number;
  lng: number;
  rating?: number;
  reviews?: number;
  category?: string;
  address?: string;
  /** Signed for /api/search-image; absent when the deploy cannot sign image URLs. */
  thumbnail?: string;
}

export interface LocationMapFenceEntry {
  id: string;
  name?: string;
  note?: string;
}

export interface LocationMapFence {
  anchor?: LocationMapFenceEntry & { label?: string };
  places: LocationMapFenceEntry[];
}

// Bounds what one fence may render, so a runaway generation cannot flood the list or the map.
const MAX_FENCE_PLACES = 20;
const MAX_TEXT_LENGTH = 300;

function fenceText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LENGTH);
  return text || undefined;
}

function fenceEntry(value: unknown): LocationMapFenceEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const id = fenceText(record.id);
  if (!id) return undefined;
  return { id, name: fenceText(record.name), note: fenceText(record.note) };
}

/** A parsed fence body, or null when it is not valid JSON of the documented shape. */
export function parseLocationMapFence(body: string): LocationMapFence | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.places)) return null;

  const seen = new Set<string>();
  const places: LocationMapFenceEntry[] = [];
  for (const raw of record.places) {
    const entry = fenceEntry(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    places.push(entry);
    if (places.length >= MAX_FENCE_PLACES) break;
  }

  const anchorEntry = fenceEntry(record.anchor);
  const anchor = anchorEntry
    ? { ...anchorEntry, label: fenceText((record.anchor as Record<string, unknown>).label) }
    : undefined;

  if (places.length === 0 && !anchor) return null;
  return { ...(anchor ? { anchor } : {}), places };
}

// Google's documented cross-platform Maps URL. `query_place_id` only means something for a Google
// place id; an OpenStreetMap id falls back to searching by name.
export function googleMapsSearchUrl(name: string, placeId?: string): string {
  const params = new URLSearchParams({ api: '1', query: name });
  if (placeId?.startsWith('ChIJ')) params.set('query_place_id', placeId);
  return `https://www.google.com/maps/search/?${params.toString()}`;
}

/**
 * The fence rewritten as a markdown list with "open in maps" links, for a surface that cannot
 * render the map widget. Empty when the body is not a usable fence, so a broken block disappears
 * rather than leaking JSON.
 */
export function locationMapFallbackMarkdown(body: string): string {
  const fence = parseLocationMapFence(body);
  if (!fence) return '';
  const line = (entry: LocationMapFenceEntry, tag?: string) => {
    const name = entry.name ?? 'Place';
    const note = entry.note ? ` - ${entry.note}` : '';
    const label = tag ? ` (${tag})` : '';
    return `- **${name}**${label}${note} ([Open in Google Maps](${googleMapsSearchUrl(name, entry.id)}))`;
  };
  const lines = [
    ...(fence.anchor ? [line(fence.anchor, fence.anchor.label)] : []),
    ...fence.places.filter(place => place.id !== fence.anchor?.id).map(place => line(place)),
  ];
  return lines.join('\n');
}
