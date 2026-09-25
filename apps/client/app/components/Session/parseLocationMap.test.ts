import { describe, expect, it } from 'vitest';
import type { CitableSource, WebSearchPlace } from '@bike4mind/common';
import { parseLocationMap, placesFromCitables } from './parseLocationMap';

const place = (id: string, name: string): WebSearchPlace => ({ id, name, lat: 55.6, lng: 12.5 });
const placesById = new Map([place('a', 'Barr'), place('b', 'Kadeau'), place('hotel', 'citizenM')].map(p => [p.id, p]));

describe('placesFromCitables', () => {
  it('keys only citables carrying a located place', () => {
    const citables = [
      { id: 'https://x.com', type: 'web_url', title: 'x' },
      { id: 'place:a', type: 'web_url', title: 'Barr', metadata: { place: place('a', 'Barr') } },
    ] as CitableSource[];
    expect([...placesFromCitables(citables).keys()]).toEqual(['a']);
    expect(placesFromCitables(undefined).size).toBe(0);
  });
});

describe('parseLocationMap', () => {
  it('resolves ids to the stored places, carrying the model note but never its coordinates', () => {
    const parsed = parseLocationMap(
      '{"anchor":{"id":"hotel","label":"Your hotel"},"places":[{"id":"a","note":"great","lat":0,"lng":0},{"id":"made-up"},{"id":"hotel"}]}',
      placesById
    );
    expect(parsed).toEqual({
      state: 'ok',
      map: {
        anchor: { ...place('hotel', 'citizenM'), note: undefined, label: 'Your hotel' },
        places: [{ ...place('a', 'Barr'), note: 'great' }],
      },
    });
  });

  it('is pending while the fence is still streaming and invalid once it closes broken', () => {
    expect(parseLocationMap('', placesById)).toEqual({ state: 'pending' });
    expect(parseLocationMap('{"places":[{"id":"a"', placesById)).toEqual({ state: 'pending' });
    expect(parseLocationMap('{"places":[1,]}', placesById)).toEqual({ state: 'invalid' });
  });

  it('is invalid when no listed place resolves, even with a resolved anchor', () => {
    expect(parseLocationMap('{"anchor":{"id":"hotel"},"places":[{"id":"nope"}]}', placesById)).toEqual({
      state: 'invalid',
    });
  });
});
