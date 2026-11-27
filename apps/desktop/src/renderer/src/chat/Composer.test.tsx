// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import { composerDrafts, createComposerDraftsStore } from './composerDrafts';
import { ContextRing } from './ContextRing';
import type { ComposerUsage } from './statusLine';
import type { AttachmentDraft } from './useAttachments';
import { addDirPath, matchCommands, parseCommandInvocation } from './commands';
import {
  appendToDraft,
  attachShortcut,
  COMPOSER_BUTTON_LABELS,
  composerButtonAction,
  composerEscapeAction,
  composerKeyAction,
  composerMenuAction,
  composerPlaceholder,
  composerSubmitAction,
  recallPromptAction,
  isAttachChord,
  shownSuggestion,
} from './composerInput';
import { skillQuery } from './skillMenu';
import { caretInCode, codeRanges, fenceKeyAction, type ComposerEdit } from './composerMarkdown';
import type { ComposerDrafts } from '@shared/composerDrafts';
import type { ChatAttachment } from '@shared/chat';
import { AttachmentRow } from './Attachments';

/**
 * Two kinds of test in one file. The indicator is answerable from static markup, so it is
 * asserted that way; the `/` menu is a keyboard surface, and the only honest way to assert that
 * typing a slash opens a menu and the arrows walk it is to press the keys - hence jsdom.
 */
const draft: AttachmentDraft = {
  attachments: [],
  busy: false,
  rejected: [],
  dismissRejected: () => {},
  add: async () => {},
  pick: async () => {},
  attachImage: async () => {},
  attachFilePath: async () => {},
  remove: () => {},
  clear: () => {},
};

const usage: ComposerUsage = {
  contextTokens: 44_000,
  contextLimit: 200_000,
  credits: 25_000,
  monthlyAllowance: 50_000,
};

function statusMarkup(props: Partial<Parameters<typeof Composer>[0]> = {}): string {
  return renderToStaticMarkup(
    <CssVarsProvider>
      <Composer
        sessionId="s1"
        disabled={false}
        streaming={false}
        attachments={draft}
        usage={usage}
        onSend={() => {}}
        onStop={() => {}}
        {...props}
      />
    </CssVarsProvider>
  );
}

/** The ring's accessible name, which is where the figure went when the label was dropped. */
function ringLabel(props: Partial<Parameters<typeof Composer>[0]> = {}): string | null {
  const ring = statusMarkup(props).match(/aria-label="([^"]*)"[^>]*data-testid="composer-status-ring"/);
  return ring?.[1] ?? null;
}

/** The arc the ring draws, as Joy writes it into its own custom property. */
function ringValue(props: Partial<Parameters<typeof Composer>[0]> = {}): number | null {
  const markup = statusMarkup(props);
  if (!markup.includes('data-testid="composer-status-ring"')) return null;
  const percent = markup.match(/--CircularProgress-percent:\s*([\d.]+)/);
  return percent ? Number(percent[1]) : null;
}

function hasRing(props: Partial<Parameters<typeof Composer>[0]> = {}): boolean {
  return statusMarkup(props).includes('data-testid="composer-status-ring"');
}

