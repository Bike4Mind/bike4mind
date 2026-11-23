// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatMessage } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageThread } from './MessageThread';
import { findShortcut } from './useThreadFind';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const at = '2026-11-01T00:00:00.000Z';

const thread: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'where is the needle?', createdAt: at },
  {
    id: 'a1',
    role: 'assistant',
    content: '',
    createdAt: at,
    rounds: [
      { text: 'Let me look.', toolCallIds: ['c1'] },
      { text: 'Found the needle.', toolCallIds: [] },
    ],
    toolCalls: [
      {
        id: 'c1',
        name: 'bash_execute',
        input: { command: 'cat haystack.txt' },
        status: 'done',
        preview: `${'hay\n'.repeat(80)}needle\n`,
      },
    ],
  },
  {
    id: 'r1',
    role: 'user',
    content: 'a relayed needle',
    relay: { fromSessionId: 's2', fromTitle: 'Other', hops: 1 },
    createdAt: at,
  },
];

describe('find in the open conversation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Element.prototype.scrollIntoView = () => undefined;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (findable = true, messages = thread) =>
    act(() =>
      root.render(
        <CssVarsProvider>
          <MessageThread
            messages={messages}
            sessionId="s1"
            streaming={false}
            onRespond={() => undefined}
            onContinue={() => undefined}
            findable={findable}
          />
        </CssVarsProvider>
      )
    );

  const one = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  // Both modifiers, so the chord is Mod+key whichever platform the test DOM reports.
  const chord = (key: string, init: KeyboardEventInit = {}) =>
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key, metaKey: true, ctrlKey: true, bubbles: true, cancelable: true, ...init })
      );
    });
  const inInput = (key: string, init: KeyboardEventInit = {}) =>
    act(() => {
      one('chat-find-input')!.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
      );
    });
  const type = (text: string) => {
    const input = one('chat-find-input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const toolRow = () => one('chat-tool-row') as HTMLDetailsElement;
  const relay = () => one('chat-message-relay') as HTMLDetailsElement;

  it('opens on Mod+F with the input focused, and counts matches in collapsed and clipped content', () => {
    render();
    expect(one('chat-find-bar')).toBeNull();
    chord('f');
    expect(one('chat-find-bar')).not.toBeNull();
    expect(document.activeElement).toBe(one('chat-find-input'));

    type('NEEDLE');
    // User text, the tool's output, the second round, the relay: the last is current.
    expect(one('chat-find-count')?.textContent).toBe('4 of 4');
    expect(relay().open).toBe(true);
    expect(toolRow().open).toBe(false);
  });

  it('cycles with Enter, Shift+Enter and Mod+G, opening the tool row and expanding its clipped output', () => {
    render();
    chord('f');
    type('needle');

    inInput('Enter', { shiftKey: true });
    expect(one('chat-find-count')?.textContent).toBe('3 of 4');
    inInput('Enter', { shiftKey: true });
    expect(one('chat-find-count')?.textContent).toBe('2 of 4');
    expect(toolRow().open).toBe(true);
    expect(one('chat-tool-detail-output-clip')?.dataset.expanded).toBe('true');

    chord('g');
    expect(one('chat-find-count')?.textContent).toBe('3 of 4');
    chord('G', { shiftKey: true });
    chord('G', { shiftKey: true });
    expect(one('chat-find-count')?.textContent).toBe('1 of 4');
    inInput('Enter', { shiftKey: true });
    expect(one('chat-find-count')?.textContent).toBe('4 of 4');
    inInput('Enter');
    expect(one('chat-find-count')?.textContent).toBe('1 of 4');
  });

  it('honours the case toggle', () => {
    render();
    chord('f');
    type('Found');
    expect(one('chat-find-count')?.textContent).toBe('1 of 1');
    act(() => one('chat-find-case-toggle')!.click());
    type('found');
    expect(one('chat-find-count')?.textContent).toBe('No results');
    expect(one('chat-find-case-toggle')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('closes on Escape and leaves what it opened open', () => {
    render();
    chord('f');
    type('needle');
    inInput('Escape');
    expect(one('chat-find-bar')).toBeNull();
    expect(relay().open).toBe(true);
  });

  it('opens the section folded above a /clear when the match is in it', () => {
    render(true, [
      { id: 'old', role: 'user', content: 'an old needle', createdAt: at },
      { id: 'cut', role: 'assistant', content: '', boundary: { kind: 'clear' }, createdAt: at },
      { id: 'new', role: 'user', content: 'something else', createdAt: at },
    ]);
    const earlier = one('chat-earlier-messages') as HTMLDetailsElement;
    expect(earlier.open).toBe(false);
    chord('f');
    type('needle');
    expect(one('chat-find-count')?.textContent).toBe('1 of 1');
    expect(earlier.open).toBe(true);
    expect(container.querySelector('[data-find-scope="message:old"]')?.textContent).toBe('an old needle');
  });

  it('is not bound on a thread that is not findable', () => {
    render(false);
    chord('f');
    expect(one('chat-find-bar')).toBeNull();
  });
});

describe('findShortcut', () => {
  const key = (k: string, init: Partial<KeyboardEvent> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  });

  it('maps Cmd on a Mac and Ctrl elsewhere', () => {
    expect(findShortcut(key('f', { metaKey: true }), true)).toBe('open');
    expect(findShortcut(key('f', { ctrlKey: true }), true)).toBeNull();
    expect(findShortcut(key('f', { ctrlKey: true }), false)).toBe('open');
    expect(findShortcut(key('g', { metaKey: true }), true)).toBe('next');
    expect(findShortcut(key('G', { metaKey: true, shiftKey: true }), true)).toBe('previous');
  });

  it('leaves Mod+Shift+F (sidebar search) and Alt chords alone', () => {
    expect(findShortcut(key('F', { metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(findShortcut(key('f', { metaKey: true, altKey: true }), true)).toBeNull();
    expect(findShortcut(key('f'), true)).toBeNull();
  });
});
