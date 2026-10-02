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
    expect(ringLabel()).toBe('Context 22%');
    expect(ringValue()).toBe(22);
  });

  // The behaviour the ring was added to protect: a turn in flight is when the figure matters
  // most, and it holds the last measured request rather than blanking.
  it('keeps the ring up through a turn in flight', () => {
    expect(hasRing({ streaming: true })).toBe(true);
    expect(ringLabel({ streaming: true })).toBe('Context 22%');
  });

  /**
   * A measured context under a percent would draw an arc a few pixels long, which is the empty
   * ring that means nothing was measured at all. The floor is what keeps the two apart - the
   * same thing "<1%" does for the words.
   */
  it('floors the arc so a tiny measured context still reads as measured', () => {
    const tiny = { contextTokens: 900, contextWindow: 1_050_000, credits: 31_667 };
    expect(ringValue({ usage: tiny })).toBe(4);
    // Escaped because this reads the attribute out of static markup, not out of the DOM.
    expect(ringLabel({ usage: tiny })).toBe('Context &lt;1%');
  });

  /**
   * A determinate ring draws 0% and "no idea" identically, so an unstated window draws the bare
   * track instead of an arc. The ring stays: it is the tooltip's hover target, and the balance
   * lives in that tooltip whether or not a window was ever stated.
   */
  it('draws an empty ring, not a full-looking one, for a window the catalog does not state', () => {
    const unstated = { contextTokens: 44_000, contextWindow: null, credits: 31_667 };
    expect(ringValue({ usage: unstated })).toBe(0);
    expect(ringLabel({ usage: unstated })).toBe('Context --');
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