describe('the composer indicator', () => {
  /** A balance down to 20% of the allowance: low enough that the credits ring stands up. */
  const low = { ...usage, credits: 10_000, monthlyAllowance: 50_000 };

  /**
   * The row's standing indicator is the context ring, whose tooltip carries the balance. The
   * credits ring only joins it once the allowance runs low, so a healthy, rolled-over or
   * unstated balance draws nothing here.
   */
  it('draws no credits ring while the allowance is healthy', () => {
    expect(hasRing()).toBe(false);
    expect(hasRing({ usage: { ...usage, credits: 75_000, monthlyAllowance: 50_000 } })).toBe(false);
    expect(hasRing({ usage: { ...usage, credits: 31_667, monthlyAllowance: null } })).toBe(false);
  });

  it('draws the ring and nothing else once the allowance runs low, keeping the figure as its name', () => {
    expect(statusMarkup({ usage: low })).not.toContain('composer-status-text');
    expect(statusMarkup({ usage: low })).not.toContain('turn-dot');
    expect(ringLabel({ usage: low })).toBe('Credits 20% of monthly plan allowance');
    expect(ringValue({ usage: low })).toBe(20);
  });

  it('keeps the ring up through a turn in flight', () => {
    expect(hasRing({ usage: low, streaming: true })).toBe(true);
    expect(ringLabel({ usage: low, streaming: true })).toBe('Credits 20% of monthly plan allowance');
  });

  it('floors a tiny positive balance share so it remains visible', () => {
    const tiny = { ...usage, credits: 1, monthlyAllowance: 50_000 };
    expect(ringValue({ usage: tiny })).toBe(4);
    expect(ringLabel({ usage: tiny })).toBe('Credits &lt;1% of monthly plan allowance');
  });

  // Nothing to measure and nothing to say: the sidebar dot speaks for these, so a ring here
  // would be a glyph standing for nothing.
  it('draws no ring where there is no conversation to measure', () => {
    const low = { ...usage, credits: 10_000, monthlyAllowance: 50_000 };
    expect(hasRing({ usage: low, disabled: true })).toBe(false);
    expect(hasRing({ usage: low, notReady: 'No folder' })).toBe(false);
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no matchMedia, and Joy's colour-scheme provider asks for one on mount.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

// Joy's popups (menus, selects, tooltips, modals) read every ancestor's computed style on each update,
// and jsdom resolves that against every emotion sheet with no layout to find; the inline style will do.
window.getComputedStyle = ((element: Element) => (element as HTMLElement).style) as typeof getComputedStyle;

// jsdom implements no layout, so the picker's scroll-the-highlight-into-view has nothing to call.
Element.prototype.scrollIntoView ??= () => {};

let root: Root | null = null;
let host: HTMLElement | null = null;

// The drafts store outlives a mount, as it does across a session switch in the app.
beforeEach(() => composerDrafts.state.setState({ drafts: {}, hydrated: true }));

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function tree(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  return (
    <CssVarsProvider>
      <Composer
        sessionId="s1"
        disabled={false}
        streaming={false}
        attachments={draft}
        onSend={() => {}}
        onStop={() => {}}
        {...props}
      />
    </CssVarsProvider>
  );
}

function mount(props: Partial<Parameters<typeof Composer>[0]> = {}): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(tree(props));
  });
}

/**
 * Render again into the same root, which is what switching conversations does: the shell keys
 * the thread beside this on the session id, but hands this one a new `sessionId` prop and
 * leaves it mounted.
 */
function rerender(props: Partial<Parameters<typeof Composer>[0]> = {}): void {
  act(() => {
    root?.render(tree(props));
  });
}

function input(): HTMLTextAreaElement {
  const element = host?.querySelector('[data-testid="chat-composer-input"]');
  if (!element) throw new Error('no composer input');
  return element as HTMLTextAreaElement;
}

/** Type into the textarea the way React reads it: set the value, then dispatch the input event. */
function type(text: string): void {
  const element = input();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(element, text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(key: string): void {
  act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function rows(): HTMLElement[] {
  return Array.from(host?.querySelectorAll('[data-testid="command-picker-option"]') ?? []) as HTMLElement[];
}

function highlighted(): string | null {
  const row = rows().find(entry => entry.className.includes('Mui-selected'));
  return row?.getAttribute('data-command-name') ?? null;
}

describe('the composer command menu', () => {
  it('fills /loop from the keyboard and dispatches its nested skill unchanged', () => {
    const run = vi.fn();
    const send = vi.fn();
    mount({ onRunCommand: run, onSend: send });
    type('/loo');
    press('Enter');
    expect(input().value).toBe('/loop ');
    expect(run).not.toHaveBeenCalled();
    type('/loop 5m /review src/index.ts');
    press('Enter');
    expect(run).toHaveBeenCalledWith('loop', '5m /review src/index.ts');
    expect(send).not.toHaveBeenCalled();
  });

  it('opens on a slash in an empty composer and lists every command', () => {
    mount({ onRunCommand: () => {}, sessionMode: 'code' });
    expect(rows()).toHaveLength(0);

    type('/');
    expect(rows().map(row => row.getAttribute('data-command-name'))).toEqual([
      'clear',
      'compact',
      'pr',
      'add-dir',
      'loop',
    ]);
    expect(rows()[3].textContent).toContain('[path]');
  });

  it('leaves the Code-only commands out of a Chat conversation', () => {
    mount({ onRunCommand: () => {}, sessionMode: 'chat' });
    type('/');
    expect(rows().map(row => row.getAttribute('data-command-name'))).toEqual(['clear', 'compact', 'add-dir', 'loop']);
  });

  it('filters as the name is typed', () => {
    mount({ onRunCommand: () => {} });
    type('/comp');
    expect(rows().map(row => row.getAttribute('data-command-name'))).toEqual(['compact']);
  });

  it('walks the rows with the arrow keys and runs the highlighted one on Enter', () => {
    const run = vi.fn();
    mount({ onRunCommand: run });
    type('/');
    expect(highlighted()).toBe('clear');

    press('ArrowDown');
    expect(highlighted()).toBe('compact');
    press('ArrowUp');
    expect(highlighted()).toBe('clear');

    press('Enter');
    expect(run).toHaveBeenCalledWith('clear', '');
    // The draft goes with it: the command ran, so there is nothing left to send.
    expect(input().value).toBe('');
    expect(rows()).toHaveLength(0);
  });

  it('fills in a command that needs an argument instead of running it bare', () => {
    const run = vi.fn();
    mount({ onRunCommand: run, sessionMode: 'code' });
    type('/p');
    press('Enter');
    expect(run).not.toHaveBeenCalled();
    expect(input().value).toBe('/pr ');
  });

  it('closes on Escape and leaves what was typed alone', () => {
    const run = vi.fn();
    mount({ onRunCommand: run });
    type('/cle');
    expect(rows()).toHaveLength(1);

    press('Escape');
    expect(rows()).toHaveLength(0);
    expect(input().value).toBe('/cle');
    expect(run).not.toHaveBeenCalled();
  });

  it('sends a slash that names no command as an ordinary message', () => {
    const send = vi.fn();
    const run = vi.fn();
    mount({ onSend: send, onRunCommand: run });
    type('/nonsense');
    press('Enter');

    expect(run).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('/nonsense');
  });

  it('passes what follows the name as the command argument', () => {
    const run = vi.fn();
    const send = vi.fn();
    mount({ onSend: send, onRunCommand: run });
    type('/compact focus on the auth work');
    press('Enter');

    expect(run).toHaveBeenCalledWith('compact', 'focus on the auth work');
    expect(send).not.toHaveBeenCalled();
  });

  it('offers no commands to a host that cannot run them', () => {
    mount();
    type('/');
    expect(rows()).toHaveLength(0);
  });
});

describe('IME composition', () => {
  function pressComposing(key: string): void {
    act(() => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, isComposing: true }));
    });
  }

  // Enter while an IME is composing confirms the candidate word; it must not send the draft.
  it('does not send on an Enter that confirms a composition', () => {
    const send = vi.fn();
    mount({ onSend: send });
    type('konnichiwa');
    pressComposing('Enter');

    expect(send).not.toHaveBeenCalled();
    expect(input().value).toBe('konnichiwa');

    press('Enter');
    expect(send).toHaveBeenCalledWith('konnichiwa');
  });

  it('does not stop a live turn on an Escape that cancels a composition', () => {
    const stop = vi.fn();
    mount({ onStop: stop, streaming: true });
    type('kanji');
    pressComposing('Escape');

    expect(stop).not.toHaveBeenCalled();
  });
});

describe('markdown code in the composer', () => {
  function pressWith(key: string, init: KeyboardEventInit): void {
    act(() => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
    });
  }

  it('breaks the line instead of sending inside an open fenced block', () => {
    const send = vi.fn();
    mount({ onSend: send });
    type('```ts\nconst a = 1');
    press('Enter');

    expect(send).not.toHaveBeenCalled();
    expect(input().value).toBe('```ts\nconst a = 1\n');
  });

  it('closes a freshly opened fence on Enter', () => {
    const send = vi.fn();
    mount({ onSend: send });
    type('```');
    press('Enter');

    expect(send).not.toHaveBeenCalled();
    expect(input().value).toBe('```\n\n```');
  });

  it('sends the raw markdown on Cmd+Enter from inside a block', () => {
    const send = vi.fn();
    mount({ onSend: send });
    type('```\nfoo');
    pressWith('Enter', { metaKey: true });

    expect(send).toHaveBeenCalledWith('```\nfoo');
  });

  it('still sends on Enter once the block is closed', () => {
    const send = vi.fn();
    mount({ onSend: send });
    type('```\nfoo\n```');
    press('Enter');

    expect(send).toHaveBeenCalledWith('```\nfoo\n```');
  });

  it('shows the way-out hint only while the caret is in a block', () => {
    mount();
    type('plain');
    expect(host?.querySelector('[data-testid="composer-code-hint"]')).toBeNull();
    type('```\nfoo');
    expect(host?.querySelector('[data-testid="composer-code-hint"]')).not.toBeNull();
  });

  it('paints a code background behind an inline span', () => {
    mount();
    type('run `ls` now');
    expect(host?.querySelector('[data-code-kind="inline"]')?.textContent).toBe('`ls`');
  });

  it('indents on Tab inside a block and outdents on Shift+Tab', () => {
    mount();
    type('```\nfoo');
    pressWith('Tab', {});
    expect(input().value).toBe('```\nfoo  ');
    type('```\n  foo');
    pressWith('Tab', { shiftKey: true });
    expect(input().value).toBe('```\nfoo');
  });

  it('leaves the block on Escape then Shift+Tab, even with the Shift keydown between', () => {
    mount();
    type('```\n  foo');
    pressWith('Escape', {});
    pressWith('Shift', { shiftKey: true });
    const tab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    act(() => {
      input().dispatchEvent(tab);
    });

    expect(tab.defaultPrevented).toBe(false);
    expect(input().value).toBe('```\n  foo');
  });

  it('does not swallow Tab outside a block', () => {
    mount();
    type('plain');
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => {
      input().dispatchEvent(tab);
    });

    expect(tab.defaultPrevented).toBe(false);
  });

  it('does not send on Alt+Enter inside an open block', () => {
    const send = vi.fn();
    mount({ onSend: send });
    type('```\nfoo');
    pressWith('Enter', { altKey: true });

    expect(send).not.toHaveBeenCalled();
  });

  it('keeps the command menu shut for a slash inside code', () => {
    mount({ onRunCommand: () => {} });
    type('```\n/');
    expect(rows()).toHaveLength(0);
  });
});

