/**
 * Which Gears page tab each gear sits on. Pure, so the page renders from it and the
 * status endpoint's tests can run the real catalog (GEAR_DEFAULTS) through it: every
 * gear must land on exactly one tab.
 */

export type GearsTabKey = 'getting-started' | 'features' | 'generators' | 'integrations';

export const GEARS_TABS: { key: GearsTabKey; label: string }[] = [
  { key: 'getting-started', label: 'Getting Started' },
  { key: 'features', label: 'Explore Features' },
  { key: 'generators', label: 'Generators' },
  { key: 'integrations', label: 'Integrations' },
];

/** Tabs whose cards open the long-form view instead of acting at once. Getting
 *  Started is the exception: those features have a sidenav row to go to, so an
 *  explanation would sit between the user and the thing itself. */
export const TABS_WITH_DETAIL: readonly GearsTabKey[] = ['features', 'generators', 'integrations'];

/**
 * Leads the Getting Started tab despite being a skill: running one question past
 * many models is the story the product turns on. Placement only - the endpoint
 * still calls it a skill, because it has no sidenav row of its own.
 */
export const GETTING_STARTED_LEAD = 'models';

/** Skills that turn a prompt into a media file. Grouped here rather than by
 *  `kind`, which the endpoint owns and which only separates the features with a
 *  sidenav row of their own from everything else. */
export const GENERATOR_KEYS: readonly string[] = ['image', 'video', 'music', 'sound'];

/** Skills that connect Bike4Mind to something outside it. Slack is the only
 *  one broken out so far; MCP and the chat imports are the obvious next. */
export const INTEGRATION_KEYS: readonly string[] = ['slack'];

interface TabbedGear {
  key: string;
  kind: 'destination' | 'skill';
}

/** Whether a gear belongs on the Gears page's Getting Started tab. */
export const isGettingStarted = (gear: TabbedGear) => gear.key === GETTING_STARTED_LEAD || gear.kind === 'destination';

/** The gears on each tab, in the order the tab shows them. */
export function groupGearsByTab<T extends TabbedGear>(gears: readonly T[]): Record<GearsTabKey, T[]> {
  return {
    // The lead first, then the destinations in endpoint order.
    'getting-started': [
      ...gears.filter(g => g.key === GETTING_STARTED_LEAD),
      ...gears.filter(g => isGettingStarted(g) && g.key !== GETTING_STARTED_LEAD),
    ],
    features: gears.filter(
      g =>
        g.kind === 'skill' &&
        g.key !== GETTING_STARTED_LEAD &&
        !GENERATOR_KEYS.includes(g.key) &&
        !INTEGRATION_KEYS.includes(g.key)
    ),
    generators: gears.filter(g => GENERATOR_KEYS.includes(g.key)),
    integrations: gears.filter(g => INTEGRATION_KEYS.includes(g.key)),
  };
}
