// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatQueuedMessage, ChatQueueEvent } from '@shared/chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueuedMessageList } from './QueuedMessageList';
import { describeReturn, mergeIntoDraft, queuedPreview } from './queuedMessages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function queued(text: string, id = 'q1'): ChatQueuedMessage {
  return { id, sessionId: 's1', text, queuedAt: '2026-01-01T00:00:00.000Z' };
}

describe('mergeIntoDraft', () => {
  it('fills an empty composer with the returned text', () => {
    expect(mergeIntoDraft('', [queued('hold on')])).toBe('hold on');
    expect(mergeIntoDraft('   \n ', [queued('hold on')])).toBe('hold on');
  });

  // The rule that keeps a cancel from destroying work: two things the user wrote, both kept.
  it('appends rather than replacing what is already being typed', () => {
    expect(mergeIntoDraft('half a thought', [queued('hold on')])).toBe('half a thought\nhold on');
  });

  it('keeps several returned messages in the order they were queued', () => {
    expect(mergeIntoDraft('', [queued('one', 'a'), queued('two', 'b')])).toBe('one\ntwo');
  });

  it('leaves the draft alone when there is nothing to give back', () => {
    expect(mergeIntoDraft('typing', [])).toBe('typing');
    expect(mergeIntoDraft('typing', [queued('   ')])).toBe('typing');
  });
});

describe('describeReturn', () => {
  const event = (reason: NonNullable<ChatQueueEvent['returned']>['reason'], count = 1, detail?: string) => ({
    messages: Array.from({ length: count }, (_, index) => queued(`m${index}`, `q${index}`)),
    reason,
    ...(detail ? { detail } : {}),
  });

  // Cancelling is the user's own doing; the text landing back under their cursor says it all.
  it('says nothing when the user cancelled it themselves', () => {
    expect(describeReturn(event('cancelled'))).toBeNull();
  });

  it('explains a stop, which the user may not connect to their queued message', () => {
    expect(describeReturn(event('stopped'))).toMatch(/stopped the reply.*was not sent.*back in the composer/i);
  });

  it('explains a failed reply', () => {
    expect(describeReturn(event('failed'))).toMatch(/failed.*was not sent/i);
  });

  it('names an expired session rather than a failed reply', () => {
    expect(describeReturn(event('session-expired'))).toMatch(/session expired.*was not sent.*back in the composer/i);
  });

  it('quotes the refusal when the turn itself was refused', () => {
    expect(describeReturn(event('refused', 1, 'Sign in to send a message.'))).toMatch(/Sign in to send a message\./);
  });

  it('agrees in number with what came back', () => {
    expect(describeReturn(event('stopped', 2))).toMatch(/your 2 queued messages were not sent\. They are back/i);
  });

  it('says nothing when nothing came back', () => {
    expect(describeReturn(undefined)).toBeNull();
    expect(describeReturn(event('stopped', 0))).toBeNull();
  });
});

describe('queuedPreview', () => {
  // A pending message grows one line per send, so flattening would run them together.
  it('keeps the line breaks that separate what was typed', () => {
    expect(queuedPreview(queued('first\nsecond'))).toBe('first\nsecond');
  });

  it('clips a pasted wall of text', () => {
    const preview = queuedPreview(queued('x'.repeat(900)));
    expect(preview.endsWith('...')).toBe(true);
    expect(preview.length).toBeLessThan(450);
  });

  // An attachment with no prose is a real turn, so the row still has to say something.
  it('names an attachment-only message', () => {
    expect(queuedPreview(queued(''))).toBe('(attachments only)');
  });
});
