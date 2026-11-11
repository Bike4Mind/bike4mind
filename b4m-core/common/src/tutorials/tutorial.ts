/** Stamped on every quest the tutorial seeds, so a quest without it is one the user sent themselves. */
export const TUTORIAL_MARKER_TYPE = 'tutorialMarker';

/** Every tutorial session is born named with this prefix; the sidebar badges it by the name. */
export const TUTORIAL_SESSION_PREFIX = 'Tutorial: ';

export const isTutorialSessionName = (name: string | undefined): boolean =>
  !!name && name.startsWith(TUTORIAL_SESSION_PREFIX);

export const TUTORIAL_STATUSES = ['in_progress', 'finished', 'left'] as const;
export type TutorialStatus = (typeof TUTORIAL_STATUSES)[number];

export const TUTORIAL_CARD_SIDES = ['above', 'below', 'left', 'right'] as const;
export type TutorialCardSide = (typeof TUTORIAL_CARD_SIDES)[number];

/** Set by the host page on the docked chat's wrapper while a pane shares the row with it. */
export const CHAT_BESIDE_PANE_ATTR = 'data-chat-beside-pane';
/**
 * Core's docked chat, for a card to avoid, matched only while a pane sits beside it. A chat filling the row
 * leaves the card no clear spot, and avoiding it would push the card to the top of the window over the chat.
 */
export const DOCKED_CHAT_BESIDE_PANE = `[${CHAT_BESIDE_PANE_ATTR}] [data-testid="docked-chat-panel"]`;

/** One step of a module. `type` names a renderer in the host's step registry. */
export interface TutorialStep {
  /** Stable, never an index, so editing a module does not misplace a saved position. */
  id: string;
  type: string;
  body: string;
  /** The body once the step's action is done and it waits for the user's Next. */
  doneBody?: string;
  title?: string;
  /** The `data-testid` the coach card points at; absent means the card floats unanchored. */
  anchor?: string;
  /** A CSS selector the anchor must sit inside, when the same testid repeats (one per canvas node). */
  anchorScope?: string;
  /** The card's width in px, for a step that needs more room than the default. */
  cardWidth?: number;
  /** `panel` opens the card over the page's middle at full width instead of beside an anchor; `cardWidth` is ignored. */
  layout?: 'panel';
  /**
   * The side of the anchor the card tries first, when the default would cover what the step points at. With no
   * anchor on screen, `left` docks the card bottom-left instead of bottom-right.
   */
  placement?: TutorialCardSide;
  /** A CSS selector for what the card keeps clear of, such as the composer below a chat answer it explains. */
  avoid?: string;
  /** The recorded turn a `prompt` step waits for the user to send. Turn 0 is the opening message. */
  turn?: number;
  /** What a `prompt` step pastes into the composer: the turn's recorded prompt, word for word. */
  prompt?: string;
  /** The label of the step's own button. */
  action?: string;
  /** Settings for the host's own step types; each type parses its own. */
  params?: Readonly<Record<string, unknown>>;
}

/** One module's saved position, as the progress action returns it. */
export interface TutorialProgressEntry {
  status: TutorialStatus;
  stepId?: string;
  sessionId: string;
  moduleVersion: number;
  /** Absent on walks begun before revisions existed, which counts as 0. */
  moduleRevision?: number;
}

/** Whether a saved walk was started on the module as it stands now: same repo version, same live revision. */
export function walkIsCurrent(
  entry: Pick<TutorialProgressEntry, 'moduleVersion' | 'moduleRevision'>,
  module: { version: number; revision: number }
): boolean {
  return entry.moduleVersion === module.version && (entry.moduleRevision ?? 0) === module.revision;
}

interface EffectCarrier {
  uiSideEffects?: readonly ({ type?: string } | null | undefined)[] | null;
}

export function carriesTutorialMarker(quest: EffectCarrier): boolean {
  return (quest.uiSideEffects ?? []).some(effect => effect?.type === TUTORIAL_MARKER_TYPE);
}

/** Case and spacing never decide a match, so a pasted prompt the editor reflowed still counts. */
export const samePrompt = (a: string, b: string) =>
  a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

/** The recorded turn a quest answered, or undefined when it carries no marker. */
export function markedTurn(quest: {
  uiSideEffects?: readonly ({ type?: string; payload?: unknown } | null | undefined)[] | null;
}): number | undefined {
  const marker = (quest.uiSideEffects ?? []).find(effect => effect?.type === TUTORIAL_MARKER_TYPE);
  const turn = (marker?.payload as { turn?: unknown } | undefined)?.turn;
  return typeof turn === 'number' ? turn : undefined;
}
