// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatQueuedMessage } from '@shared/chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueuedMessageList } from './QueuedMessageList';

/**
 * The row above the composer, and which of its two controls it offers.
 *
 * "Send now" has to be absent wherever it could not do what it says: with no live reply there
 * is nothing to cut in front of, and on a relayed message it would fire another conversation's
 * words as though the user had written them. Main refuses both as well - these pin the row to
 * the same answer, so the control is never shown leading somewhere it cannot go.
 */
const typed: ChatQueuedMessage = {
  id: 'q1',
  sessionId: 's1',
  text: 'typed ahead',
  queuedAt: '2026-10-05T00:00:00.000Z',
};

const relayed: ChatQueuedMessage = {
  id: 'q2',
  sessionId: 's1',
  text: 'from the other conversation',
  queuedAt: '2026-10-05T00:00:01.000Z',
  relay: { fromSessionId: 'sender', fromTitle: 'Sender', hops: 1 },
};

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

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(props: Partial<Parameters<typeof QueuedMessageList>[0]> = {}): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <CssVarsProvider>
        <QueuedMessageList messages={[typed]} onCancel={() => {}} {...props} />
      </CssVarsProvider>
    );
  });
}

function sendNowButtons(): HTMLElement[] {
  return [...(host?.querySelectorAll('[data-testid="composer-send-now-queued-btn"]') ?? [])] as HTMLElement[];
}

describe('QueuedMessageList send now', () => {
  it('offers it on a message the user typed, while a reply is running', () => {
    const onSendNow = vi.fn();
    mount({ onSendNow, canSendNow: true });

    expect(sendNowButtons()).toHaveLength(1);
    act(() => sendNowButtons()[0]?.click());
    expect(onSendNow).toHaveBeenCalledWith('q1');
  });

  it('leaves it out when no reply is running', () => {
    // The queue is about to drain by itself, so "now" and "wait" mean the same thing.
    mount({ onSendNow: vi.fn(), canSendNow: false });

    expect(sendNowButtons()).toHaveLength(0);
    expect(host?.querySelectorAll('[data-testid="composer-cancel-queued-btn"]')).toHaveLength(1);
  });

  it('never offers it on a relayed message', () => {
    mount({ messages: [relayed, typed], onSendNow: vi.fn(), canSendNow: true });

    // One button for two rows, and it belongs to the user's own.
    expect(sendNowButtons()).toHaveLength(1);
    const rows = [...(host?.querySelectorAll('[data-testid="composer-queued-message"]') ?? [])];
    expect(rows[0]?.querySelector('[data-testid="composer-send-now-queued-btn"]')).toBeNull();
    expect(rows[1]?.querySelector('[data-testid="composer-send-now-queued-btn"]')).not.toBeNull();
  });

  it('leaves it out when the host offers no handler', () => {
    mount({ canSendNow: true });

    expect(sendNowButtons()).toHaveLength(0);
  });
});
