// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
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
  remove: () => {},
  clear: () => {},
};

const usage: ComposerUsage = { contextTokens: 44_000, contextWindow: 200_000, credits: 31_667 };

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

function indicator(props: Partial<Parameters<typeof Composer>[0]> = {}): string {
  const text = statusMarkup(props).match(/data-testid="composer-status-text"[^>]*>([^<]*)</);
  return text?.[1] ?? '';
}

/** Whether the occupancy ring was drawn at all - its absence is how "unknown" is said. */
function hasRing(props: Partial<Parameters<typeof Composer>[0]> = {}): boolean {
  return statusMarkup(props).includes('data-testid="composer-status-ring"');
}

describe('the composer indicator', () => {
  it('replaces the idle word with how full the context window is', () => {
    expect(indicator()).toBe('Context 22%');
  });

  /**
   * The behaviour this used to assert the opposite of. A turn in flight is the moment the
   * figure matters most, and the dot beside it is what says a reply is running - so the usage
   * stays put rather than being replaced by a word the dot already carries.
   */
  it('keeps the figure up through a turn in flight', () => {
    expect(indicator({ streaming: true })).toBe('Context 22%');
    expect(hasRing({ streaming: true })).toBe(true);
  });

  // Only where there is genuinely nothing measured to hold on to: a brand new conversation
  // whose first reply is still streaming.
  it('falls back to the working word only when nothing was ever measured', () => {
    expect(indicator({ streaming: true, usage: null })).toBe('Working');
  });

  // The three states that say something the user may need to act on. They outrank the usage
  // line, which is the one state that used to carry no information at all.

  it('still says when there is no session', () => {
    expect(indicator({ disabled: true })).toBe('No session');
  });

  it('still names a Code session with no folder', () => {
    expect(indicator({ notReady: 'No folder' })).toBe('No folder');
  });

  it('falls back to the old word when it has no figure to show', () => {
    expect(indicator({ usage: { contextTokens: null, contextWindow: null, credits: null } })).toBe('Ready');
    expect(indicator({ usage: null })).toBe('Ready');
  });

  /**
   * A determinate ring draws 0% and "no idea" identically, so an unstated window gets no ring
   * at all. Drawing one empty would read as a conversation with nothing in it, which is the
   * opposite of what is true.
   */
  it('draws no ring for a window the catalog does not state', () => {
    expect(hasRing({ usage: { contextTokens: 44_000, contextWindow: null, credits: 31_667 } })).toBe(false);
    expect(indicator({ usage: { contextTokens: 44_000, contextWindow: null, credits: 31_667 } })).toBe('Context --');
  });

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

function mount(props: Partial<Parameters<typeof Composer>[0]> = {}): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
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
    mount({ onRunCommand: () => {} });
    expect(rows()).toHaveLength(0);

    type('/');
    expect(rows().map(row => row.getAttribute('data-command-name'))).toEqual(['clear', 'compact']);
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
