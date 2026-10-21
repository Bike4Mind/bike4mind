// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishScrollGutterWidth, SCROLL_GUTTER_VAR, scrollingColumnHostSx, thinScrollbarSx } from './layout';

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty(SCROLL_GUTTER_VAR);
});

describe('publishScrollGutterWidth', () => {
  it('measures a probe wearing the thin scrollbar the gutter-spending scrollers use', () => {
    const appended: HTMLElement[] = [];
    const append = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      appended.push(node as unknown as HTMLElement);
      return append(node);
    });

    publishScrollGutterWidth();

    expect(appended).toHaveLength(1);
    const probe = appended[0];
    expect(probe.style.overflow).toBe('scroll');
    expect(probe.style.scrollbarWidth).toBe(thinScrollbarSx.scrollbarWidth);
    expect(probe.isConnected).toBe(false);
    expect(document.documentElement.style.getPropertyValue(SCROLL_GUTTER_VAR)).toBe('0px');
  });
});

describe('thinScrollbarSx', () => {
  it('is worn by the gutter-spending column host, so the measured width is the one it draws', () => {
    expect(scrollingColumnHostSx).toMatchObject(thinScrollbarSx);
  });

  // The transcript gets it through scrollingColumnHostSx; the sidebar spreads it directly.
  it('is shared by the sidebar and the transcript rather than restated in either', () => {
    const sources = import.meta.glob<string>(['./**/*.{ts,tsx}', '!./**/*.test.{ts,tsx}', '!./layout.ts'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });

    expect(sources['./SessionList.tsx']).toContain('...thinScrollbarSx');
    expect(sources['./MessageThread.tsx']).toContain('...scrollingColumnHostSx');

    const restated = Object.keys(sources).filter(file => /scrollbar(Width|Color)\s*:/.test(sources[file]));
    expect(restated).toEqual([]);
  });
});
