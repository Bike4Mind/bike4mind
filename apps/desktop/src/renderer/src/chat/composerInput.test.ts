import { describe, expect, it } from 'vitest';
import { matchCommands, parseCommandInvocation } from './commands';
import {
  COMPOSER_BUTTON_LABELS,
  composerButtonAction,
  composerEscapeAction,
  composerKeyAction,
  composerMenuAction,
  composerPlaceholder,
  composerSubmitAction,
  shownSuggestion,
} from './composerInput';
import { skillQuery } from './skillMenu';

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

describe('the `/` menu', () => {
  it('opens on a slash typed into an empty composer', () => {
    expect(skillQuery('/')).toBe('');
    expect(matchCommands('').map(command => command.name)).toEqual(['clear', 'compact']);
  });

  // A slash mid-sentence is punctuation, and a path is a path. Either opening a menu would mean
  // dismissing one to carry on typing an ordinary message.
  it('does not open on a slash that is not the first character', () => {
    expect(skillQuery('fix /clear')).toBeNull();
    expect(skillQuery('see src/clear.ts')).toBeNull();
  });

  it('filters as the name is typed, and empties when nothing matches', () => {
    expect(matchCommands('com').map(command => command.name)).toEqual(['compact']);
    expect(matchCommands('cle').map(command => command.name)).toEqual(['clear']);
    expect(matchCommands('zz')).toEqual([]);
  });

  it('runs the highlighted row on Enter and on Tab, and walks it with the arrows', () => {
    const open = { open: true, count: 2 };
    expect(composerMenuAction('Enter', false, open)).toBe('run');
    expect(composerMenuAction('Tab', false, open)).toBe('run');
    expect(composerMenuAction('ArrowDown', false, open)).toBe('next');
    expect(composerMenuAction('ArrowUp', false, open)).toBe('previous');
  });

  it('claims nothing while it is closed, or open over no rows', () => {
    // The empty case is what keeps "a slash naming nothing is an ordinary message" true at the
    // keyboard: Enter has to reach the send path rather than being swallowed by a menu.
    expect(composerMenuAction('Enter', false, { open: true, count: 0 })).toBe('default');
    expect(composerMenuAction('Enter', false, { open: false, count: 2 })).toBe('default');
    expect(composerMenuAction('Enter', true, { open: true, count: 2 })).toBe('default');
    expect(composerMenuAction('a', false, { open: true, count: 2 })).toBe('default');
  });

  // Escape refuses this one menu and leaves the text where it is - the composer remembers the
  // draft that was dismissed, so nothing typed is lost and nothing is sent.
  it('closes on Escape without touching the turn', () => {
    expect(composerEscapeAction({ pickerOpen: true, streaming: false })).toBe('dismiss-picker');
    expect(composerEscapeAction({ pickerOpen: true, streaming: true })).toBe('dismiss-picker');
  });
});

describe('composerSubmitAction', () => {
  it('runs a command, with whatever followed its name', () => {
    const action = composerSubmitAction('/compact focus on the auth work');
    expect(action.kind).toBe('command');
    if (action.kind !== 'command') throw new Error('expected a command');
    expect(action.invocation.command.name).toBe('compact');
    expect(action.invocation.args).toBe('focus on the auth work');
  });

  it('runs a bare command with no argument', () => {
    const action = composerSubmitAction('/clear');
    expect(action.kind).toBe('command');
    if (action.kind !== 'command') throw new Error('expected a command');
    expect(action.invocation.args).toBe('');
  });

  /**
   * The rule the whole surface rests on: a slash this app does not recognise is the user's own
   * text. Swallowing `/foo` would make a path, a skill and a typo all vanish into a command
   * menu that has no entry for them.
   */
  it.each(['/foo', '/etc/hosts', '/review src/x.ts', 'clear', '/ clear', 'tell me about /compact'])(
    'sends %s as an ordinary message',
    text => {
      expect(composerSubmitAction(text)).toEqual({ kind: 'send' });
      expect(parseCommandInvocation(text)).toBeNull();
    }
  );
});