describe('skills mid-sentence', () => {
  const skills = {
    skills: [
      { name: 'review', description: 'Review a change.', source: 'project' as const, filePath: '/r/review/SKILL.md' },
      { name: 'ship-it', description: 'Release.', source: 'global' as const, filePath: '/g/ship-it/SKILL.md' },
    ],
    projectDirectory: '/r',
    untrustedProject: null,
    refresh: async () => {},
    trustProject: async () => {},
  };
  const skillRows = () => Array.from(host?.querySelectorAll('[data-testid="skill-picker-option"]') ?? []);
  const marks = () =>
    Array.from(host?.querySelectorAll('[data-skill-token]') ?? []).map(mark => mark.getAttribute('data-skill-token'));

  it('opens the skill menu for a slash after a word, without offering commands', () => {
    mount({ skills, onRunCommand: () => {} });
    type('fix the login bug then /rev');

    expect(skillRows().map(row => row.textContent)).toEqual([expect.stringContaining('review')]);
    // A command run from here would throw away the sentence before it.
    expect(rows()).toHaveLength(0);
  });

  it('puts the picked skill in place and keeps the words before it', () => {
    mount({ skills });
    type('fix the login bug then /rev');
    press('Enter');

    expect(input().value).toBe('fix the login bug then /review ');
    expect(input().selectionStart).toBe(input().value.length);
    expect(skillRows()).toHaveLength(0);
  });

  it('draws a highlight behind known skills only', () => {
    mount({ skills, onRunCommand: () => {} });
    type('first /ship-it after /review, not /nope or /clear');
    expect(marks()).toEqual(['ship-it', 'review']);

    type('just prose');
    expect(host?.querySelector('[data-testid="composer-skill-highlight"]')).toBeNull();
  });

  it('highlights a command only when it leads the draft', () => {
    mount({ skills, onRunCommand: () => {} });
    type('/clear');
    expect(marks()).toEqual(['clear']);
  });
});

describe('the draft and the conversation it belongs to', () => {
  it('does not carry what was typed into the conversation switched to', () => {
    mount({ sessionId: 's1' });
    type('half a thought meant for s1');

    rerender({ sessionId: 's2' });
    expect(input().value).toBe('');
  });

  it('gives each draft back on returning to the conversation it was typed in', () => {
    mount({ sessionId: 's1' });
    type('half a thought meant for s1');
    rerender({ sessionId: 's2' });
    type('something else entirely');

    rerender({ sessionId: 's1' });
    expect(input().value).toBe('half a thought meant for s1');
    rerender({ sessionId: 's2' });
    expect(input().value).toBe('something else entirely');
  });

  // Sending is what ends a draft, so coming back must not resurrect the message just sent.
  it('keeps nothing for a conversation whose draft was sent', () => {
    const send = vi.fn();
    mount({ sessionId: 's1', onSend: send });
    type('ship it');
    press('Enter');
    expect(send).toHaveBeenCalledWith('ship it');

    rerender({ sessionId: 's2' });
    rerender({ sessionId: 's1' });
    expect(input().value).toBe('');
  });

  it('restores a draft saved before the app last quit, and clears it once sent', () => {
    composerDrafts.state.setState({ drafts: { s1: 'typed before the restart' }, hydrated: true });
    const send = vi.fn();
    mount({ sessionId: 's1', onSend: send });
    expect(input().value).toBe('typed before the restart');

    press('Enter');
    expect(send).toHaveBeenCalledWith('typed before the restart');
    expect(composerDrafts.state.getState().drafts).toEqual({});
  });

  it('does not clear a saved draft, even for a moment, when the composer mounts on it', () => {
    composerDrafts.state.setState({ drafts: { s1: 'saved' }, hydrated: true });
    const changes = vi.fn();
    const unsubscribe = composerDrafts.state.subscribe(changes);
    mount({ sessionId: 's1' });
    unsubscribe();
    expect(input().value).toBe('saved');
    expect(changes).not.toHaveBeenCalled();
  });

  it('restores a saved draft that is read in after the conversation opened', () => {
    composerDrafts.state.setState({ drafts: {}, hydrated: false });
    mount({ sessionId: 's1' });
    expect(input().value).toBe('');

    act(() => composerDrafts.state.setState({ drafts: { s1: 'arrived late' }, hydrated: true }));
    expect(input().value).toBe('arrived late');
  });

  it('records what is typed, and forgets it when the composer is emptied', () => {
    mount({ sessionId: 's1' });
    type('work in progress');
    expect(composerDrafts.state.getState().drafts).toEqual({ s1: 'work in progress' });
    type('');
    expect(composerDrafts.state.getState().drafts).toEqual({});
  });

  it('leaves no command menu open from the conversation left behind', () => {
    mount({ sessionId: 's1', onRunCommand: () => {} });
    type('/comp');
    expect(rows()).toHaveLength(1);

    rerender({ sessionId: 's2', onRunCommand: () => {} });
    expect(rows()).toHaveLength(0);
  });
});

describe('the suggested next prompt', () => {
  const placeholder = () => input().getAttribute('placeholder');

  it('comes back when a typed draft is cleared', () => {
    const dismissed = vi.fn();
    mount({ suggestion: 'Add a test', placeholder: 'Send a message...', onSuggestionDismissed: dismissed });
    expect(placeholder()).toBe('Add a test');

    type('Keep going');
    expect(placeholder()).toBe('Send a message...');

    type('');
    expect(placeholder()).toBe('Add a test');
    expect(dismissed).not.toHaveBeenCalled();
  });

  it('comes back when a draft taken with Tab is cleared, and Tab still takes it', () => {
    const dismissed = vi.fn();
    mount({ suggestion: 'Add a test', onSuggestionDismissed: dismissed });

    press('Tab');
    expect(input().value).toBe('Add a test');

    type('');
    expect(placeholder()).toBe('Add a test');
    press('Tab');
    expect(input().value).toBe('Add a test');
    expect(dismissed).not.toHaveBeenCalled();
  });

  it('ends once the draft is sent', () => {
    const dismissed = vi.fn();
    const send = vi.fn();
    mount({ suggestion: 'Add a test', onSuggestionDismissed: dismissed, onSend: send });

    press('Tab');
    press('Enter');
    expect(send).toHaveBeenCalledWith('Add a test');
    expect(dismissed).toHaveBeenCalledTimes(1);
  });
});

