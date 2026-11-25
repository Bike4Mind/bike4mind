import { describe, expect, it } from 'vitest';
import {
  FALLBACK_PANE_VIEW,
  MIN_PANE_FRACTION,
  addPinnedPane,
  applyPreset,
  fitSizes,
  parseLayout,
  parseStoredLayout,
  presetOf,
  layoutsEqual,
  resizePanes,
  setPaneSession,
  setPaneView,
  singlePaneLayout,
  withoutPins,
  type OrchestratorLayout,
} from './orchestratorLayout';

const sideBySide: OrchestratorLayout = {
  split: 'row',
  panes: [
    { view: 'board', size: 0.5 },
    { view: 'transit', size: 0.5 },
  ],
};

function sizes(layout: OrchestratorLayout | undefined): number[] {
  return layout?.panes.map(pane => pane.size) ?? [];
}

const pinned: OrchestratorLayout = {
  split: 'row',
  panes: [
    { view: 'board', size: 0.5 },
    { view: 'transit', size: 0.5, sessionId: 'other' },
  ],
};

describe('orchestratorLayout', () => {
  describe('session pins', () => {
    it('parses a pane pinned to a session', () => {
      expect(parseLayout(pinned)).toEqual(pinned);
      expect(parseStoredLayout(JSON.stringify(pinned))).toEqual(pinned);
    });

    it('parses a stored layout from before pins exactly as before, with no sessionId key', () => {
      const parsed = parseLayout(sideBySide);
      expect(parsed).toEqual(sideBySide);
      expect(parsed?.panes.every(pane => !('sessionId' in pane))).toBe(true);
    });

    it.each([
      ['an empty string', ''],
      ['a number', 42],
      ['null', null],
    ])('drops a pin that is %s and keeps the pane and the layout', (_label, sessionId) => {
      const parsed = parseLayout({
        split: 'row',
        panes: [
          { view: 'board', size: 0.5 },
          { view: 'transit', size: 0.5, sessionId },
        ],
      });
      expect(parsed).toEqual(sideBySide);
      expect(parsed?.panes[1]).not.toHaveProperty('sessionId');
    });

    it('keeps a pin through the unknown-view fallback', () => {
      const parsed = parseLayout({ split: 'row', panes: [{ view: 'hologram', size: 1, sessionId: 's9' }] });
      expect(parsed?.panes[0]).toEqual({ view: FALLBACK_PANE_VIEW, size: 1, sessionId: 's9' });
    });

    it('setPaneSession pins one pane and undefined unpins it', () => {
      const set = setPaneSession(sideBySide, 1, 'other');
      expect(set).toEqual(pinned);
      const cleared = setPaneSession(set, 1, undefined);
      expect(cleared).toEqual(sideBySide);
      expect(cleared.panes[1]).not.toHaveProperty('sessionId');
      expect(setPaneSession(sideBySide, 5, 'other')).toBe(sideBySide);
    });

    it('withoutPins drops every pin and keeps views and sizes', () => {
      expect(withoutPins(pinned)).toEqual(sideBySide);
      expect(withoutPins(sideBySide)).toBe(sideBySide);
    });

    it('layoutsEqual tells a pinned pane from an unpinned one', () => {
      expect(layoutsEqual(pinned, sideBySide)).toBe(false);
      expect(layoutsEqual(pinned, { ...pinned })).toBe(true);
    });

    it('applyPreset keeps pins on the panes it keeps, and drops the pin when going to one pane', () => {
      expect(applyPreset(pinned, 'three-across').panes.map(pane => pane.sessionId)).toEqual([
        undefined,
        'other',
        undefined,
      ]);
      const single = applyPreset(setPaneSession(pinned, 0, 'first'), 'single');
      expect(single.panes).toEqual([{ view: 'board', size: 1 }]);
    });
  });

  describe('parseLayout', () => {
    it('accepts a row or column of one to three registered views', () => {
      expect(parseLayout(sideBySide)).toEqual(sideBySide);
      expect(parseLayout({ ...sideBySide, split: 'column' })?.split).toBe('column');
      expect(parseLayout(singlePaneLayout('tavern'))).toEqual(singlePaneLayout('tavern'));
      const three = {
        split: 'row',
        panes: [
          { view: 'board', size: 1 },
          { view: 'table', size: 1 },
          { view: 'constellation', size: 1 },
        ],
      };
      expect(parseLayout(three)?.panes.map(pane => pane.view)).toEqual(['board', 'table', 'constellation']);
    });

    it('turns an unknown or removed view id into Board and keeps the rest', () => {
      const parsed = parseLayout({
        split: 'row',
        panes: [
          { view: 'hologram', size: 0.5 },
          { view: 'transit', size: 0.5 },
        ],
      });
      expect(parsed?.panes.map(pane => pane.view)).toEqual([FALLBACK_PANE_VIEW, 'transit']);
      expect(FALLBACK_PANE_VIEW).toBe('board');
    });

    it.each([
      ['not an object', 'board'],
      ['null', null],
      ['an unknown split', { split: 'grid', panes: [{ view: 'board', size: 1 }] }],
      ['no panes', { split: 'row', panes: [] }],
      [
        'more than three panes',
        { split: 'row', panes: ['board', 'table', 'transit', 'tavern'].map(view => ({ view, size: 1 })) },
      ],
      ['a zero size', { split: 'row', panes: [{ view: 'board', size: 0 }] }],
      ['a negative size', { split: 'row', panes: [{ view: 'board', size: -1 }] }],
      ['a size that is not a number', { split: 'row', panes: [{ view: 'board', size: '1' }] }],
      ['a pane without a view', { split: 'row', panes: [{ size: 1 }] }],
    ])('rejects %s', (_label, value) => {
      expect(parseLayout(value)).toBeUndefined();
    });

    it('refits sizes to sum to 1 with no pane under the minimum', () => {
      const parsed = parseLayout({
        split: 'row',
        panes: [
          { view: 'board', size: 98 },
          { view: 'transit', size: 1 },
          { view: 'table', size: 1 },
        ],
      });
      const fitted = sizes(parsed);
      expect(fitted.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1);
      expect(fitted[1]).toBeCloseTo(MIN_PANE_FRACTION);
      expect(fitted[2]).toBeCloseTo(MIN_PANE_FRACTION);
      expect(fitted[0]).toBeCloseTo(1 - 2 * MIN_PANE_FRACTION);
    });
  });

  describe('parseStoredLayout', () => {
    it('reads a stored JSON layout', () => {
      expect(parseStoredLayout(JSON.stringify(sideBySide))).toEqual(sideBySide);
    });

    it('is undefined for nothing stored, malformed JSON or a bad shape, and never throws', () => {
      expect(parseStoredLayout(null)).toBeUndefined();
      expect(parseStoredLayout('{"split":')).toBeUndefined();
      expect(parseStoredLayout('{"split":"row","panes":"board"}')).toBeUndefined();
    });
  });

  describe('fitSizes', () => {
    it('scales to fractions', () => {
      expect(fitSizes([1, 3])).toEqual([0.25, 0.75]);
    });

    it('lifts a pane that taking from the others pushes under the minimum too', () => {
      const fitted = fitSizes([0.1, 0.21, 0.69]);
      fitted.forEach(size => expect(size).toBeGreaterThanOrEqual(MIN_PANE_FRACTION - 1e-9));
      expect(fitted.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1);
    });
  });

  describe('presets', () => {
    it('names the preset a layout matches, by shape', () => {
      expect(presetOf(singlePaneLayout('tavern'))).toBe('single');
      expect(presetOf(sideBySide)).toBe('side-by-side');
      expect(presetOf({ ...sideBySide, split: 'column' })).toBe('stacked');
      expect(presetOf(applyPreset(sideBySide, 'three-across'))).toBe('three-across');
      expect(presetOf({ split: 'column', panes: applyPreset(sideBySide, 'three-across').panes })).toBeUndefined();
    });

    it('keeps the panes it already has and fills new ones with unused views, evenly sized', () => {
      const split = applyPreset(singlePaneLayout('board'), 'side-by-side');
      expect(split.panes.map(pane => pane.view)).toEqual(['board', 'transit']);
      expect(sizes(split)).toEqual([0.5, 0.5]);

      const stacked = applyPreset(setPaneView(split, 1, 'constellation'), 'stacked');
      expect(stacked.split).toBe('column');
      expect(stacked.panes.map(pane => pane.view)).toEqual(['board', 'constellation']);

      expect(applyPreset(stacked, 'three-across').panes.map(pane => pane.view)).toEqual([
        'board',
        'constellation',
        'transit',
      ]);
      expect(applyPreset(stacked, 'single')).toEqual(singlePaneLayout('board'));
    });
  });

  describe('setPaneView', () => {
    it('changes one pane and leaves a missing index alone', () => {
      expect(setPaneView(sideBySide, 1, 'table').panes.map(pane => pane.view)).toEqual(['board', 'table']);
      expect(setPaneView(sideBySide, 5, 'table')).toBe(sideBySide);
    });
  });

  describe('resizePanes', () => {
    it('trades size between the two panes beside the handle only', () => {
      const three = applyPreset(sideBySide, 'three-across');
      const resized = resizePanes(three, 0, 0.1);
      expect(sizes(resized)[0]).toBeCloseTo(1 / 3 + 0.1);
      expect(sizes(resized)[1]).toBeCloseTo(1 / 3 - 0.1);
      expect(sizes(resized)[2]).toBeCloseTo(1 / 3);
    });

    it('stops at the minimum on either side', () => {
      const grown = sizes(resizePanes(sideBySide, 0, 0.9));
      expect(grown[0]).toBeCloseTo(1 - MIN_PANE_FRACTION);
      expect(grown[1]).toBeCloseTo(MIN_PANE_FRACTION);
      const shrunk = sizes(resizePanes(sideBySide, 0, -0.9));
      expect(shrunk[0]).toBeCloseTo(MIN_PANE_FRACTION);
      expect(shrunk[1]).toBeCloseTo(1 - MIN_PANE_FRACTION);
    });

    it('ignores a handle that does not exist and a delta that is not a number', () => {
      expect(resizePanes(sideBySide, 1, 0.1)).toBe(sideBySide);
      expect(resizePanes(sideBySide, 0, Number.NaN)).toBe(sideBySide);
    });
  });

  describe('addPinnedPane', () => {
    it('turns a single pane into a split with the pinned pane last, evenly sized', () => {
      const added = addPinnedPane(singlePaneLayout('tavern'), 'other');
      expect(added).toEqual({
        split: 'row',
        panes: [
          { view: 'tavern', size: 0.5 },
          { view: FALLBACK_PANE_VIEW, size: 0.5, sessionId: 'other' },
        ],
      });
      expect(addPinnedPane(singlePaneLayout('tavern'), 'other', 'transit', 'column').split).toBe('column');
    });

    it('appends to a split, keeping its split and pins, and re-fits sizes', () => {
      const skewed: OrchestratorLayout = {
        split: 'column',
        panes: [
          { view: 'board', size: 0.8 },
          { view: 'transit', size: 0.2, sessionId: 'first' },
        ],
      };
      const added = addPinnedPane(skewed, 'second', 'board', 'row');
      expect(added.split).toBe('column');
      expect(added.panes.map(pane => pane.sessionId)).toEqual([undefined, 'first', 'second']);
      expect(sizes(added)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    });

    it('re-pins the last pane once the stage holds MAX_PANES', () => {
      const full = applyPreset(pinned, 'three-across');
      const replaced = addPinnedPane(full, 'newest');
      expect(replaced.panes).toHaveLength(3);
      expect(replaced.panes.map(pane => pane.sessionId)).toEqual([undefined, 'other', 'newest']);
      expect(sizes(replaced)).toEqual(sizes(full));
    });

    it('leaves a layout that already shows the session alone', () => {
      expect(addPinnedPane(pinned, 'other')).toBe(pinned);
    });
  });
});
