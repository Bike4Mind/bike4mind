import { FC, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Chip, Typography } from '@mui/joy';
import type { WebSearchPlace } from '@bike4mind/common';
import type { Map as LeafletMap } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useProxiedImage } from './SearchResultCards';
import { parseLocationMap, type LocationMapPlace, type ResolvedLocationMap } from './parseLocationMap';

/**
 * Renders the `b4m_map` fence as an inline map of pins beside a synced list of places. Pins come
 * from the web_search place citables (parseLocationMap), never from the fence text itself.
 *
 * Tiles are OpenStreetMap's, loaded directly (tile.openstreetmap.org is on the CSP img-src and
 * connect-src allowlists in apps/client/proxy.ts, which must track TILE_URL); their attribution is
 * required by the OSM tile policy.
 */

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const MAP_HEIGHT = 380;
const LIST_WIDTH = 320;
const THUMB_SIZE = 56;
// A lone pin (or a tight cluster) would otherwise zoom to street level on fitBounds.
const MAX_FIT_ZOOM = 16;

const ANCHOR_KEY = '__anchor__';

const STAR = '\u2605';

function formatRating(place: WebSearchPlace): string | undefined {
  return place.rating !== undefined ? place.rating.toFixed(1) : undefined;
}

function pinElement(text: string, anchor: boolean): HTMLElement {
  const el = document.createElement('div');
  // textContent, never innerHTML: the label is provider/model text.
  el.textContent = text;
  el.dataset.testid = anchor ? 'location-map-anchor-pin' : 'location-map-pin';
  Object.assign(el.style, {
    display: 'inline-block',
    transform: 'translate(-50%, -100%)',
    padding: '2px 8px',
    borderRadius: '12px',
    font: '600 12px/18px system-ui, sans-serif',
    whiteSpace: 'nowrap',
    boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
    cursor: 'pointer',
    transition: 'transform 0.15s, background 0.15s',
  });
  return el;
}

function stylePin(el: HTMLElement, anchor: boolean, active: boolean) {
  el.style.background = anchor ? '#c62828' : active ? '#1565c0' : '#ffffff';
  el.style.color = anchor || active ? '#ffffff' : '#1a1a1a';
  el.style.transform = `translate(-50%, -100%) scale(${active ? 1.15 : 1})`;
  el.style.zIndex = active ? '1000' : '';
}

interface MapPaneProps {
  map: ResolvedLocationMap;
  activeId?: string;
  selectedId?: string;
  onActivate: (id: string | undefined) => void;
  onSelect: (id: string) => void;
}

