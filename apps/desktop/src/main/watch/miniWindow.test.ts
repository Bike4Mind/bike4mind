import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {}, screen: {}, shell: {} }));
vi.mock('../windows', () => ({ markCompanionWindow: vi.fn() }));

const { MINI_MIN_SIZE, restoreBounds } = await import('./miniWindow');

const laptop = { x: 0, y: 25, width: 1440, height: 850 };
const external = { x: 1440, y: 0, width: 1920, height: 1080 };

describe('restoreBounds', () => {
  it('keeps bounds that already sit inside a screen', () => {
    const saved = { x: 100, y: 200, width: 420, height: 300 };
    expect(restoreBounds(saved, [laptop])).toEqual(saved);
  });

  it('drops bounds that overlap no screen, e.g. an unplugged display', () => {
    expect(restoreBounds({ x: 4000, y: 100, width: 420, height: 300 }, [laptop])).toBeNull();
  });

  it('moves the drag strip out from under a menu bar that grew', () => {
    expect(restoreBounds({ x: 100, y: 10, width: 420, height: 300 }, [laptop])).toEqual({
      x: 100,
      y: laptop.y,
      width: 420,
      height: 300,
    });
  });

  it('pulls a window mostly off the edge fully onto the screen it overlaps most', () => {
    expect(restoreBounds({ x: 3200, y: 900, width: 420, height: 300 }, [laptop, external])).toEqual({
      x: external.x + external.width - 420,
      y: external.y + external.height - 300,
      width: 420,
      height: 300,
    });
  });

  it('grows a window below the minimum and shrinks one larger than the screen', () => {
    expect(restoreBounds({ x: 0, y: 25, width: 10, height: 10 }, [laptop])).toMatchObject(MINI_MIN_SIZE);
    expect(restoreBounds({ x: 0, y: 25, width: 5000, height: 5000 }, [laptop])).toEqual(laptop);
  });
});
