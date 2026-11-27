// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIND_CURRENT_HIGHLIGHT, FIND_HIGHLIGHT, clearMatches, paintMatches, scopeRanges } from './findHighlight';
import { findPattern } from './threadFind';

const html = (markup: string) => {
  const root = document.createElement('div');
  root.innerHTML = markup;
  return root;
};

describe('scopeRanges', () => {
  it('matches across inline markup as one range', () => {
    const root = html('<div data-find-scope="a">say <b>nee</b>dle twice: needle</div>');
    const ranges = scopeRanges(root.firstElementChild!, findPattern('needle', false)!);
    expect(ranges.map(range => range.toString())).toEqual(['needle', 'needle']);
  });

  it('leaves text that belongs to a nested scope to that scope', () => {
    const root = html('<div data-find-scope="round">needle <div data-find-scope="tool">needle needle</div></div>');
    const [round, tool] = root.querySelectorAll('[data-find-scope]');
    expect(scopeRanges(round!, findPattern('needle', false)!)).toHaveLength(1);
    expect(scopeRanges(tool!, findPattern('needle', false)!)).toHaveLength(2);
  });
});

describe('paintMatches', () => {
  const registry = new Map<string, Range[]>();

  afterEach(() => {
    vi.unstubAllGlobals();
    registry.clear();
  });

  const stubHighlightApi = () => {
    vi.stubGlobal('CSS', {
      highlights: {
        set: (name: string, highlight: { ranges: Range[] }) => registry.set(name, highlight.ranges),
        delete: (name: string) => registry.delete(name),
      },
    });
    vi.stubGlobal(
      'Highlight',
      class {
        ranges: Range[];
        constructor(...ranges: Range[]) {
          this.ranges = ranges;
        }
      }
    );
  };

  it('paints every drawn match and returns the current one, clamped to what its scope draws', () => {
    stubHighlightApi();
    const root = html('<p data-find-scope="a">needle</p><p data-find-scope="b">needle and needle</p><p>needle</p>');
    const current = paintMatches(root, findPattern('needle', false)!, { scope: 'b', occurrence: 5 });
    expect(registry.get(FIND_HIGHLIGHT)).toHaveLength(3);
    expect(registry.get(FIND_CURRENT_HIGHLIGHT)).toEqual([current]);
    expect(current?.startContainer.parentElement?.getAttribute('data-find-scope')).toBe('b');
    expect(current?.startOffset).toBe('needle and '.length);

    clearMatches();
    expect(registry.size).toBe(0);
  });

  it('returns null while the current scope is not drawn yet, and is a no-op without the API', () => {
    const root = html('<p data-find-scope="a">needle</p>');
    expect(paintMatches(root, findPattern('needle', false)!, { scope: 'missing', occurrence: 0 })).toBeNull();
    expect(paintMatches(root, findPattern('needle', false)!, { scope: 'a', occurrence: 0 })?.toString()).toBe('needle');
  });
});
