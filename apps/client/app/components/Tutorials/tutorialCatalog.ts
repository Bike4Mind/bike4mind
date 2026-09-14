import { GEAR_PRESENTATION, type GearPresentation } from '@client/lib/gears/presentation';

/**
 * Which features each Tutorials tab lists, as gear keys.
 *
 * The keys index GEAR_PRESENTATION, so titles and descriptions have exactly one
 * home and cannot drift from what the Gears page shows. This module owns only
 * the grouping - never the copy.
 *
 * Getting Started is the six destination gears: the features that earn a place
 * in the sidenav. That is also why this tab is the one that can eventually point
 * at the nav - every entry except Data Lakes has a row to point at.
 */

export type TutorialsTabKey = 'getting-started' | 'advanced' | 'developers' | 'achievements';

export interface TutorialItem extends GearPresentation {
  key: string;
}

/** The six destination gears - the features that earn a sidenav row. */
const GETTING_STARTED_KEYS = ['files', 'projects', 'agents', 'datalakes', 'published', 'hearth'] as const;

/** Skills that need an API key, a terminal or a runtime to be worth reading about. */
const DEVELOPER_KEYS = ['apikey', 'apicall', 'mcp', 'clidocs', 'python', 'react'] as const;

/** The remaining skills: in-product capabilities rather than integrations. */
const ADVANCED_KEYS = [
  'mementos',
  'questmaster',
  'models',
  'image',
  'video',
  'voice',
  'research',
  'websearch',
  'webfetch',
  'wolfram',
  'matheval',
  'rapidreply',
  'shareproject',
  'shareagent',
  'forknotebook',
  'downloadnotebook',
  'importopenai',
  'importclaude',
  'slack',
  'mfa',
] as const;

const TAB_KEYS: Record<TutorialsTabKey, readonly string[]> = {
  'getting-started': GETTING_STARTED_KEYS,
  advanced: ADVANCED_KEYS,
  developers: DEVELOPER_KEYS,
  // Achievements is a placeholder until the reward surface is designed.
  achievements: [],
};

/**
 * Items for a tab, skipping any key with no presentation entry so a rename in
 * GEAR_PRESENTATION drops a card rather than rendering an empty one.
 */
export function tutorialItemsFor(tab: TutorialsTabKey): TutorialItem[] {
  return TAB_KEYS[tab].flatMap(key => {
    const presentation = GEAR_PRESENTATION[key];
    return presentation ? [{ key, ...presentation }] : [];
  });
}
