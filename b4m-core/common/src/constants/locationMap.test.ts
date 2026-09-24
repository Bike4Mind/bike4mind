import { describe, expect, it } from 'vitest';
import { googleMapsSearchUrl, locationMapFallbackMarkdown, parseLocationMapFence } from './locationMap';

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
  it('renders the anchor first, tagged, then each place with an open-in-maps link', () => {
    const markdown = locationMapFallbackMarkdown(
      JSON.stringify({
        anchor: { id: 'ChIJcm', name: 'citizenM', label: 'Your hotel' },
        places: [
          { id: 'ChIJcm', name: 'citizenM' },
          { id: 'ChIJa', name: 'Barr', note: 'Nordic seafood' },
        ],
      })
    );
    expect(markdown).toBe(
      [
        '- **citizenM** (Your hotel) ([Open in Google Maps](https://www.google.com/maps/search/?api=1&query=citizenM&query_place_id=ChIJcm))',
        '- **Barr** - Nordic seafood ([Open in Google Maps](https://www.google.com/maps/search/?api=1&query=Barr&query_place_id=ChIJa))',
      ].join('\n')
    );
  });

  it('is empty for an unusable fence', () => {
    expect(locationMapFallbackMarkdown('not json')).toBe('');
  });
});
