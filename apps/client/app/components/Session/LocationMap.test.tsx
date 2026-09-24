import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import Typography from '@mui/joy/Typography';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { WebSearchPlace } from '@bike4mind/common';
import { getThemeConfig } from '../../utils/themes';
import LocationMap from './LocationMap';
import { LOCATION_MAP_LANGUAGE } from './parseLocationMap';
import { createCodeComponent, ReplyCompleteContext, ReplyPlacesContext } from './PromptReplies';
import { getMarkdownSyntaxTheme } from './markdown/syntaxTheme';

// See SearchResultCards.test.tsx: importing PromptReplies registers interceptors on this mock.
vi.mock('@client/app/contexts/apiClient', () => ({
  api: { get: vi.fn(), interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } } },
  isPublicPath: () => false,
}));
import { api } from '@client/app/contexts/apiClient';

// jsdom has no layout, so Leaflet is replaced by a stand-in that drops each marker's pin element
// straight into the map container - enough to exercise pin/list sync without real tiles.
const leaflet = vi.hoisted(() => {
  const calls = { panTo: vi.fn(), fitBounds: vi.fn(), remove: vi.fn(), markers: [] as unknown[] };
  let container: HTMLElement | undefined;
  const L = {
    map: vi.fn((el: HTMLElement) => {
      container = el;
      return { fitBounds: calls.fitBounds, panTo: calls.panTo, remove: calls.remove };
    }),
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
    divIcon: vi.fn((options: unknown) => options),
    marker: vi.fn((latLng: unknown, options: { icon: { html: HTMLElement } }) => {
      calls.markers.push(latLng);
      return { addTo: () => container?.appendChild(options.icon.html) };
    }),
    latLngBounds: vi.fn((points: unknown) => ({ points })),
  };
  return { L, calls };
});
vi.mock('leaflet', () => ({ default: leaflet.L }));

const place = (id: string, name: string, lat: number, extra: Partial<WebSearchPlace> = {}): WebSearchPlace => ({
  id,
  name,
  lat,
  lng: 12.5,
  ...extra,
});
const placesById = new Map(
  [
    place('a', 'Barr', 55.1, { rating: 4.6, reviews: 1234, category: 'Restaurant' }),
    place('b', 'Kadeau', 55.2),
    place('hotel', 'citizenM', 55.3),
  ].map(p => [p.id, p])
);

const FENCE =
  '{"anchor":{"id":"hotel","label":"Your hotel"},"places":[{"id":"a","note":"Nordic seafood","lat":1,"lng":1},{"id":"b"},{"id":"invented"}]}';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderMap = (content: string, replyComplete = false) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <LocationMap content={content} placesById={placesById} replyComplete={replyComplete} />
    </CssVarsProvider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  leaflet.calls.markers.length = 0;
  vi.mocked(api.get).mockResolvedValue({ data: new Blob([new Uint8Array([1])]) } as never);
});