describe('a composer that cannot send yet', () => {
  it('keeps the draft on Enter instead of clearing it into a refused send', () => {
    const send = vi.fn();
    mount({ notReady: 'Sign in', onSend: send });

    type('written while signed out');
    press('Enter');

    expect(send).not.toHaveBeenCalled();
    expect(input().value).toBe('written while signed out');
  });

  it('names why on the disabled button instead of offering an action it will refuse', () => {
    mount({ notReady: 'Replying' });

    type('next question');

    const button = document.querySelector<HTMLButtonElement>('[data-testid="chat-send-btn"]');
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('aria-label')).toBe('Replying');
  });

  it('keeps the action label on a command button that stays enabled', () => {
    mount({ notReady: 'Replying', onRunCommand: () => {} });

    type('/loop 5m /review src/index.ts');

    const button = document.querySelector<HTMLButtonElement>('[data-testid="chat-send-btn"]');
    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute('aria-label')).not.toBe('Replying');
  });
});

describe('the attach shortcut', () => {
  const withPick = (overrides: Partial<AttachmentDraft> = {}) => {
    const pick = vi.fn(async () => {});
    return { pick, attachments: { ...draft, pick, ...overrides } };
  };

  function chord(target: EventTarget, init: KeyboardEventInit = { key: 'u', metaKey: true }): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  it('opens the picker on Cmd+U from the page and from the draft, and claims the key', () => {
    const { pick, attachments } = withPick();
    mount({ attachments });

    const fromPage = chord(document.body);
    expect(pick).toHaveBeenCalledTimes(1);
    expect(fromPage.defaultPrevented).toBe(true);

    chord(input(), { key: 'u', ctrlKey: true });
    expect(pick).toHaveBeenCalledTimes(2);
  });

  it('ignores Cmd+Shift+U, Cmd+Alt+U and a plain U', () => {
    const { pick, attachments } = withPick();
    mount({ attachments });

    chord(document.body, { key: 'U', metaKey: true, shiftKey: true });
    chord(document.body, { key: 'u', metaKey: true, altKey: true });
    chord(input(), { key: 'u' });
    expect(pick).not.toHaveBeenCalled();
  });

  it('does nothing while the composer is disabled or an attachment is busy', () => {
    const disabled = withPick();
    mount({ attachments: disabled.attachments, disabled: true });
    chord(document.body);
    expect(disabled.pick).not.toHaveBeenCalled();
    act(() => root?.unmount());
    host?.remove();

    const busy = withPick({ busy: true });
    mount({ attachments: busy.attachments });
    chord(document.body);
    expect(busy.pick).not.toHaveBeenCalled();
  });

  it('leaves other text fields and open modals alone', () => {
    const { pick, attachments } = withPick();
    mount({ attachments });

    const search = document.createElement('input');
    document.body.appendChild(search);
    const fromSearch = chord(search);
    expect(fromSearch.defaultPrevented).toBe(false);
    search.remove();

    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    chord(document.body);
    modal.remove();

    expect(pick).not.toHaveBeenCalled();
  });

  it('still fires from a focused switch or checkbox, which are inputs but not text fields', () => {
    const { pick, attachments } = withPick();
    mount({ attachments });

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    document.body.appendChild(toggle);
    chord(toggle);
    toggle.remove();

    expect(pick).toHaveBeenCalledTimes(1);
  });

  it('ignores the auto-repeat of a held chord', () => {
    const { pick, attachments } = withPick();
    mount({ attachments });
    chord(document.body, { key: 'u', metaKey: true, repeat: true });
    expect(pick).not.toHaveBeenCalled();
  });

  it('binds one window listener for its lifetime and removes it on unmount', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { pick, attachments } = withPick();
    mount({ attachments });
    type('hello');
    type('hello there');

    const bound = add.mock.calls.filter(([name]) => name === 'keydown');
    expect(bound).toHaveLength(1);

    act(() => root?.unmount());
    root = null;
    expect(remove.mock.calls.some(([name, listener]) => name === 'keydown' && listener === bound[0]?.[1])).toBe(true);

    chord(document.body);
    expect(pick).not.toHaveBeenCalled();
    add.mockRestore();
    remove.mockRestore();
  });

  it('blocks sending with a reason and runs the fix button', () => {
    const onSend = vi.fn();
    const onClick = vi.fn();
    mount({ onSend, blockedReason: 'No local model.', blockedAction: { label: 'Open Models', onClick } });
    expect(host?.querySelector('[data-testid="composer-blocked-reason"]')?.textContent).toContain('No local model.');
    expect(host?.querySelector('[data-testid="composer-blocked-reason"]')?.getAttribute('role')).toBe('alert');
    act(() => (host?.querySelector('[data-testid="composer-blocked-action-btn"]') as HTMLElement).click());
    expect(onClick).toHaveBeenCalledOnce();
    expect((host?.querySelector('[data-testid="chat-send-btn"]') as HTMLButtonElement).disabled).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows a blocking notice in place of the reason text and still blocks sending', () => {
    mount({
      blockedReason: 'Ollama is not running.',
      blockedNotice: <span data-testid="composer-test-notice">notice</span>,
    });
    const banner = host?.querySelector('[data-testid="composer-blocked-reason"]');
    expect(banner?.querySelector('[data-testid="composer-test-notice"]')).not.toBeNull();
    expect(banner?.textContent).not.toContain('Ollama is not running.');
    expect(banner?.getAttribute('role')).toBe('group');
    expect((host?.querySelector('[data-testid="chat-send-btn"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('advertises the chord on the attach button', () => {
    mount();
    const button = host?.querySelector('[data-testid="composer-attach-btn"]');
    expect(button?.getAttribute('aria-keyshortcuts')).toBe('Control+U');
  });
});

describe('the context ring slot', () => {
  const contextStatus = (
    <ContextRing
      tokens={34_000}
      limit={262_000}
      modelId="claude-opus-5-5"
      promptCache={undefined}
      streaming={false}
      hasReply
    />
  );

  it('draws the context ring left of the credits ring', () => {
    const markup = statusMarkup({ contextStatus, usage: { ...usage, credits: 10_000 } });
    const context = markup.indexOf('data-testid="composer-context-ring"');
    expect(context).toBeGreaterThan(-1);
    expect(context).toBeLessThan(markup.indexOf('data-testid="composer-status"'));
  });

  it('hides it with the credits ring while disabled or not ready', () => {
    expect(statusMarkup({ contextStatus, disabled: true })).not.toContain('composer-context-ring');
    expect(statusMarkup({ contextStatus, notReady: 'No folder' })).not.toContain('composer-context-ring');
  });
});

describe('session mentions', () => {
  const ID_DOCS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ID_API = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const session = (id: string, title: string, extra: Record<string, unknown> = {}) =>
    ({ id, title, mode: 'chat', messageCount: 1, updatedAt: '2026-10-01T00:00:00.000Z', ...extra }) as never;
  const mentionSessions = [
    session(ID_DOCS, 'Docs pass', { project: { directory: '/w/docs-site', name: 'docs-site', branch: 'main' } }),
    session(ID_API, 'API rework'),
    session('s1', 'Current'),
    session('gone', 'Archived one', { archived: true }),
  ];
  const options = () => Array.from(host?.querySelectorAll('[data-testid="composer-mention-option"]') ?? []);

  it('opens on an at sign, without the open or archived sessions, naming the project folder', () => {
    mount({ mentionSessions });
    type('hello @');
    expect(options().map(option => option.textContent)).toEqual(['Docs passdocs-site', 'API reworkNo project']);
    expect(host?.querySelector('[data-testid="composer-mention-menu"]')).not.toBeNull();
  });

  it('filters by the text after the at sign and stays closed when nothing matches', () => {
    mount({ mentionSessions });
    type('@api');
    expect(options()).toHaveLength(1);
    type('@zzz');
    expect(host?.querySelector('[data-testid="composer-mention-menu"]')).toBeNull();
  });

  it('is off for a host that passes no sessions', () => {
    mount();
    type('@');
    expect(options()).toHaveLength(0);
  });

  it('walks with the arrows, inserts the title on Enter, and sends the markup', () => {
    const send = vi.fn();
    mount({ mentionSessions, onSend: send });
    type('ask @');
    press('ArrowDown');
    press('Enter');
    expect(input().value).toBe('ask @API rework ');

    type('ask @API rework about it');
    press('Enter');
    expect(send).toHaveBeenCalledWith(`ask @[API rework](session:${ID_API}) about it`);
  });

  it('drops a chosen mention whose label was deleted before sending', () => {
    const send = vi.fn();
    mount({ mentionSessions, onSend: send });
    type('@');
    press('Enter');
    expect(input().value).toBe('@Docs pass ');

    type('plain text');
    press('Enter');
    expect(send).toHaveBeenCalledWith('plain text');
  });

  it('closes on Escape and highlights a chosen title', () => {
    mount({ mentionSessions });
    type('@do');
    press('Escape');
    expect(options()).toHaveLength(0);

    type('@');
    press('Enter');
    expect(Array.from(host?.querySelectorAll('[data-skill-token]') ?? []).map(mark => mark.textContent)).toEqual([
      '@Docs pass',
    ]);
  });
});

describe('the "+" menu', () => {
  const plus = () => host?.querySelector<HTMLButtonElement>('[data-testid="composer-plus-btn"]') ?? null;
  const item = (testid: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
  const isDisabled = (element: HTMLElement | null) => element?.getAttribute('aria-disabled') === 'true';

  function open(): void {
    act(() => plus()?.click());
  }

  it('stays the plain attach button where no folder can be added', () => {
    mount({ addFolder: null });
    expect(plus()).toBeNull();
    expect(host?.querySelector('[data-testid="composer-attach-btn"]')).not.toBeNull();
  });

  it('offers Attach a file and Add folder, each running its own action', () => {
    const pick = vi.fn(async () => {});
    const onClick = vi.fn();
    mount({ attachments: { ...draft, pick }, addFolder: { onClick } });
    expect(host?.querySelector('[data-testid="composer-attach-btn"]')).toBeNull();

    open();
    expect(item('composer-attach-item')?.textContent).toContain('Attach a file');
    expect(item('composer-attach-item')?.getAttribute('aria-keyshortcuts')).toBe('Control+U');
    expect(item('composer-add-folder-item')?.textContent).toBe('Add folder...');
    act(() => item('composer-add-folder-item')?.click());
    expect(onClick).toHaveBeenCalledOnce();
    expect(pick).not.toHaveBeenCalled();

    open();
    act(() => item('composer-attach-item')?.click());
    expect(pick).toHaveBeenCalledOnce();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('still offers Add folder with no conversation to attach to', () => {
    const onClick = vi.fn();
    mount({ sessionId: null, disabled: true, addFolder: { onClick } });
    expect(plus()?.disabled).toBe(false);

    open();
    expect(isDisabled(item('composer-attach-item'))).toBe(true);
    expect(isDisabled(item('composer-add-folder-item'))).toBe(false);
    act(() => item('composer-add-folder-item')?.click());
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('is disabled when neither entry can act', () => {
    mount({ disabled: true, addFolder: { onClick: () => {}, disabled: true } });
    expect(plus()?.disabled).toBe(true);
  });

  it('keeps "+" and Attach a file available while Add folder is disabled', () => {
    const pick = vi.fn(async () => {});
    mount({ attachments: { ...draft, pick }, addFolder: { onClick: () => {}, disabled: true } });
    expect(plus()?.disabled).toBe(false);

    open();
    expect(isDisabled(item('composer-attach-item'))).toBe(false);
    act(() => item('composer-attach-item')?.click());
    expect(pick).toHaveBeenCalledOnce();
  });

  it('does not run Add folder while it is disabled', () => {
    const onClick = vi.fn();
    mount({ addFolder: { onClick, disabled: true } });

    open();
    expect(isDisabled(item('composer-add-folder-item'))).toBe(true);
    act(() => item('composer-add-folder-item')?.click());
    expect(onClick).not.toHaveBeenCalled();
  });
});

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
      'Start a conversation to type here'
    );
  });

  // Only the owner knows WHY the box is shut - no session yet, or one being made - and the old
  // fixed copy told a user with no sessions at all to pick one.
  it('lets the owner name the step the disabled composer is waiting on', () => {
    expect(
      composerPlaceholder({ ...base, disabled: true, suggestion: null, disabledPlaceholder: 'Starting a session...' })
    ).toBe('Starting a session...');
  });

  it('goes back to the ordinary prompt once the draft has content', () => {
    expect(composerPlaceholder({ ...base, text: 'Keep', suggestion: 'Add a test' })).toBe('Send a message...');
  });
});

describe('the `/` menu', () => {
  it('opens on a slash typed into an empty composer', () => {
    expect(skillQuery('/')?.query).toBe('');
    expect(matchCommands('', 'code').map(command => command.name)).toEqual([
      'clear',
      'compact',
      'pr',
      'add-dir',
      'loop',
    ]);
  });

  // A path is a path, and a command only runs as the whole draft: one picked mid-sentence would
  // throw the sentence away. A skill mid-sentence is fine, so the token is found, just not offered
  // commands.
  it('offers commands only for a token that is the whole draft', () => {
    expect(skillQuery('fix /clear')?.wholeDraft).toBe(false);
    expect(skillQuery('/clear')?.wholeDraft).toBe(true);
    expect(skillQuery('see src/clear.ts')).toBeNull();
  });

  it('offers /pr only in a Code session, and treats it as text elsewhere', () => {
    expect(matchCommands('', 'chat').map(command => command.name)).toEqual(['clear', 'compact', 'add-dir', 'loop']);
    expect(composerSubmitAction('/pr https://github.com/example-org/widgets/pull/611', 'chat')).toEqual({
      kind: 'send',
    });
    expect(composerSubmitAction('/pr https://github.com/example-org/widgets/pull/611', 'code')).toMatchObject({
      kind: 'command',
      invocation: { command: { name: 'pr' } },
    });
  });

  it('filters as the name is typed, and empties when nothing matches', () => {
    expect(matchCommands('com', 'code').map(command => command.name)).toEqual(['compact']);
    expect(matchCommands('cle', 'code').map(command => command.name)).toEqual(['clear']);
    expect(matchCommands('zz', 'code')).toEqual([]);
    expect(matchCommands('add', 'chat').map(command => command.name)).toEqual(['add-dir']);
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
    const action = composerSubmitAction('/compact focus on the auth work', 'chat');
    expect(action.kind).toBe('command');
    if (action.kind !== 'command') throw new Error('expected a command');
    expect(action.invocation.command.name).toBe('compact');
    expect(action.invocation.args).toBe('focus on the auth work');
  });

  it('runs a bare command with no argument', () => {
    const action = composerSubmitAction('/clear', 'chat');
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
      expect(composerSubmitAction(text, 'code')).toEqual({ kind: 'send' });
      expect(parseCommandInvocation(text, 'code')).toBeNull();
    }
  );
});

describe('the attach shortcut', () => {
  const chord = (key: string, held: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
    isAttachChord({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...held });

  it('matches the modifier plus U and nothing else', () => {
    expect(chord('u', { metaKey: true })).toBe(true);
    expect(chord('u', { ctrlKey: true })).toBe(true);
    expect(chord('U', { metaKey: true })).toBe(true);
    expect(chord('u')).toBe(false);
    expect(chord('U', { metaKey: true, shiftKey: true })).toBe(false);
    expect(chord('u', { metaKey: true, altKey: true })).toBe(false);
    expect(chord('i', { metaKey: true })).toBe(false);
  });

  it('names the chord the way each platform does', () => {
    expect(attachShortcut(true)).toEqual({ label: '\u2318U', aria: 'Meta+U' });
    expect(attachShortcut(false)).toEqual({ label: 'Ctrl+U', aria: 'Control+U' });
  });
});

describe('/add-dir', () => {
  it.each(['code', 'chat'] as const)('is offered in a %s session, with its optional argument hint', mode => {
    const command = matchCommands('add', mode)[0];
    expect(command?.name).toBe('add-dir');
    expect(command?.argumentHint).toBe('[path]');
    // Picking it from the menu runs it bare, which opens the picker.
    expect(command?.requiresArgument).toBeUndefined();
  });

  it('carries a path with spaces whole, and runs bare with none', () => {
    expect(parseCommandInvocation('/add-dir ~/My Projects/notes', 'code')).toMatchObject({
      command: { name: 'add-dir' },
      args: '~/My Projects/notes',
    });
    expect(parseCommandInvocation('/ADD-DIR', 'chat')).toMatchObject({ command: { name: 'add-dir' }, args: '' });
  });

  it('reads the path out of the argument, or nothing for the picker', () => {
    expect(addDirPath('')).toBeUndefined();
    expect(addDirPath('   ')).toBeUndefined();
    expect(addDirPath('../shared')).toBe('../shared');
    expect(addDirPath('"/Users/me/My Folder"')).toBe('/Users/me/My Folder');
    expect(addDirPath("'~/notes'")).toBe('~/notes');
    expect(addDirPath('""')).toBeUndefined();
    // Only a matching pair is a quote; a lone one is part of the name.
    expect(addDirPath('"half')).toBe('"half');
  });

  it('is not a path starting with /add-dir', () => {
    expect(parseCommandInvocation('/add-dirs', 'code')).toBeNull();
    expect(composerSubmitAction('/add-dir/x', 'code')).toEqual({ kind: 'send' });
  });
});

describe('appendToDraft', () => {
  it('adds the text after the draft with one space between', () => {
    expect(appendToDraft('', 'the `lid` part ')).toBe('the `lid` part ');
    expect(appendToDraft('make', 'the `lid` part ')).toBe('make the `lid` part ');
    expect(appendToDraft('make ', 'the `lid` part ')).toBe('make the `lid` part ');
  });
});

describe('recallPromptAction', () => {
  const history = ['newest', 'older', 'oldest'];
  const key = (
    name: string,
    extra: Partial<{ shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}
  ) => ({
    key: name,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    ...extra,
  });
  const at = (text: string, caret = 0, end = caret) => ({ text, selectionStart: caret, selectionEnd: end });

  it('fills an empty draft with the last prompt, and goes further back on each Up', () => {
    const first = recallPromptAction(key('ArrowUp'), at(''), history, null);
    expect(first).toEqual({ text: 'newest', recall: { index: 0, text: 'newest' } });
    const second = recallPromptAction(key('ArrowUp'), at('newest'), history, first!.recall);
    expect(second).toEqual({ text: 'older', recall: { index: 1, text: 'older' } });
    const third = recallPromptAction(key('ArrowUp'), at('older'), history, second!.recall);
    expect(third?.text).toBe('oldest');
    // Past the oldest the key is left alone.
    expect(recallPromptAction(key('ArrowUp'), at('oldest'), history, third!.recall)).toBeNull();
  });

  it('moves forward on Down, and past the newest back to an empty box', () => {
    const older = { index: 1, text: 'older' };
    expect(recallPromptAction(key('ArrowDown'), at('older'), history, older)).toEqual({
      text: 'newest',
      recall: { index: 0, text: 'newest' },
    });
    expect(recallPromptAction(key('ArrowDown'), at('newest'), history, { index: 0, text: 'newest' })).toEqual({
      text: '',
      recall: null,
    });
  });

  it('never overwrites a draft the user typed, or a recalled one they edited', () => {
    expect(recallPromptAction(key('ArrowUp'), at('my draft'), history, null)).toBeNull();
    expect(recallPromptAction(key('ArrowUp'), at('newest, changed'), history, { index: 0, text: 'newest' })).toBeNull();
    expect(recallPromptAction(key('ArrowDown'), at('my draft', 8), history, null)).toBeNull();
    // Down with nothing recalled has nowhere to go.
    expect(recallPromptAction(key('ArrowDown'), at(''), history, null)).toBeNull();
  });

  it('restarts from the newest when the draft was emptied after a recall', () => {
    expect(recallPromptAction(key('ArrowUp'), at(''), history, { index: 2, text: 'oldest' })?.text).toBe('newest');
  });

  it('only acts with the caret at the start for Up, and on the last line for Down', () => {
    const recalled = { index: 0, text: 'line one\nline two' };
    const lines = ['line one\nline two', 'older'];
    expect(recallPromptAction(key('ArrowUp'), at('line one\nline two', 3), lines, recalled)).toBeNull();
    expect(recallPromptAction(key('ArrowUp'), at('line one\nline two', 0, 4), lines, recalled)).toBeNull();
    expect(recallPromptAction(key('ArrowDown'), at('line one\nline two', 0), lines, recalled)).toBeNull();
    expect(recallPromptAction(key('ArrowDown'), at('line one\nline two', 12), lines, recalled)).toEqual({
      text: '',
      recall: null,
    });
  });

  it('leaves modified arrows and other keys alone, and does nothing with no history', () => {
    for (const modifier of ['shiftKey', 'altKey', 'metaKey', 'ctrlKey'] as const) {
      expect(recallPromptAction(key('ArrowUp', { [modifier]: true }), at(''), history, null)).toBeNull();
    }
    expect(recallPromptAction(key('Enter'), at(''), history, null)).toBeNull();
    expect(recallPromptAction(key('ArrowUp'), at(''), [], null)).toBeNull();
  });
});

const key = (
  name: string,
  mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}
) => ({
  key: name,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

const at = (text: string, selectionStart: number, selectionEnd = selectionStart) => ({
  text,
  selectionStart,
  selectionEnd,
});

/** Apply an edit the way Composer does, returning the new text and selection. */
function apply(text: string, edit: ComposerEdit) {
  return {
    text: text.slice(0, edit.start) + edit.insert + text.slice(edit.end),
    selection: [edit.selectionStart, edit.selectionEnd],
  };
}

function editFor(...args: Parameters<typeof fenceKeyAction>) {
  const action = fenceKeyAction(...args);
  if (action.kind !== 'edit') throw new Error(`expected an edit, got ${action.kind}`);
  return apply(args[1].text, action.edit);
}

describe('codeRanges', () => {
  it('finds an inline span, backticks included', () => {
    expect(codeRanges('use `x` here')).toEqual([{ kind: 'inline', start: 4, end: 7 }]);
  });

  it('matches a double-backtick span that contains a single backtick', () => {
    expect(codeRanges('a ``b`c`` d')).toEqual([{ kind: 'inline', start: 2, end: 9 }]);
  });

  it('leaves an unmatched backtick unpainted', () => {
    expect(codeRanges('it`s fine')).toEqual([]);
  });

  it('finds a closed fenced block from its opening line to its closing one', () => {
    const text = 'look:\n```ts\nconst a = 1\n```\nafter `b`';
    expect(codeRanges(text)).toEqual([
      { kind: 'block', start: 6, end: 27 },
      { kind: 'inline', start: 34, end: 37 },
    ]);
  });

  it('runs a block still being typed to the end of the draft', () => {
    expect(codeRanges('```\nfoo')).toEqual([{ kind: 'block', start: 0, end: 7 }]);
  });

  it('does not paint backticks inside a block as inline spans', () => {
    expect(codeRanges('```\n`x`\n```')).toEqual([{ kind: 'block', start: 0, end: 11 }]);
  });

  it('needs a closing fence at least as long as the opening one', () => {
    expect(codeRanges('````\nx\n```')).toEqual([{ kind: 'block', start: 0, end: 10 }]);
    expect(codeRanges('```\nx\n````')).toEqual([{ kind: 'block', start: 0, end: 10 }]);
  });

  it('does not treat a four-space-indented fence or a tilde fence as a block', () => {
    expect(codeRanges('    ```\nx')).toEqual([]);
    expect(codeRanges('~~~\nx\n~~~')).toEqual([]);
  });
});

describe('caretInCode', () => {
  it('is true between the backticks of a span and false on its edges', () => {
    expect(caretInCode('see `/path` x', 6)).toBe(true);
    expect(caretInCode('see `/path` x', 4)).toBe(false);
    expect(caretInCode('see `/path` x', 11)).toBe(false);
  });

  it('is true inside an open block and false after it closes', () => {
    expect(caretInCode('```\n/', 5)).toBe(true);
    expect(caretInCode('```\nx\n```\n/', 11)).toBe(false);
  });
});

describe('fenceKeyAction', () => {
  it('leaves every key alone outside a block', () => {
    expect(fenceKeyAction(key('Enter'), at('hello', 5), false)).toEqual({ kind: 'default' });
    expect(fenceKeyAction(key('Tab'), at('hello', 5), false)).toEqual({ kind: 'default' });
    expect(fenceKeyAction(key('Enter', { metaKey: true }), at('hello', 5), false)).toEqual({ kind: 'default' });
  });

  it('leaves Enter alone just after a typed closing fence', () => {
    expect(fenceKeyAction(key('Enter'), at('```\nfoo\n```', 11), false)).toEqual({ kind: 'default' });
  });

  it('auto-closes a fresh fence on Enter, caret on the empty line between', () => {
    expect(editFor(key('Enter'), at('```ts', 5), false)).toEqual({ text: '```ts\n\n```', selection: [6, 6] });
  });

  it('closes with as many backticks as the fence opened with', () => {
    expect(editFor(key('Enter'), at('````', 4), false).text).toBe('````\n\n````');
  });

  it('does not add a second closing fence when the block is already closed', () => {
    expect(editFor(key('Enter'), at('```\n\n```', 3), false)).toEqual({ text: '```\n\n\n```', selection: [4, 4] });
  });

  it('breaks the line instead of sending inside a block, keeping its indent', () => {
    expect(editFor(key('Enter'), at('```\nfoo\n```', 7), false)).toEqual({
      text: '```\nfoo\n\n```',
      selection: [8, 8],
    });
    expect(editFor(key('Enter'), at('```\n  foo', 9), false)).toEqual({ text: '```\n  foo\n  ', selection: [12, 12] });
  });

  it('sends on Cmd or Ctrl+Enter inside a block', () => {
    expect(fenceKeyAction(key('Enter', { metaKey: true }), at('```\nfoo', 7), false)).toEqual({ kind: 'submit' });
    expect(fenceKeyAction(key('Enter', { ctrlKey: true }), at('```\nfoo', 7), false)).toEqual({ kind: 'submit' });
  });

  it('leaves Shift+Enter to the textarea inside a block', () => {
    expect(fenceKeyAction(key('Enter', { shiftKey: true }), at('```\nfoo', 7), false)).toEqual({ kind: 'default' });
  });

  it('indents at the caret on Tab', () => {
    expect(editFor(key('Tab'), at('```\nfoo', 4), false)).toEqual({ text: '```\n  foo', selection: [6, 6] });
  });

  it('indents every selected line on Tab', () => {
    expect(editFor(key('Tab'), at('```\na\nb', 4, 7), false)).toEqual({ text: '```\n  a\n  b', selection: [6, 11] });
  });

  it('outdents the line on Shift+Tab', () => {
    expect(editFor(key('Tab', { shiftKey: true }), at('```\n  foo', 9), false)).toEqual({
      text: '```\nfoo',
      selection: [7, 7],
    });
  });

  it('swallows Shift+Tab on a line with nothing to outdent, so focus does not jump', () => {
    expect(fenceKeyAction(key('Tab', { shiftKey: true }), at('```\nfoo', 7), false)).toEqual({ kind: 'consume' });
  });

  // Escape then Tab is the way out of a block; without it Tab would be a keyboard trap.
  it('hands Tab back to focus navigation right after Escape', () => {
    expect(fenceKeyAction(key('Tab'), at('```\nfoo', 7), true)).toEqual({ kind: 'default' });
    expect(fenceKeyAction(key('Tab', { shiftKey: true }), at('```\n  foo', 9), true)).toEqual({ kind: 'default' });
  });
});

function bridge(saved: ComposerDrafts = {}) {
  return {
    list: vi.fn(async () => saved),
    save: vi.fn(async (_sessionId: string, _text: string) => undefined),
  };
}

describe('createComposerDraftsStore', () => {
  it('restores saved drafts on hydrate', async () => {
    const api = bridge({ s1: 'from last launch' });
    const drafts = createComposerDraftsStore(() => api);
    await drafts.hydrate();
    expect(drafts.state.getState()).toEqual({ drafts: { s1: 'from last launch' }, hydrated: true });
  });

  it('keeps text typed before hydrate over the saved copy', async () => {
    const api = bridge({ s1: 'old', s2: 'cleared since' });
    const drafts = createComposerDraftsStore(() => api);
    drafts.update('s1', 'new');
    drafts.update('s2', 'x');
    drafts.update('s2', '');
    await drafts.hydrate();
    expect(drafts.state.getState().drafts).toEqual({ s1: 'new' });
  });

  it('sends every change to main at once, with no delay a quit could cut short', () => {
    const api = bridge();
    const drafts = createComposerDraftsStore(() => api);
    drafts.update('s1', 'h');
    drafts.update('s1', 'he');
    drafts.update('s2', 'two');
    expect(api.save.mock.calls).toEqual([
      ['s1', 'h'],
      ['s1', 'he'],
      ['s2', 'two'],
    ]);
  });

  it('clears when the composer is emptied or sent', () => {
    const api = bridge();
    const drafts = createComposerDraftsStore(() => api);
    drafts.update('s1', 'about to send');
    drafts.update('s1', '');
    expect(api.save.mock.calls).toEqual([
      ['s1', 'about to send'],
      ['s1', ''],
    ]);
    expect(drafts.state.getState().drafts).toEqual({});
  });

  it('treats blank text as no draft and does not save an unchanged one', () => {
    const api = bridge();
    const drafts = createComposerDraftsStore(() => api);
    drafts.update('s1', '   ');
    drafts.update('s1', '');
    expect(api.save).not.toHaveBeenCalled();
    expect(drafts.state.getState().drafts).toEqual({});
  });

  it('keeps drafts in memory when there is no bridge', async () => {
    const drafts = createComposerDraftsStore(() => undefined);
    drafts.update('s1', 'only here');
    await drafts.hydrate();
    expect(drafts.state.getState()).toEqual({ drafts: { s1: 'only here' }, hydrated: true });
  });

  it('keeps the text of a conversation that does not exist yet in memory without sending it to main', () => {
    const api = bridge();
    const drafts = createComposerDraftsStore(() => api);
    drafts.update('draft-123', 'not a session yet');
    expect(drafts.state.getState().drafts).toEqual({ 'draft-123': 'not a session yet' });
    expect(api.save).not.toHaveBeenCalled();
  });
});

/**
 * Rendered to a string, like ApprovalChoice's tests and for the same reason: this package's
 * vitest runs on `node`.
 *
 * So what is asked here is the CLOSED row - that an image is wrapped in a real button and a text
 * file is not. The viewer is a portal that mounts only once opened, so it is absent from this
 * markup by design, which is itself worth asserting.
 */
const IMAGE: ChatAttachment = {
  id: 'a1',
  kind: 'image',
  name: 'wide-screenshot.png',
  mediaType: 'image/png',
  sourceBytes: 2048,
  byteSize: 2048,
  truncated: false,
};

const TEXT: ChatAttachment = { ...IMAGE, id: 'a2', kind: 'text', name: 'server.log', mediaType: 'text/plain' };

const PDF: ChatAttachment = {
  ...IMAGE,
  id: 'a3',
  kind: 'pdf',
  name: 'report.pdf',
  mediaType: 'application/pdf',
  pages: 3,
};

/**
 * readAttachment is what the tile awaits for its bytes. Static rendering never runs the effect,
 * so the stub only has to exist; the markup under test is the pre-bytes tile either way.
 */
function markup(attachments: readonly ChatAttachment[]): string {
  vi.stubGlobal('window', { b4m: { chat: { readAttachment: () => Promise.resolve(null) } } });
  return renderToStaticMarkup(<AttachmentRow sessionId="s1" attachments={attachments} />);
}

describe('AttachmentRow', () => {
  it('keeps a text attachment inert - there is nothing cropped to reveal', () => {
    const html = markup([TEXT]);
    expect(html).toContain('server.log');
    expect(html).not.toContain('data-testid="attachment-view-btn"');
  });

  it('shows a PDF as a document tile with its page count, never as an image or viewer', () => {
    const html = renderToStaticMarkup(<AttachmentRow sessionId="s1" attachments={[PDF]} onRemove={() => {}} />);
    expect(html).toContain('report.pdf');
    expect(html).toContain('data-testid="attachment-pdf-icon"');
    expect(html).toContain('3 pages');
    expect(html).toContain('data-testid="attachment-remove-btn"');
    expect(html).not.toContain('data-testid="attachment-view-btn"');
    expect(html).not.toContain('data-testid="attachment-thumbnail"');
  });

  it('does not mount the viewer until the tile is clicked', () => {
    expect(markup([IMAGE])).not.toContain('data-testid="attachment-viewer-image"');
  });

  it('leaves the remove control a separate button, so removing cannot also open the viewer', () => {
    const html = renderToStaticMarkup(<AttachmentRow sessionId="s1" attachments={[IMAGE]} onRemove={() => {}} />);
    expect(html).toContain('data-testid="attachment-remove-btn"');
    // Siblings inside the tile, never nested - a click on one is never a click on the other.
    expect(html).not.toMatch(/attachment-view-btn[\s\S]*?attachment-remove-btn[\s\S]*?<\/button>\s*<\/button>/);
  });
});
