import { describe, expect, it } from 'vitest';
import {
  COMPOSER_BUTTON_LABELS,
  composerButtonAction,
  composerEscapeAction,
  composerKeyAction,
  composerPlaceholder,
  shownSuggestion,
} from './composerInput';

const KEYS: [string, boolean][] = [
  ['Tab', false],
  ['Tab', true],
  ['Enter', false],
  ['Enter', true],
  ['Escape', false],
  ['a', false],
  ['ArrowUp', false],
];

describe('composerKeyAction', () => {
  it('takes the suggestion on Tab while one is showing', () => {
    expect(composerKeyAction('Tab', false, true)).toBe('accept-suggestion');
  });

  // Tab is how the keyboard leaves the input. Claiming it with no hint up would trap focus.
  it('leaves Tab alone when no suggestion is showing', () => {
    expect(composerKeyAction('Tab', false, false)).toBe('default');
  });

  it('sends on Enter', () => {
    expect(composerKeyAction('Enter', false, false)).toBe('submit');
  });

  // The hard requirement: a suggestion on screen must not change what Enter means. It still
  // sends what is in the box - which, with the hint merely drawn as a placeholder, is nothing.
  it('still means "send what is in the box" on Enter with a suggestion showing', () => {
    expect(composerKeyAction('Enter', false, true)).toBe('submit');
  });

  it('breaks the line on Shift+Enter', () => {
    expect(composerKeyAction('Enter', true, true)).toBe('default');
  });

  /**
   * The invariant the feature rests on: accepting and sending are outcomes of one switch, so no
   * key can do both. A suggestion is model output sitting in the user's input box, and a single
   * keystroke that filled it AND sent it would let that output choose the next turn.
   */
  it.each(KEYS)('never both accepts and submits on %s (shift: %s)', (key, shift) => {
    for (const hasSuggestion of [true, false]) {
      const action = composerKeyAction(key, shift, hasSuggestion);
      expect(['accept-suggestion', 'submit', 'default']).toContain(action);
      if (action === 'accept-suggestion') expect(action).not.toBe('submit');
    }
  });

  it('only ever accepts a suggestion via Tab', () => {
    const accepting = KEYS.filter(([key, shift]) => composerKeyAction(key, shift, true) === 'accept-suggestion');
    expect(accepting).toEqual([['Tab', false]]);
  });
});

describe('composerButtonAction', () => {
  it('offers Send with no reply running, whether or not anything is typed', () => {
    expect(composerButtonAction({ streaming: false, hasContent: false })).toBe('send');
    expect(composerButtonAction({ streaming: false, hasContent: true })).toBe('send');
  });

  it('offers Stop while a reply runs into an empty box', () => {
    expect(composerButtonAction({ streaming: true, hasContent: false })).toBe('stop');
  });

  it('becomes Queue the moment the user types ahead of the running reply', () => {
    expect(composerButtonAction({ streaming: true, hasContent: true })).toBe('queue');
  });

  // The rule the icons rest on: exactly one control is on screen, whatever the state.
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])('names exactly one control for streaming=%s hasContent=%s', (streaming, hasContent) => {
    const action = composerButtonAction({ streaming, hasContent });
    expect(['send', 'stop', 'queue']).toContain(action);
    expect(COMPOSER_BUTTON_LABELS[action]).toBeTruthy();
  });

  // An icon-only button's label IS its name. Pinned because a wrong one is invisible on screen.
  it('labels each state for what the click does', () => {
    expect(COMPOSER_BUTTON_LABELS).toEqual({
      send: 'Send message',
      stop: 'Stop generating',
      queue: 'Queue message',
    });
  });
});

describe('composerEscapeAction', () => {
  /**
   * The load-bearing case. Queue takes the button away from Stop exactly when the user has typed
   * ahead, so if Escape did not stop the turn here the only way to stop it would be to delete
   * the draft first. This test is the reason one button is allowed at all.
   */
  it('stops the running turn even with a draft typed ahead of it', () => {
    expect(composerEscapeAction({ pickerOpen: false, streaming: true })).toBe('stop');
  });

  // The skill menu keeps Escape while it is up: it is the only way to refuse a mis-typed `/`.
  it('closes the skill menu instead, while that is showing', () => {
    expect(composerEscapeAction({ pickerOpen: true, streaming: true })).toBe('dismiss-picker');
    expect(composerEscapeAction({ pickerOpen: true, streaming: false })).toBe('dismiss-picker');
  });

  it('never stops a turn while the menu owns the key', () => {
    for (const streaming of [true, false]) {
      expect(composerEscapeAction({ pickerOpen: true, streaming })).not.toBe('stop');
    }
  });

  it('is left to the browser when nothing is running and no menu is up', () => {
    expect(composerEscapeAction({ pickerOpen: false, streaming: false })).toBe('default');
  });
});

describe('shownSuggestion', () => {
  it('offers the suggestion while the draft is empty', () => {
    expect(shownSuggestion({ disabled: false, text: '', suggestion: 'Add a test' })).toBe('Add a test');
  });

  it('stops offering it the moment the user types', () => {
    expect(shownSuggestion({ disabled: false, text: 'K', suggestion: 'Add a test' })).toBeNull();
  });

  // A draft of nothing but spaces is still something the user typed.
  it('treats whitespace as typed text rather than as an empty box', () => {
    expect(shownSuggestion({ disabled: false, text: '   ', suggestion: 'Add a test' })).toBeNull();
  });

  it('offers nothing in a composer with no conversation behind it', () => {
    expect(shownSuggestion({ disabled: true, text: '', suggestion: 'Add a test' })).toBeNull();
  });
});

describe('composerPlaceholder', () => {
  const base = { disabled: false, text: '', placeholder: 'Send a message...' };

  it('draws the suggestion in place of the ordinary prompt', () => {
    expect(composerPlaceholder({ ...base, suggestion: 'Add a test' })).toBe('Add a test');
  });

  it('falls back to the ordinary prompt when there is no suggestion', () => {
    expect(composerPlaceholder({ ...base, suggestion: null })).toBe('Send a message...');
  });

  it('keeps a Code session its own prompt', () => {
    const code = { ...base, placeholder: 'Describe a task or ask a question', suggestion: null };
    expect(composerPlaceholder(code)).toBe('Describe a task or ask a question');
  });

  // The disabled message answers the question the user is about to ask; a hint about a
  // conversation they cannot type in does not.
  it('never lets a suggestion replace the disabled message', () => {
    expect(composerPlaceholder({ ...base, disabled: true, suggestion: 'Add a test' })).toBe(
      'Pick a conversation to start typing'
    );
  });

  it('goes back to the ordinary prompt once the draft has content', () => {
    expect(composerPlaceholder({ ...base, text: 'Keep', suggestion: 'Add a test' })).toBe('Send a message...');
  });
});
