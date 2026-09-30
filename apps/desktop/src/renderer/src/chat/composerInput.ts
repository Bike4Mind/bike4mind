/**
 * The decisions the composer's input makes that are worth stating away from the JSX: which
 * placeholder wins, what a keypress means, and which single control the button is right now.
 *
 * Pure and separately tested because of the keypress rules. "Tab takes the suggestion, Enter
 * sends what is in the box" is the rule that keeps a generated hint from choosing the next turn
 * on its own, and "Escape stops the turn unless the skill menu is up" is the rule that keeps a
 * running reply stoppable now that only one button shows at a time. Rules like those should be
 * readable and assertable without mounting a textarea - this package's tests have no DOM to
 * press a key in.
 */

/** What the composer does with a keypress in its input. */
export type ComposerKeyAction =
  /** Fill the draft with the suggestion. Fills it and stops - it never also sends. */
  | 'accept-suggestion'
  /** Send whatever is actually in the box. */
  | 'submit'
  /** Not ours; let the browser have it. */
  | 'default';

/**
 * Which of the three a keypress is.
 *
 * `accept-suggestion` and `submit` are separate outcomes of one switch, which is the whole
 * point: no key can produce both, so accepting a suggestion cannot send it, and there is no
 * ordering or fall-through that would let it. Sending is always a second, deliberate keypress
 * on text the user has had the chance to read and edit.
 *
 * Tab is claimed ONLY while a suggestion is showing, and only unshifted. It is otherwise how
 * the keyboard leaves the input, and a composer that swallowed it would be the app's worst
 * accessibility bug - Shift+Tab especially, which is the only way back out of the input to the
 * controls above it.
 */
export function composerKeyAction(key: string, shiftKey: boolean, hasSuggestion: boolean): ComposerKeyAction {
  if (key === 'Tab') return hasSuggestion && !shiftKey ? 'accept-suggestion' : 'default';
  // Shift+Enter breaks the line - the convention every chat client here shares.
  if (key === 'Enter' && !shiftKey) return 'submit';
  return 'default';
}

/** What the composer's one button does when clicked. */
export type ComposerButtonAction =
  /** Start this turn. */
  | 'send'
  /** End the turn that is running. */
  | 'stop'
  /** Hold this turn behind the one that is running. */
  | 'queue';

/**
 * Which of the three the single button is.
 *
 * One control at a time, never two. The pair this replaced existed because stopping the current
 * turn and queueing the next one are different intentions and a user who has typed ahead must
 * still be able to stop - but two buttons side by side made the composer's busiest corner
 * guess-work, and only one of them is ever the obvious next click. What keeps the reasoning
 * honest is that stopping moved to a key rather than being dropped: see composerEscapeAction.
 *
 * `hasContent` and not `canSubmit`: a draft that cannot be sent yet (an attachment still
 * uploading, a blocked turn) is still the user typing ahead, so the button stays Queue and
 * merely disables. Reaching for Stop by deleting their own draft is not a thing to ask of
 * anyone, which is exactly why Escape is not optional here.
 */
export function composerButtonAction(input: { streaming: boolean; hasContent: boolean }): ComposerButtonAction {
  if (!input.streaming) return 'send';
  return input.hasContent ? 'queue' : 'stop';
}

/**
 * The button's accessible name, per state.
 *
 * With the label gone from the face of the button this is the only text naming the action, for
 * a screen reader and for the tooltip alike, so it is kept beside the state that chooses it.
 */
export const COMPOSER_BUTTON_LABELS: Record<ComposerButtonAction, string> = {
  send: 'Send message',
  stop: 'Stop generating',
  queue: 'Queue message',
};

/** What Escape in the composer's input means. */
export type ComposerEscapeAction =
  /** Close the skill menu, leaving the text alone. */
  | 'dismiss-picker'
  /** End the turn that is running. */
  | 'stop'
  /** Nothing of ours; let the browser have it. */
  | 'default';

/**
 * Escape's precedence: the skill menu first, the running turn second.
 *
 * The menu wins while it is open because it is the thing the user is looking at and Escape is
 * the only way to refuse it - taking that away to stop a turn would make a mis-typed `/` a trap.
 * Everywhere else Escape stops the turn, whatever is in the draft, and that is the whole reason
 * a single button is safe: Queue takes the button's place the moment the user types ahead, and
 * this is the path to Stop that does not go through deleting what they just wrote.
 */
export function composerEscapeAction(input: { pickerOpen: boolean; streaming: boolean }): ComposerEscapeAction {
  if (input.pickerOpen) return 'dismiss-picker';
  return input.streaming ? 'stop' : 'default';
}

/**
 * What the empty input says, in precedence order.
 *
 * The disabled message outranks a suggestion outright: "Pick a conversation to start typing"
 * answers the question the user is about to ask, and a hint about a conversation they cannot
 * type in does not. The suggestion then outranks the ordinary prompt, and only while the draft
 * is EMPTY - keyed on the raw text, because a draft of nothing but spaces is still something
 * the user typed, and drawing a hint under it would read as the app having eaten it.
 */
export function composerPlaceholder(input: {
  disabled: boolean;
  text: string;
  suggestion: string | null | undefined;
  placeholder: string;
}): string {
  if (input.disabled) return 'Pick a conversation to start typing';
  return shownSuggestion(input) ?? input.placeholder;
}

/** The suggestion the input is currently offering, or null when it is offering none. */
export function shownSuggestion(input: {
  disabled: boolean;
  text: string;
  suggestion: string | null | undefined;
}): string | null {
  if (input.disabled || input.text.length > 0) return null;
  return input.suggestion || null;
}
