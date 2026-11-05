// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import { ContextRing } from './ContextRing';
import type { ComposerUsage } from './statusLine';
import type { AttachmentDraft } from './useAttachments';

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
  /**
   * The whole status line is one ring now. The dot moved to the account strip and the words
   * went with it, so nothing here is drawn as text - which is exactly why the figure has to
   * survive as the ring's accessible name rather than disappearing with the label.
   */
  it('draws the ring and nothing else, keeping the figure as its name', () => {
    expect(statusMarkup()).not.toContain('composer-status-text');
    expect(statusMarkup()).not.toContain('turn-dot');
    expect(ringLabel()).toBe('Credits 50% of monthly plan allowance');
    expect(ringValue()).toBe(50);
  });

  it('keeps the ring up through a turn in flight', () => {
    expect(hasRing({ streaming: true })).toBe(true);
    expect(ringLabel({ streaming: true })).toBe('Credits 50% of monthly plan allowance');
  });

  it('floors a tiny positive balance share so it remains visible', () => {
    const tiny = { ...usage, credits: 1, monthlyAllowance: 50_000 };
    expect(ringValue({ usage: tiny })).toBe(4);
    expect(ringLabel({ usage: tiny })).toBe('Credits &lt;1% of monthly plan allowance');
  });

  it('draws an empty ring when no finite monthly allowance is stated', () => {
    const unstated = { ...usage, credits: 31_667, monthlyAllowance: null };
    expect(ringValue({ usage: unstated })).toBe(0);
    expect(ringLabel({ usage: unstated })).toBe('Credits personal balance; no monthly plan allowance');
  });

  it('clamps rollover above the allowance to a full arc while stating the real percentage', () => {
    const rollover = { ...usage, credits: 75_000, monthlyAllowance: 50_000 };
    expect(ringValue({ usage: rollover })).toBe(100);
    expect(ringLabel({ usage: rollover })).toBe('Credits 150% of monthly plan allowance');
  });

  // Nothing to measure and nothing to say: the sidebar dot speaks for these, so a ring here
  // would be a glyph standing for nothing.
  it('draws no ring where there is no conversation to measure', () => {
    expect(hasRing({ disabled: true })).toBe(false);
    expect(hasRing({ notReady: 'No folder' })).toBe(false);
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

// jsdom implements no layout, so the picker's scroll-the-highlight-into-view has nothing to call.
Element.prototype.scrollIntoView ??= () => {};

let root: Root | null = null;
let host: HTMLElement | null = null;

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
  it('opens on a slash in an empty composer and lists every command', () => {
    mount({ onRunCommand: () => {}, sessionMode: 'code' });
    expect(rows()).toHaveLength(0);

    type('/');
    expect(rows().map(row => row.getAttribute('data-command-name'))).toEqual(['clear', 'compact', 'pr', 'add-dir']);
    expect(rows()[3].textContent).toContain('[path]');
  });

  it('leaves the Code-only commands out of a Chat conversation', () => {
    mount({ onRunCommand: () => {}, sessionMode: 'chat' });
    type('/');
    expect(rows().map(row => row.getAttribute('data-command-name'))).toEqual(['clear', 'compact', 'add-dir']);
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
    act(() => (host?.querySelector('[data-testid="composer-blocked-action-btn"]') as HTMLElement).click());
    expect(onClick).toHaveBeenCalledOnce();
    expect((host?.querySelector('[data-testid="chat-send-btn"]') as HTMLButtonElement).disabled).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
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
    const markup = statusMarkup({ contextStatus });
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