describe('LocationMap', () => {
  it('pins every resolved place from its stored coordinates and lists it, anchor first and tagged', async () => {
    renderMap(FENCE);

    await waitFor(() => expect(screen.getAllByTestId('location-map-pin')).toHaveLength(2));
    expect(screen.getByTestId('location-map-anchor-pin')).toHaveTextContent('Your hotel');
    expect(screen.getAllByTestId('location-map-pin').map(pin => pin.textContent)).toEqual(['4.6', '\u2022']);
    // Coordinates come from the citables; the fence's own lat/lng are ignored.
    expect(leaflet.calls.markers).toEqual([
      [55.3, 12.5],
      [55.1, 12.5],
      [55.2, 12.5],
    ]);
    expect(leaflet.calls.fitBounds).toHaveBeenCalledTimes(1);
    expect(leaflet.L.map).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ keyboard: false }));

    const rows = screen.getAllByTestId('location-map-row');
    expect(rows.map(row => row.textContent)).toEqual([
      expect.stringContaining('citizenM'),
      expect.stringContaining('Barr'),
      expect.stringContaining('Kadeau'),
    ]);
    expect(screen.getByTestId('location-map-anchor-tag')).toHaveTextContent('Your hotel');
    expect(rows[1]).toHaveTextContent('4.6 \u2605 (1,234) \u00b7 Restaurant');
    expect(rows[1]).toHaveTextContent('Nordic seafood');
    expect(screen.queryByText('invented')).toBeNull();
  });

  it('highlights a pin from its row and a row from its pin', async () => {
    renderMap(FENCE);
    const pins = await screen.findAllByTestId('location-map-pin');
    const rows = screen.getAllByTestId('location-map-row');

    fireEvent.mouseEnter(rows[1]);
    expect(pins[0].style.background).toBe('rgb(21, 101, 192)');
    expect(rows[1]).toHaveAttribute('data-active', 'true');
    fireEvent.mouseLeave(rows[1]);
    expect(pins[0].style.background).toBe('rgb(255, 255, 255)');

    fireEvent.mouseEnter(pins[1]);
    await waitFor(() => expect(rows[2]).toHaveAttribute('data-active', 'true'));
  });

  // A reply's markdown wraps the map in a Typography, which makes Joy render nested Typography as
  // inline spans - the category line and the note then ran together as one line.
  it('keeps the category line and the note on their own lines inside a reply Typography', async () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <Typography>
          <LocationMap content={FENCE} placesById={placesById} replyComplete />
        </Typography>
      </CssVarsProvider>
    );

    const row = (await screen.findAllByTestId('location-map-row'))[1];
    for (const testId of ['location-map-row-meta', 'location-map-row-note']) {
      const line = within(row).getByTestId(testId);
      expect(line.tagName).toBe('SPAN');
      expect(getComputedStyle(line).display).toBe('block');
    }
  });

  it('pans to a place when its row is clicked', async () => {
    renderMap(FENCE);
    await screen.findAllByTestId('location-map-pin');

    fireEvent.click(screen.getAllByTestId('location-map-row')[2]);

    expect(leaflet.calls.panTo).toHaveBeenCalledWith([55.2, 12.5]);
  });

  it('keeps the same Leaflet map when a streamed chunk re-sends identical places', async () => {
    const { rerender } = renderMap(FENCE);
    await screen.findAllByTestId('location-map-pin');

    rerender(
      <CssVarsProvider theme={appTheme}>
        <LocationMap content={FENCE} placesById={new Map(placesById)} />
      </CssVarsProvider>
    );

    expect(leaflet.L.map).toHaveBeenCalledTimes(1);
    expect(leaflet.calls.remove).not.toHaveBeenCalled();
  });

  it('holds a skeleton while streaming, and renders nothing once complete or broken', () => {
    const { unmount } = renderMap('{"places":[{"id":"a"');
    expect(screen.getByTestId('location-map-skeleton')).toBeInTheDocument();
    unmount();

    renderMap('{"places":[{"id":"a"', true);
    expect(screen.queryByTestId('location-map-skeleton')).toBeNull();
    expect(screen.queryByTestId('location-map')).toBeNull();

    renderMap('{"places":[1,]}');
    expect(screen.queryByTestId('location-map-skeleton')).toBeNull();
    expect(screen.queryByTestId('location-map')).toBeNull();
    expect(screen.queryByText(/places/)).toBeNull();
  });

  it('renders inline where the model placed the fence in a reply', async () => {
    const markdown = ['Dinner near your hotel:', '', '```' + LOCATION_MAP_LANGUAGE, FENCE, '```', '', 'Enjoy.'].join(
      '\n'
    );
    render(
      <CssVarsProvider theme={appTheme}>
        <ReplyCompleteContext.Provider value>
          <ReplyPlacesContext.Provider value={placesById}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{ code: createCodeComponent(getMarkdownSyntaxTheme('dark')) }}
            >
              {markdown}
            </ReactMarkdown>
          </ReplyPlacesContext.Provider>
        </ReplyCompleteContext.Provider>
      </CssVarsProvider>
    );

    expect(await screen.findByTestId('location-map')).toBeInTheDocument();
    expect(screen.queryByText(/"anchor"/)).toBeNull();
  });
});
