import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { IChatHistoryItem } from '@bike4mind/common';

/**
 * `chatCompletion={isStreamingItem ? chatCompletion : undefined}` is the only thing
 * that scopes live streaming state to one message. Everything downstream trusts it:
 * MessageContent renders the rapid-reply bubble behind a bare `{chatCompletion && ...}`
 * with no quest check of its own, so if this ternary ever handed the completion to
 * every item, the acknowledgement would appear on every message in the transcript.
 *
 * Virtuoso is replaced with a plain list so `itemContent` runs for every row without a
 * viewport, and MessageContent with a spy so the per-row props are inspectable.
 */

const messageContentSpy = vi.fn();

vi.mock('@client/app/components/Session/MessageContent', () => ({
  default: (props: Record<string, unknown>) => {
    messageContentSpy(props);
    return <div data-testid={`message-${props.messageData ? (props.messageData as IChatHistoryItem).id : 'none'}`} />;
  },
}));

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({
    data,
    itemContent,
    firstItemIndex = 0,
  }: {
    data: IChatHistoryItem[];
    itemContent: (index: number, item: IChatHistoryItem) => React.ReactNode;
    firstItemIndex?: number;
  }) => (
    <div>
      {data.map((item, i) => (
        <div key={item.id ?? i}>{itemContent(i + firstItemIndex, item)}</div>
      ))}
    </div>
  ),
}));

vi.mock('./FallbackModelBadge', () => ({ default: () => null }));
vi.mock('@client/app/utils/chatScroll', () => ({
  flashMessageHighlight: vi.fn(),
  registerScrollToMessageHandler: vi.fn(() => vi.fn()),
}));
vi.mock('@client/app/utils/scrollbarStyles', () => ({ scrollbarStyles: {} }));

import ChatHistory from './ChatHistory';

const quest = (id: string | undefined) =>
  ({ id, prompt: `prompt ${id}`, replies: [], status: 'done' }) as IChatHistoryItem;

const chatCompletion = {
  completed: false,
  stopped: false,
  statusMessage: 'Running...',
  rapidReply: { content: 'Give me a moment.', status: 'completed' },
} as never;

const renderHistory = (history: IChatHistoryItem[], activeStreamingQuestId: string | null) =>
  render(
    <ChatHistory
      filteredChatHistory={history}
      sessionId="session-1"
      mode="chat"
      activeStreamingQuestId={activeStreamingQuestId}
      chatCompletion={chatCompletion}
      onDelete={vi.fn()}
      onPinToggle={vi.fn()}
      onSendMessage={vi.fn()}
      search=""
      model="gpt-4o"
      canUseAdminTools={false}
      virtuosoRef={{ current: null }}
      firstItemIndex={0}
      onStartReached={vi.fn()}
      onAtBottomStateChange={vi.fn()}
      scrollbarWidth={0}
    />
  );

/** messageData.id -> whether that row received a chatCompletion. */
const completionByMessage = () =>
  Object.fromEntries(
    messageContentSpy.mock.calls.map(([props]) => [
      (props.messageData as IChatHistoryItem)?.id ?? 'no-id',
      props.chatCompletion !== undefined,
    ])
  );

describe('ChatHistory - streaming state is scoped to one message', () => {
  beforeEach(() => {
    messageContentSpy.mockClear();
  });

  it('hands the chat completion to the streaming message only', () => {
    renderHistory([quest('c'), quest('b'), quest('a')], 'b');

    expect(completionByMessage()).toEqual({ a: false, b: true, c: false });
  });

  it('hands it to no message when nothing is streaming', () => {
    renderHistory([quest('b'), quest('a')], null);

    expect(completionByMessage()).toEqual({ a: false, b: false });
  });

  it('never matches a message with no id', () => {
    renderHistory([quest(undefined), quest('a')], null);

    expect(completionByMessage()).toEqual({ 'no-id': false, a: false });
  });

  // Pins the `messageData.id != null` half of the guard. activeStreamingQuestId is
  // typed `string | null` and derived from `streamingMessageData?.id ?? null`, so an
  // undefined cannot arrive through the types - the cast is deliberate. Without the
  // guard, undefined === undefined would light up every id-less row at once.
  it('does not match an id-less message on an undefined streaming id', () => {
    renderHistory([quest(undefined), quest('a')], undefined as unknown as null);

    expect(completionByMessage()).toEqual({ 'no-id': false, a: false });
  });

  it('matches exactly one message even when the streaming id is absent from the list', () => {
    renderHistory([quest('b'), quest('a')], 'not-here');

    expect(completionByMessage()).toEqual({ a: false, b: false });
  });
});
