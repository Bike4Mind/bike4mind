// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messageSelection } from './messageSelection';
import { SelectionActions } from './SelectionActions';

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

// jsdom does no layout, so a range has no box of its own.
Range.prototype.getBoundingClientRect ??= () => new DOMRect(100, 200, 80, 16);

function Thread({ onReply, onSideChat }: { onReply: (text: string) => void; onSideChat: (text: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  return (
    <div ref={host} data-testid="chat-thread">
      <div data-testid="chat-message-user">
        <p id="user-text">What is a monad?</p>
      </div>
      <div data-testid="chat-message-assistant">
        <p id="reply-a">A monad is a monoid</p>
        <p id="reply-b">in the category of endofunctors.</p>
        <textarea id="field" defaultValue="typed text" />
      </div>
      <SelectionActions container={host} onReply={onReply} onSideChat={onSideChat} />
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;
const onReply = vi.fn<(text: string) => void>();
const onSideChat = vi.fn<(text: string) => void>();

beforeEach(() => {
  onReply.mockReset();
  onSideChat.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <CssVarsProvider>
        <Thread onReply={onReply} onSideChat={onSideChat} />
      </CssVarsProvider>
    )
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.getSelection()?.removeAllRanges();
});

const byId = (id: string) => document.getElementById(id)!.firstChild!;
const thread = () => container.querySelector('[data-testid="chat-thread"]')!;
const pill = () => document.querySelector<HTMLElement>('[data-testid="selection-actions"]');

/** Highlight from one text node to another, as a drag would, and let the pill read it. */
function select(from: Node, fromOffset: number, to: Node, toOffset: number): void {
  act(() => {
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.setBaseAndExtent(from, fromOffset, to, toOffset);
    document.dispatchEvent(new Event('selectionchange'));
  });
}

describe('messageSelection', () => {
  it('returns the trimmed text of a highlight inside one message', () => {
    select(byId('reply-a'), 2, byId('reply-a'), 7);
    expect(messageSelection(document.getSelection(), thread())?.text).toBe('monad');
  });

  it('accepts a highlight spanning paragraphs of the same message', () => {
    select(byId('reply-a'), 0, byId('reply-b'), 6);
    expect(messageSelection(document.getSelection(), thread())?.text).toMatch(/^A monad is a monoid\s*in the$/);
  });

  it('refuses a highlight that crosses from one message into another', () => {
    select(byId('user-text'), 0, byId('reply-a'), 5);
    expect(messageSelection(document.getSelection(), thread())).toBeNull();
  });

  it('refuses a collapsed selection and one outside the thread', () => {
    select(byId('reply-a'), 3, byId('reply-a'), 3);
    expect(messageSelection(document.getSelection(), thread())).toBeNull();
    const outside = document.createElement('p');
    outside.textContent = 'elsewhere';
    document.body.append(outside);
    select(outside.firstChild!, 0, outside.firstChild!, 4);
    expect(messageSelection(document.getSelection(), thread())).toBeNull();
    outside.remove();
  });

  it('refuses a selection inside a text field', () => {
    const field = document.getElementById('field')!;
    act(() => {
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.setBaseAndExtent(field, 0, field, 0);
      selection.extend(field, 0);
    });
    // A field's caret sits at the field element itself, which the editable check catches.
    expect(messageSelection(document.getSelection(), thread())).toBeNull();
  });
});

describe('SelectionActions', () => {
  it('shows a labelled toolbar with both actions for a highlight in one message', () => {
    select(byId('reply-a'), 2, byId('reply-a'), 7);
    const toolbar = pill();
    expect(toolbar).not.toBeNull();
    expect(toolbar!.getAttribute('role')).toBe('toolbar');
    expect(toolbar!.getAttribute('aria-label')).toBe('Actions for the highlighted text');
    expect(toolbar!.querySelector('[data-testid="selection-actions-side-chat-btn"]')?.textContent).toBe(
      'Start a side chat'
    );
    expect(toolbar!.querySelector('[data-testid="selection-actions-reply-btn"]')?.textContent).toBe('Reply');
  });

  it('shows nothing for a highlight crossing messages', () => {
    select(byId('user-text'), 0, byId('reply-a'), 5);
    expect(pill()).toBeNull();
  });

  it('Reply hands over the highlighted text and closes', () => {
    select(byId('reply-a'), 2, byId('reply-a'), 7);
    act(() => pill()!.querySelector<HTMLButtonElement>('[data-testid="selection-actions-reply-btn"]')!.click());
    expect(onReply).toHaveBeenCalledWith('monad');
    expect(onSideChat).not.toHaveBeenCalled();
    expect(pill()).toBeNull();
  });

  it('Start a side chat hands over the highlighted text and closes', () => {
    select(byId('user-text'), 10, byId('user-text'), 15);
    act(() => pill()!.querySelector<HTMLButtonElement>('[data-testid="selection-actions-side-chat-btn"]')!.click());
    expect(onSideChat).toHaveBeenCalledWith('monad');
    expect(pill()).toBeNull();
  });

  it('goes away on Escape, on a scroll of the thread, and on deselect', () => {
    select(byId('reply-a'), 2, byId('reply-a'), 7);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(pill()).toBeNull();

    select(byId('reply-a'), 2, byId('reply-a'), 7);
    act(() => {
      thread().dispatchEvent(new Event('scroll'));
    });
    expect(pill()).toBeNull();

    select(byId('reply-a'), 2, byId('reply-a'), 7);
    select(byId('reply-a'), 4, byId('reply-a'), 4);
    expect(pill()).toBeNull();
  });

  it('goes away on a press outside it, but not on a press inside it', () => {
    select(byId('reply-a'), 2, byId('reply-a'), 7);
    act(() => {
      pill()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(pill()).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(pill()).toBeNull();
  });

  it('waits for a drag to end before showing', () => {
    act(() => {
      byId('reply-a').parentElement!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    select(byId('reply-a'), 2, byId('reply-a'), 7);
    expect(pill()).toBeNull();
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(pill()).not.toBeNull();
  });

  it('is reachable with Tab and moves between its buttons with the arrow keys', () => {
    select(byId('reply-a'), 2, byId('reply-a'), 7);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
    });
    const sideChat = pill()!.querySelector('[data-testid="selection-actions-side-chat-btn"]');
    const reply = pill()!.querySelector('[data-testid="selection-actions-reply-btn"]');
    expect(document.activeElement).toBe(sideChat);
    act(() => {
      sideChat!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(document.activeElement).toBe(reply);
  });
});
