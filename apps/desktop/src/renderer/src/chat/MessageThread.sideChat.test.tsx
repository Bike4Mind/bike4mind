// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatMessage } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageThread } from './MessageThread';
import { QuoteChip } from './QuoteChip';
import { SessionOpenerContext } from './SessionLink';

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

Range.prototype.getBoundingClientRect ??= () => new DOMRect(100, 200, 80, 16);

const at = '2026-11-06T00:00:00.000Z';

const opening: ChatMessage = {
  id: 'o1',
  role: 'user',
  content: 'model copy with the parent excerpt',
  display: '> the highlighted passage',
  system: true,
  sideChatOf: { sessionId: 'parent-1', title: 'Monads' },
  createdAt: at,
};

const reply: ChatMessage = { id: 'a1', role: 'assistant', content: 'A monad is a monoid.', createdAt: at };

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
  document.getSelection()?.removeAllRanges();
});

const find = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

describe('a side chat in the thread', () => {
  it('opens with where it branched from, linked back, and the passage instead of the model copy', () => {
    const open = vi.fn();
    act(() =>
      root.render(
        <CssVarsProvider>
          <SessionOpenerContext.Provider value={open}>
            <MessageThread
              messages={[opening]}
              sessionId="child-1"
              streaming={false}
              onRespond={() => undefined}
              onContinue={() => undefined}
            />
          </SessionOpenerContext.Provider>
        </CssVarsProvider>
      )
    );
    const note = find('chat-message-side-chat-opening')!;
    expect(note.textContent).toContain('Side chat from');
    expect(note.textContent).toContain('the highlighted passage');
    expect(note.textContent).not.toContain('parent excerpt');
    act(() => find('side-chat-parent-link')!.click());
    expect(open).toHaveBeenCalledWith('parent-1');
  });

  it('offers the selection actions over a reply and passes the highlight to Reply', () => {
    const onReply = vi.fn();
    const onSideChat = vi.fn();
    act(() =>
      root.render(
        <CssVarsProvider>
          <MessageThread
            messages={[reply]}
            sessionId="s1"
            streaming={false}
            onRespond={() => undefined}
            onContinue={() => undefined}
            onReplyToSelection={onReply}
            onSideChatFromSelection={onSideChat}
          />
        </CssVarsProvider>
      )
    );
    const text = find('chat-markdown')!.querySelector('p')!.firstChild!;
    act(() => {
      document.getSelection()!.setBaseAndExtent(text, 2, text, 7);
      document.dispatchEvent(new Event('selectionchange'));
    });
    act(() => find('selection-actions-reply-btn')!.click());
    expect(onReply).toHaveBeenCalledWith('monad');
  });
});

describe('QuoteChip', () => {
  it('shows the quote and removes it on request', () => {
    const onRemove = vi.fn();
    act(() =>
      root.render(
        <CssVarsProvider>
          <QuoteChip quote="the passage" onRemove={onRemove} />
        </CssVarsProvider>
      )
    );
    expect(find('composer-quote-text')!.textContent).toBe('the passage');
    const remove = find('composer-quote-remove-btn')!;
    expect(remove.getAttribute('aria-label')).toBe('Remove quote');
    act(() => remove.click());
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
