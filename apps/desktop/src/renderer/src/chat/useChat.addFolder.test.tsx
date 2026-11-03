// @vitest-environment jsdom
import { useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession, ChatSessionSummary } from '@shared/chat';
import type { ShareDirectoryResult } from '@shared/directoryRequest';
import { useConversation, type ConversationController } from './useChat';

// Off, so React's own scheduler runs: it flushes a render's passive effects a task after the commit, not inside act().
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const NOTES = '/work/notes';
const at = '2026-10-01T00:00:00.000Z';
const summary = (grantedDirectories: string[]): ChatSessionSummary =>
  ({
    id: 'fresh',
    title: 'New conversation',
    mode: 'chat',
    model: 'claude-opus-4-5-20251101',
    messageCount: 0,
    createdAt: at,
    updatedAt: at,
    grantedDirectories,
  }) as ChatSessionSummary;
const session = (grantedDirectories: string[]) =>
  ({ ...summary(grantedDirectories), messages: [] }) as unknown as ChatSession;

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

let conversation: ConversationController;
let onOpen: (() => void) | null = null;

function Harness({ sessionId }: { sessionId: string | null }) {
  conversation = useConversation(sessionId, () => undefined);
  useLayoutEffect(() => {
    if (sessionId) onOpen?.();
  }, [sessionId]);
  return null;
}

function stubBridge(chat: Record<string, unknown>) {
  (window as unknown as { b4m: unknown }).b4m = {
    chat: {
      getQueuedMessages: async () => [],
      onSessionSummary: () => () => undefined,
      onQueueChanged: () => () => undefined,
      onStreamEvent: () => () => undefined,
      ...chat,
    },
    claudeImport: { onSessionsChanged: () => () => undefined },
  };
}

let root: Root;

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  onOpen = null;
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  root.unmount();
  await settle();
  vi.unstubAllGlobals();
});

const lateReplies = [
  {
    reply: {
      status: 'added',
      path: NOTES,
      warning: 'This is your home folder.',
      session: summary([NOTES]),
    } as ShareDirectoryResult,
    outcome: { value: `Shared ${NOTES} with this conversation. This is your home folder.` },
  },
  {
    reply: { status: 'refused', error: 'The filesystem root cannot be shared.' } as ShareDirectoryResult,
    outcome: { error: 'The filesystem root cannot be shared.' },
  },
];

describe('sharing a folder into a chat by id', () => {
  it.each(lateReplies)(
    'hands back a $reply.status reply that lands before the opened chat has reset',
    async ({ reply, outcome }) => {
      let answer: (result: ShareDirectoryResult) => void = () => undefined;
      stubBridge({
        getSession: async () => session([]),
        addContextDirectory: () => new Promise<ShareDirectoryResult>(resolve => (answer = resolve)),
      });
      // Main's reply arrives in the commit that opens the chat, ahead of that chat's passive reset.
      onOpen = () => answer(reply);
      root.render(<Harness sessionId={null} />);
      await settle();

      const shared = conversation.addContextDirectoryTo('fresh', NOTES).then(
        value => ({ value }),
        (error: Error) => ({ error: error.message })
      );
      root.render(<Harness sessionId="fresh" />);
      expect(await shared).toEqual(outcome);
      await settle();
      expect(conversation.notice).toBeNull();
      expect(conversation.sendError).toBeNull();
    }
  );

  it.each(lateReplies)(
    'hands back a $reply.status reply that lands after its chat was left, before the next one resets',
    async ({ reply, outcome }) => {
      let answer: (result: ShareDirectoryResult) => void = () => undefined;
      stubBridge({
        getSession: async () => session([]),
        addContextDirectory: () => new Promise<ShareDirectoryResult>(resolve => (answer = resolve)),
      });
      root.render(<Harness sessionId="fresh" />);
      await settle();

      // Main's reply arrives in the commit that opens another chat, while the reset still names this one.
      onOpen = () => answer(reply);
      const shared = conversation.addContextDirectoryTo('fresh', NOTES).then(
        value => ({ value }),
        (error: Error) => ({ error: error.message })
      );
      root.render(<Harness sessionId="other" />);
      expect(await shared).toEqual(outcome);
    }
  );

  it('reads a chat again when a share lands during its read, not laying the older summary over it', async () => {
    let stored = session([]);
    let serveFirstRead: (loaded: ChatSession) => void = () => undefined;
    let reads = 0;
    stubBridge({
      getSession: () =>
        ++reads === 1 ? new Promise<ChatSession>(resolve => (serveFirstRead = resolve)) : Promise.resolve(stored),
      addContextDirectory: async (): Promise<ShareDirectoryResult> => {
        stored = session([NOTES]);
        return { status: 'added', path: NOTES, session: summary([NOTES]) };
      },
    });
    root.render(<Harness sessionId="fresh" />);
    await settle();

    await conversation.addContextDirectoryTo('fresh', NOTES);
    // Another window takes the folder back before main serves the read that was already asked for.
    stored = session([]);
    serveFirstRead(stored);
    await settle();

    expect(conversation.session?.grantedDirectories).toEqual([]);
    expect(reads).toBe(2);
  });
});
