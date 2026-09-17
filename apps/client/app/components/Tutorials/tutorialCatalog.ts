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
 * Tabs whose cards open a detail view rather than acting on the feature directly.
 * Getting Started is the exception: those six have a sidenav row, so their cards
 * point at the nav instead of explaining at length.
 */
const TABS_WITH_DETAIL: readonly TutorialsTabKey[] = ['advanced', 'developers'];

export const tabOpensDetail = (tab: TutorialsTabKey): boolean => TABS_WITH_DETAIL.includes(tab);

/**
 * Long-form copy for a card's detail view. Every section is optional: a missing
 * one is not rendered, so a feature can be filled in a section at a time rather
 * than needing all four before it is worth showing.
 *
 * This is the one place the Tutorials surface owns words of its own, because a
 * gear's `intro` is a single sentence and these are paragraphs. `whatItDoes`
 * falls back to that intro so a card is never blank.
 */
export interface TutorialDetail {
  whatItDoes?: string;
  whyItWorks?: string;
  whenToUse?: string;
  gotchas?: string;
  /** Sits beside the CTA to say where the button goes. */
  ctaHelper?: string;
}

const TUTORIAL_DETAIL: Record<string, TutorialDetail> = {
  mementos: {
    whatItDoes:
      'Mementos are short facts the app keeps about you and your work - what you are building, who you work with, how you like things done. They are written after a conversation ends and read at the start of the next one, so you stop re-explaining your context every time.',
    whyItWorks:
      'Each chat starts with no knowledge of the last one. Mementos are a small, readable set of notes that get loaded in first, which is why they hold durable things and not the details of a single task. A fact worth keeping is one that would still be true next month.',
    whenToUse:
      'Leave it on if you use the app for ongoing work - the same project, the same codebase, the same team. The value compounds as the notes build up. Turn it off for one-off or sensitive work. Nothing is written while it is off, and you can delete individual mementos at any time.',
    gotchas:
      'Mementos are not a transcript. They will not recall what you said in a specific chat, only the facts saved from it. If something matters, say it plainly - a passing mention may not be kept.',
    ctaHelper: 'Opens your account settings',
  },
};

/**
 * PLACEHOLDER copy, shown for any feature with no entry in TUTORIAL_DETAIL yet.
 * Real sections will run long, so this is sized to match rather than to read -
 * it exists to show the layout at a realistic length. Replace per feature.
 */
const PLACEHOLDER_DETAIL: TutorialDetail = {
  whatItDoes:
    'Lorem ipsum id pellentesque nibh neque ultrices elit sem nisl et volutpat amet lacus venenatis sem at quisque ullamcorper ante. Donec sed odio dui, nulla vitae elit libero, a pharetra augue. Cras justo odio, dapibus ac facilisis in, egestas eget quam.',
  whyItWorks:
    'Nullam quis risus eget urna mollis ornare vel eu leo. Maecenas sed diam eget risus varius blandit sit amet non magna. Vestibulum id ligula porta felis euismod semper. Cum sociis natoque penatibus et magnis dis parturient montes, nascetur ridiculus mus. Aenean lacinia bibendum nulla sed consectetur.',
  whenToUse:
    'Etiam porta sem malesuada magna mollis euismod. Duis mollis, est non commodo luctus, nisi erat porttitor ligula, eget lacinia odio sem nec elit. Integer posuere erat a ante venenatis dapibus posuere velit aliquet. Morbi leo risus, porta ac consectetur ac, vestibulum at eros.',
  gotchas:
    'Curabitur blandit tempus porttitor. Vivamus sagittis lacus vel augue laoreet rutrum faucibus dolor auctor. Sed posuere consectetur est at lobortis. Fusce dapibus, tellus ac cursus commodo, tortor mauris condimentum nibh.',
  ctaHelper: 'Opens the feature',
};

/**
 * Detail copy for a feature. Falls back to the placeholder set while the real
 * sections are being written, so every card has a full-length view to look at.
 */
export function tutorialDetailFor(item: TutorialItem): TutorialDetail {
  const detail = TUTORIAL_DETAIL[item.key];
  if (detail) return { ...detail, whatItDoes: detail.whatItDoes ?? item.intro };
  return { ...PLACEHOLDER_DETAIL, whatItDoes: `${item.intro} ${PLACEHOLDER_DETAIL.whatItDoes}` };
}

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