const MapPane: FC<MapPaneProps> = ({ map, activeId, selectedId, onActivate, onSelect }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const leafletRef = useRef<LeafletMap | undefined>(undefined);
  const pinsRef = useRef(new Map<string, { el: HTMLElement; anchor: boolean; lat: number; lng: number }>());

  useEffect(() => {
    let cancelled = false;
    const pins = pinsRef.current;

    // Leaflet touches `window` at import, so it is loaded on demand rather than with the reply bundle.
    void import('leaflet').then(({ default: L }) => {
      if (cancelled || !containerRef.current) return;
      // keyboard: Leaflet focuses the container on mousedown, which scrolls a partly hidden map into
      // view inside the chat - the pin slides out from under the cursor and the click is lost. The
      // list rows are the keyboard path instead.
      const leaflet = L.map(containerRef.current, { scrollWheelZoom: false, keyboard: false });
      leafletRef.current = leaflet;
      L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(leaflet);

      const entries: Array<{ key: string; place: WebSearchPlace; text: string; anchor: boolean }> = [
        ...(map.anchor
          ? [{ key: ANCHOR_KEY, place: map.anchor, text: map.anchor.label ?? map.anchor.name, anchor: true }]
          : []),
        ...map.places.map(place => ({ key: place.id, place, text: formatRating(place) ?? '\u2022', anchor: false })),
      ];
      for (const { key, place, text, anchor } of entries) {
        const el = pinElement(text, anchor);
        stylePin(el, anchor, false);
        el.title = place.name;
        el.addEventListener('mouseenter', () => onActivate(key));
        el.addEventListener('mouseleave', () => onActivate(undefined));
        el.addEventListener('click', () => onSelect(key));
        pins.set(key, { el, anchor, lat: place.lat, lng: place.lng });
        L.marker([place.lat, place.lng], {
          icon: L.divIcon({ html: el, className: '', iconSize: [0, 0] }),
          keyboard: false,
          zIndexOffset: anchor ? 500 : 0,
        }).addTo(leaflet);
      }

      const bounds = L.latLngBounds(entries.map(({ place }) => [place.lat, place.lng] as [number, number]));
      leaflet.fitBounds(bounds, { padding: [32, 32], maxZoom: MAX_FIT_ZOOM });
    });

    return () => {
      cancelled = true;
      leafletRef.current?.remove();
      leafletRef.current = undefined;
      pins.clear();
    };
    // onActivate/onSelect are state setters, so they never rebuild the map on their own.
  }, [map, onActivate, onSelect]);

  useEffect(() => {
    for (const [key, pin] of pinsRef.current) stylePin(pin.el, pin.anchor, key === activeId);
  }, [activeId]);

  useEffect(() => {
    const pin = selectedId ? pinsRef.current.get(selectedId) : undefined;
    if (pin) leafletRef.current?.panTo([pin.lat, pin.lng]);
  }, [selectedId]);

  return (
    <Box
      ref={containerRef}
      data-testid="location-map-pane"
      sx={{
        flex: '1 1 auto',
        minWidth: 0,
        height: MAP_HEIGHT,
        borderRadius: 'sm',
        overflow: 'hidden',
        bgcolor: 'background.level2',
        // Leaflet panes stack at z-index 400+, which would otherwise float above the app's menus.
        isolation: 'isolate',
      }}
    />
  );
};

const PlaceThumbnail: FC<{ url: string }> = ({ url }) => {
  const { src } = useProxiedImage(url);
  return (
    <Box
      sx={{
        flex: `0 0 ${THUMB_SIZE}px`,
        width: THUMB_SIZE,
        height: THUMB_SIZE,
        borderRadius: 'xs',
        overflow: 'hidden',
        bgcolor: 'background.level2',
      }}
    >
      {src && (
        <Box
          component="img"
          src={src}
          alt=""
          sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      )}
    </Box>
  );
};

interface PlaceRowProps {
  place: LocationMapPlace;
  rowKey: string;
  tag?: string;
  active: boolean;
  onActivate: (id: string | undefined) => void;
  onSelect: (id: string) => void;
}

const PlaceRow: FC<PlaceRowProps> = ({ place, rowKey, tag, active, onActivate, onSelect }) => {
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const row = rowRef.current;
    const list = row?.parentElement;
    if (!active || !row || !list) return;
    // Scrolls the list alone: scrollIntoView would also scroll the chat, sliding the map out from
    // under a hovered pin and clearing the hover it came from.
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    }
  }, [active]);

  const rating = formatRating(place);
  return (
    <Box
      ref={rowRef}
      role="button"
      tabIndex={0}
      data-testid="location-map-row"
      data-active={active ? 'true' : undefined}
      onMouseEnter={() => onActivate(rowKey)}
      onMouseLeave={() => onActivate(undefined)}
      onFocus={() => onActivate(rowKey)}
      onBlur={() => onActivate(undefined)}
      onClick={() => onSelect(rowKey)}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(rowKey);
        }
      }}
      sx={{
        display: 'flex',
        gap: 1,
        p: 1,
        borderRadius: 'sm',
        cursor: 'pointer',
        border: '1px solid',
        borderColor: active ? 'primary.outlinedBorder' : 'transparent',
        bgcolor: active ? 'background.level2' : 'transparent',
        whiteSpace: 'normal',
      }}
    >
      {place.thumbnail && <PlaceThumbnail url={place.thumbnail} />}
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
          <Typography level="title-sm" sx={{ color: 'text.primary', overflowWrap: 'anywhere' }}>
            {place.name}
          </Typography>
          {tag && (
            <Chip size="sm" color="danger" variant="soft" data-testid="location-map-anchor-tag">
              {tag}
            </Chip>
          )}
        </Box>
        {(rating || place.category) && (
          <Typography
            level="body-xs"
            data-testid="location-map-row-meta"
            sx={{ color: 'text.secondary', display: 'block' }}
          >
            {rating && `${rating} ${STAR}`}
            {rating && place.reviews !== undefined && ` (${place.reviews.toLocaleString()})`}
            {rating && place.category && ' \u00b7 '}
            {place.category}
          </Typography>
        )}
        {place.note && (
          <Typography
            level="body-sm"
            data-testid="location-map-row-note"
            sx={{ color: 'text.secondary', mt: 0.25, display: 'block' }}
          >
            {place.note}
          </Typography>
        )}
      </Box>
    </Box>
  );
};

