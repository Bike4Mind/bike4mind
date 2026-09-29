/**
 * The two decisions the composer's input makes that are worth stating away from the JSX: which
 * placeholder wins, and what a keypress means.
 *
 * Pure and separately tested because of the second one. "Tab takes the suggestion, Enter sends
 * what is in the box" is the rule that keeps a generated hint from choosing the next turn on
 * its own, and a rule like that should be readable and assertable without mounting a textarea -
 * this package's tests have no DOM to press a key in.
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
