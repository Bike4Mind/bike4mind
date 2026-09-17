import { describe, it, expect } from 'vitest';
import { GEAR_PRESENTATION } from '@client/lib/gears/presentation';
import { tabOpensDetail, tutorialDetailFor, tutorialItemsFor, type TutorialsTabKey } from './tutorialCatalog';

/**
 * The catalog hand-lists gear keys, so it can drift from GEAR_PRESENTATION in two
 * directions and nothing else in the build would say so: a renamed gear silently
 * drops its card (tutorialItemsFor skips unresolved keys), and a newly added gear
 * silently never gets one. Both are pinned here.
 */

const ALL_TABS: TutorialsTabKey[] = ['getting-started', 'advanced', 'developers', 'achievements'];

/** The six destination gears - the ones that earn a sidenav row. */
const DESTINATION_KEYS = ['files', 'projects', 'agents', 'datalakes', 'published', 'hearth'];

describe('tutorialCatalog', () => {
  it('lists no key that GEAR_PRESENTATION does not define', () => {
    // A key that fails this was renamed in presentation.ts: the card disappears
    // from the page rather than erroring, which is what makes it worth a test.
    const unresolved = ALL_TABS.flatMap(tab =>
      tutorialItemsFor(tab)
        .map(item => item.key)
        .filter(key => !GEAR_PRESENTATION[key])
    );
    expect(unresolved).toEqual([]);
  });

  it('gives every gear a card in exactly one tab', () => {
    const placed = ALL_TABS.flatMap(tab => tutorialItemsFor(tab).map(item => item.key));

    expect([...placed].sort()).toEqual(Object.keys(GEAR_PRESENTATION).sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('fills Getting Started with the destination gears', () => {
    const keys = tutorialItemsFor('getting-started').map(item => item.key);
    expect([...keys].sort()).toEqual([...DESTINATION_KEYS].sort());
  });

  it('carries the presentation copy through onto each item', () => {
    const [item] = tutorialItemsFor('getting-started');
    expect(item).toMatchObject({ key: item.key, ...GEAR_PRESENTATION[item.key] });
  });

  it('opens a detail view only for the tabs that explain at length', () => {
    expect(tabOpensDetail('advanced')).toBe(true);
    expect(tabOpensDetail('developers')).toBe(true);
    // Getting Started points at the sidenav instead, so its cards are not buttons.
    expect(tabOpensDetail('getting-started')).toBe(false);
    expect(tabOpensDetail('achievements')).toBe(false);
  });

  describe('tutorialDetailFor', () => {
    it('falls back to placeholder sections for a feature with no copy yet', () => {
      const item = tutorialItemsFor('developers').find(i => i.key === 'apikey')!;
      const detail = tutorialDetailFor(item);

      // Every section is filled, so the layout is never half-empty while the real
      // copy is being written.
      expect(detail.whatItDoes).toContain(item.intro);
      expect(detail.whyItWorks).toBeTruthy();
      expect(detail.whenToUse).toBeTruthy();
      expect(detail.gotchas).toBeTruthy();
    });

    it('prefers the authored copy where it exists', () => {
      const item = tutorialItemsFor('advanced').find(i => i.key === 'mementos')!;
      const detail = tutorialDetailFor(item);

      expect(detail.whatItDoes).toContain('Mementos are short facts');
      expect(detail.ctaHelper).toBe('Opens your account settings');
    });
  });
});