const MapSkeleton: FC = () => (
  <Box
    data-testid="location-map-skeleton"
    sx={{
      height: MAP_HEIGHT,
      my: 2,
      borderRadius: 'sm',
      border: '1px solid',
      borderColor: 'divider',
      bgcolor: 'background.level1',
      opacity: 0.5,
    }}
  />
);

interface LocationMapProps {
  content: string;
  placesById: ReadonlyMap<string, WebSearchPlace>;
  /** See SearchResultCards' prop of the same name: once the reply is done, 'pending' means broken. */
  replyComplete?: boolean;
}

const LocationMap: FC<LocationMapProps> = ({ content, placesById, replyComplete }) => {
  const parsed = useMemo(() => parseLocationMap(content, placesById), [content, placesById]);
  // Every streamed chunk carries a freshly parsed quest, so placesById (and the parse) change
  // identity even when nothing did; keying on content keeps Leaflet from rebuilding each chunk.
  const mapKey = parsed.state === 'ok' ? JSON.stringify(parsed.map) : '';
  const stableMap = useMemo(() => (mapKey ? (JSON.parse(mapKey) as ResolvedLocationMap) : undefined), [mapKey]);
  const [hoveredId, setHoveredId] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();

  if (parsed.state === 'pending') return replyComplete ? null : <MapSkeleton />;
  if (parsed.state === 'invalid' || !stableMap) return null;

  const map = stableMap;
  const activeId = hoveredId ?? selectedId;
  return (
    <Box
      data-testid="location-map"
      sx={{
        display: 'flex',
        flexDirection: { xs: 'column', md: 'row' },
        gap: 1,
        my: 2,
        p: 1,
        borderRadius: 'md',
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.level1',
      }}
    >
      <MapPane
        map={map}
        activeId={activeId}
        selectedId={selectedId}
        onActivate={setHoveredId}
        onSelect={setSelectedId}
      />
      <Box
        data-testid="location-map-list"
        sx={{
          flex: { xs: '0 0 auto', md: `0 0 ${LIST_WIDTH}px` },
          width: { md: LIST_WIDTH },
          maxHeight: MAP_HEIGHT,
          overflowY: 'auto',
          // Makes each row's offsetTop relative to this list, for PlaceRow's scroll-into-view.
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          gap: 0.5,
        }}
      >
        {map.anchor && (
          <PlaceRow
            place={map.anchor}
            rowKey={ANCHOR_KEY}
            tag={map.anchor.label ?? 'Reference'}
            active={activeId === ANCHOR_KEY}
            onActivate={setHoveredId}
            onSelect={setSelectedId}
          />
        )}
        {map.places.map(place => (
          <PlaceRow
            key={place.id}
            place={place}
            rowKey={place.id}
            active={activeId === place.id}
            onActivate={setHoveredId}
            onSelect={setSelectedId}
          />
        ))}
      </Box>
    </Box>
  );
};

export default LocationMap;
