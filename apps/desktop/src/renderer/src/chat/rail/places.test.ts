// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPlaceMemory, writePlaceMemory } from './places';

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('place memory', () => {
  it('restores the last place and the last item open in each one', () => {
    writePlaceMemory({ place: 'studio', chat: 'c1', code: 'k1', studio: 'productions' });
    expect(readPlaceMemory()).toEqual({ place: 'studio', chat: 'c1', code: 'k1', studio: 'productions' });
  });

  it('restores the Studio session Create last saved into', () => {
    writePlaceMemory({ place: 'library' });
    expect(readPlaceMemory()).toEqual({ place: 'library' });
    writePlaceMemory({ place: 'studio', studio: 'library' });
    expect(readPlaceMemory()).toEqual({ place: 'studio', studio: 'library' });
    writePlaceMemory({ place: 'studio', studio: 'create', studioSession: 's1' });
    expect(readPlaceMemory()).toEqual({ place: 'studio', studio: 'create', studioSession: 's1' });
  });

  it('starts fresh on nothing stored, a value it cannot read, or a place it does not know', () => {
    expect(readPlaceMemory()).toBeNull();
    window.localStorage.setItem('b4m.chat.places', '{not json');
    expect(readPlaceMemory()).toBeNull();
    window.localStorage.setItem('b4m.chat.places', JSON.stringify({ place: 'nowhere' }));
    expect(readPlaceMemory()).toBeNull();
  });

  it('restores the Agents place', () => {
    writePlaceMemory({ place: 'agents', chat: 'c1' });
    expect(readPlaceMemory()).toEqual({ place: 'agents', chat: 'c1' });
  });

  it('drops fields of the wrong shape rather than the whole memory', () => {
    window.localStorage.setItem('b4m.chat.places', JSON.stringify({ place: 'code', chat: 4, studio: 'timeline' }));
    expect(readPlaceMemory()).toEqual({ place: 'code' });
  });

  it('survives blocked storage both ways', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => writePlaceMemory({ place: 'chat' })).not.toThrow();
    expect(readPlaceMemory()).toBeNull();
  });
});
