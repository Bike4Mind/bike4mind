import { describe, expect, it } from 'vitest';
import {
  googleMapsSearchUrl,
  locationMapFallbackMarkdown,
  parseLocationMapFence,
  placesFromCitables,
  type WebSearchPlace,
} from './locationMap';
import type { CitableSource } from '../types/entities/CitableSourceTypes';

const place = (overrides: Partial<WebSearchPlace> = {}): WebSearchPlace => ({
  id: 'ChIJcm',
  name: 'citizenM',
  lat: 55.67,
  lng: 12.57,
  ...overrides,
});

describe('parseLocationMapFence', () => {
  it('reads the anchor and places, deduping ids and normalizing whitespace', () => {
    const fence = parseLocationMapFence(
      JSON.stringify({
        anchor: { id: 'ChIJcm', name: 'citizenM', label: 'Your hotel' },
        places: [
          { id: 'ChIJa', name: 'Barr', note: 'Nordic\n  seafood' },
          { id: 'ChIJa', name: 'Barr again' },
          { name: 'no id' },
          'junk',
        ],
      })
    );
    expect(fence).toEqual({
      anchor: { id: 'ChIJcm', name: 'citizenM', note: undefined, label: 'Your hotel' },
      places: [{ id: 'ChIJa', name: 'Barr', note: 'Nordic seafood' }],
    });
  });

  it('is null for malformed JSON, a missing places array, or nothing usable', () => {
    expect(parseLocationMapFence('{"places":[')).toBeNull();
    expect(parseLocationMapFence('{"anchor":{"id":"a"}}')).toBeNull();
    expect(parseLocationMapFence('{"places":[{"name":"x"}]}')).toBeNull();
  });

  it('ignores any coordinates the model wrote', () => {
    const fence = parseLocationMapFence('{"places":[{"id":"a","lat":1,"lng":2}]}');
    expect(fence?.places[0]).toEqual({ id: 'a', name: undefined, note: undefined });
  });
});

describe('googleMapsSearchUrl', () => {
  it('pins a Google place id and searches by name for anything else', () => {
    expect(googleMapsSearchUrl('Barr', 'ChIJa')).toBe(
      'https://www.google.com/maps/search/?api=1&query=Barr&query_place_id=ChIJa'
    );
    expect(googleMapsSearchUrl('Tivoli Gardens', 'way/1')).toBe(
      'https://www.google.com/maps/search/?api=1&query=Tivoli+Gardens'
    );
  });
});

describe('locationMapFallbackMarkdown', () => {
  const placesById = new Map<string, WebSearchPlace>([
    ['ChIJcm', place({ id: 'ChIJcm', name: 'citizenM' })],
    ['ChIJa', place({ id: 'ChIJa', name: 'Barr' })],
  ]);

  it('renders the anchor first, tagged, then each place with an open-in-maps link', () => {
    const markdown = locationMapFallbackMarkdown(
      JSON.stringify({
        anchor: { id: 'ChIJcm', name: 'citizenM', label: 'Your hotel' },
        places: [
          { id: 'ChIJcm', name: 'citizenM' },
          { id: 'ChIJa', name: 'Barr', note: 'Nordic seafood' },
        ],
      }),
      placesById
    );
    expect(markdown).toBe(
      [
        '- **citizenM** (Your hotel) ([Open in Google Maps](https://www.google.com/maps/search/?api=1&query=citizenM&query_place_id=ChIJcm))',
        '- **Barr** - Nordic seafood ([Open in Google Maps](https://www.google.com/maps/search/?api=1&query=Barr&query_place_id=ChIJa))',
      ].join('\n')
    );
  });

  it('is empty for an unusable fence', () => {
    expect(locationMapFallbackMarkdown('not json', placesById)).toBe('');
  });

  it('drops an entry whose id the model invented, rather than trusting its name', () => {
    const markdown = locationMapFallbackMarkdown(
      JSON.stringify({
        places: [
          { id: 'ChIJa', name: 'Barr' },
          { id: 'invented-id', name: 'Not a real place' },
        ],
      }),
      placesById
    );
    expect(markdown).toBe(
      '- **Barr** ([Open in Google Maps](https://www.google.com/maps/search/?api=1&query=Barr&query_place_id=ChIJa))'
    );
  });

  it('takes the display name from the resolved place, not an id-only entry', () => {
    const markdown = locationMapFallbackMarkdown(JSON.stringify({ places: [{ id: 'ChIJa' }] }), placesById);
    expect(markdown).toBe(
      '- **Barr** ([Open in Google Maps](https://www.google.com/maps/search/?api=1&query=Barr&query_place_id=ChIJa))'
    );
  });

  it('drops the anchor entirely when its id does not resolve', () => {
    const markdown = locationMapFallbackMarkdown(
      JSON.stringify({
        anchor: { id: 'invented-id', name: 'Fake hotel', label: 'Your hotel' },
        places: [{ id: 'ChIJa', name: 'Barr' }],
      }),
      placesById
    );
    expect(markdown).toBe(
      '- **Barr** ([Open in Google Maps](https://www.google.com/maps/search/?api=1&query=Barr&query_place_id=ChIJa))'
    );
  });
});

describe('placesFromCitables', () => {
  it('keys places by id, skipping citables with no place or non-finite coordinates', () => {
    const citables = [
      { id: 'c1', type: 'web_url', title: 'x', metadata: { place: place({ id: 'ChIJa' }) } },
      { id: 'c2', type: 'web_url', title: 'y' },
      { id: 'c3', type: 'web_url', title: 'z', metadata: { place: place({ id: 'bad', lat: NaN }) } },
    ] as CitableSource[];

    const byId = placesFromCitables(citables);
    expect([...byId.keys()]).toEqual(['ChIJa']);
  });

  it('is empty for undefined citables', () => {
    expect(placesFromCitables(undefined).size).toBe(0);
  });
});
