import type { CitableSource } from '../types/entities/CitableSourceTypes';

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
 * Builds the same id -> place lookup the live map widget resolves the fence against
 * (apps/client's parseLocationMap.ts re-exports this), so every surface agrees on what a fence
 * entry's `id` actually names.
 */
export function placesFromCitables(citables: CitableSource[] | undefined): Map<string, WebSearchPlace> {
  const byId = new Map<string, WebSearchPlace>();
  for (const citable of citables ?? []) {
    const place = citable.metadata?.place;
    if (place && Number.isFinite(place.lat) && Number.isFinite(place.lng)) byId.set(place.id, place);
  }
  return byId;
}

/**
 * The fence rewritten as a markdown list with "open in maps" links, for a surface that cannot
 * render the map widget. Empty when the body is not a usable fence, so a broken block disappears
 * rather than leaking JSON.
 *
 * Each entry is resolved against `placesById` (the stored provider places) exactly like the live
 * widget: an id the model invented, or that names no known place, is dropped rather than
 * rendered from the model's own (unverified) name/id - otherwise this fallback path could tell
 * the user something the map itself refused to show.
 */
export function locationMapFallbackMarkdown(body: string, placesById: ReadonlyMap<string, WebSearchPlace>): string {
  const fence = parseLocationMapFence(body);
  if (!fence) return '';
  const line = (entry: LocationMapFenceEntry, place: WebSearchPlace, tag?: string) => {
    const note = entry.note ? ` - ${entry.note}` : '';
    const label = tag ? ` (${tag})` : '';
    return `- **${place.name}**${label}${note} ([Open in Google Maps](${googleMapsSearchUrl(place.name, place.id)}))`;
  };

  const anchorPlace = fence.anchor && placesById.get(fence.anchor.id);
  const anchorLine = fence.anchor && anchorPlace ? [line(fence.anchor, anchorPlace, fence.anchor.label)] : [];

  const placeLines = fence.places
    .filter(entry => entry.id !== fence.anchor?.id)
    .map(entry => {
      const place = placesById.get(entry.id);
      return place ? line(entry, place) : undefined;
    })
    .filter((rendered): rendered is string => rendered !== undefined);

  return [...anchorLine, ...placeLines].join('\n');
}
