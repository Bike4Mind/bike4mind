/**
 * Resolves the `b4m_map` fence the model emits inline in a reply against the places web_search
 * stored as citables. The fence names places by id only; every coordinate, rating and thumbnail
 * comes from the citable (`metadata.place`), so a model-invented id simply drops out.
 *
 * Same streaming contract as parseSearchResultCards: 'pending' while the fence could still become
 * valid, 'invalid' once it is complete but unusable, and never raw JSON.
 */

import { parseLocationMapFence, type CitableSource, type WebSearchPlace } from '@bike4mind/common';
import { isStructurallyClosed } from './parseSearchResultCards';

export { LOCATION_MAP_LANGUAGE } from '@bike4mind/common';

export interface LocationMapPlace extends WebSearchPlace {
  note?: string;
}

export interface LocationMapAnchor extends LocationMapPlace {
  label?: string;
}

export interface ResolvedLocationMap {
  anchor?: LocationMapAnchor;
  places: LocationMapPlace[];
}

export type ParsedLocationMap = { state: 'ok'; map: ResolvedLocationMap } | { state: 'pending' } | { state: 'invalid' };

export function placesFromCitables(citables: CitableSource[] | undefined): Map<string, WebSearchPlace> {
  const byId = new Map<string, WebSearchPlace>();
  for (const citable of citables ?? []) {
    const place = citable.metadata?.place;
    if (place && Number.isFinite(place.lat) && Number.isFinite(place.lng)) byId.set(place.id, place);
  }
  return byId;
}

export function parseLocationMap(content: string, placesById: ReadonlyMap<string, WebSearchPlace>): ParsedLocationMap {
  const trimmed = content.trim();
  if (!trimmed) return { state: 'pending' };

  const fence = parseLocationMapFence(trimmed);
  if (!fence) return isStructurallyClosed(trimmed) ? { state: 'invalid' } : { state: 'pending' };

  const anchorPlace = fence.anchor && placesById.get(fence.anchor.id);
  const anchor = anchorPlace ? { ...anchorPlace, note: fence.anchor?.note, label: fence.anchor?.label } : undefined;

  const places: LocationMapPlace[] = [];
  for (const entry of fence.places) {
    const place = placesById.get(entry.id);
    if (!place || place.id === anchor?.id) continue;
    places.push({ ...place, note: entry.note });
  }

  // An anchor on its own answers nothing - the map exists to compare places against it.
  return places.length > 0 ? { state: 'ok', map: { ...(anchor ? { anchor } : {}), places } } : { state: 'invalid' };
}
