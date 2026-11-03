// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession, ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import type { GenerationSettings } from '@shared/generation';
import { useConversation, type ConversationController } from './useChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const at = '2026-10-01T00:00:00.000Z';
const session: ChatSession = {
  id: 's1',
  title: 'Chat',
  model: 'local:ollama:qwen3:8b',
  mode: 'chat',
  approvalMode: 'ask',
  reasoningEffort: 'default',
  generation: { temperature: 0.4 },
  createdAt: at,
  updatedAt: at,
  messages: [],
};
const setSessionGeneration = vi.fn(async (_id: string, generation: GenerationSettings): Promise<ChatSessionSummary> => {
  const { messages: _messages, ...meta } = session;
  const { generation: _old, ...rest } = meta;
  return { ...rest, ...(Object.keys(generation).length > 0 ? { generation } : {}), messageCount: 0 };
});
let root: Root;
let host: HTMLElement;
let conversation: ConversationController;

function Harness({ id = 's1' }: { id?: string }) {
  conversation = useConversation(id, () => {});
  return null;
}

beforeEach(() => {
  setSessionGeneration.mockClear();
  Object.assign(window, {
    b4m: {
      chat: {
        getSession: async () => session,
        setSessionGeneration,
        getQueuedMessages: async () => [],
        onSessionSummary: (_listener: (summary: ChatSessionSummary) => void) => () => {},
        onQueueChanged: () => () => {},
        onStreamEvent: (_listener: (event: ChatStreamEvent) => void) => () => {},
      },
      claudeImport: { onSessionsChanged: () => () => {} },
    },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('a conversation generation settings', () => {
  it('reopens with the stored overrides, and saves and clears them through main', async () => {
    await act(async () => root.render(<Harness />));
    expect(conversation.session?.generation).toEqual({ temperature: 0.4 });

    await act(async () => conversation.setGeneration({ temperature: 0.4, topK: 20 }));
    expect(setSessionGeneration).toHaveBeenLastCalledWith('s1', { temperature: 0.4, topK: 20 });
    expect(conversation.session?.generation).toEqual({ temperature: 0.4, topK: 20 });

    await act(async () => conversation.setGeneration({}));
    expect(conversation.session?.generation).toBeUndefined();
  });

  it('says so when main does not save them, and keeps what was shown', async () => {
    await act(async () => root.render(<Harness />));
    setSessionGeneration.mockRejectedValueOnce(new Error('disk full'));
    let saved: boolean | undefined;
    await act(async () => {
      saved = await conversation.setGeneration({ topK: 20 });
    });
    expect(saved).toBe(false);
    expect(conversation.notice).toBe("Could not save this chat's params. disk full");
    expect(conversation.session?.generation).toEqual({ temperature: 0.4 });

    setSessionGeneration.mockResolvedValueOnce(null as unknown as ChatSessionSummary);
    await act(async () => {
      saved = await conversation.setGeneration({ topK: 30 });
    });
    expect(saved).toBe(false);
    expect(conversation.notice).toBe("Could not save this chat's params. The conversation could not be found.");
    expect(conversation.session?.generation).toEqual({ temperature: 0.4 });
  });

  it('applies only the latest of two saves, whichever answers last', async () => {
    await act(async () => root.render(<Harness />));
    let answerFirst: (summary: ChatSessionSummary) => void = () => {};
    const { messages: _messages, generation: _generation, ...meta } = session;
    setSessionGeneration.mockImplementationOnce(
      () => new Promise<ChatSessionSummary>(resolve => (answerFirst = resolve))
    );
    let first: Promise<boolean> | undefined;
    await act(async () => {
      first = conversation.setGeneration({ topK: 20 });
    });
    await act(async () => conversation.setGeneration({ topK: 30 }));
    await act(async () => {
      answerFirst({ ...meta, generation: { topK: 20 }, messageCount: 0 });
      await first;
    });
    expect(conversation.session?.generation).toEqual({ topK: 30 });
  });

  it('says nothing when an older save fails after a newer one landed', async () => {
    await act(async () => root.render(<Harness />));
    let failFirst: (error: Error) => void = () => {};
    setSessionGeneration.mockImplementationOnce(
      () => new Promise<ChatSessionSummary>((_resolve, reject) => (failFirst = reject))
    );
    let first: Promise<boolean> | undefined;
    await act(async () => {
      first = conversation.setGeneration({ topK: 20 });
    });
    await act(async () => conversation.setGeneration({ topK: 30 }));
    await act(async () => {
      failFirst(new Error('disk full'));
      await first;
    });
    expect(conversation.notice).toBeNull();
    expect(conversation.session?.generation).toEqual({ topK: 30 });
  });

  it('shows what main holds when the newest save fails after an older one landed unseen', async () => {
    await act(async () => root.render(<Harness />));
    let answerFirst: (summary: ChatSessionSummary) => void = () => {};
    let failSecond: (error: Error) => void = () => {};
    setSessionGeneration
      .mockImplementationOnce(() => new Promise<ChatSessionSummary>(resolve => (answerFirst = resolve)))
      .mockImplementationOnce(() => new Promise<ChatSessionSummary>((_resolve, reject) => (failSecond = reject)));
    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    await act(async () => {
      first = conversation.setGeneration({ topK: 20 });
      second = conversation.setGeneration({ topK: 30 });
    });
    const { messages: _messages, generation: _generation, ...meta } = session;
    await act(async () => {
      answerFirst({ ...meta, generation: { topK: 20 }, messageCount: 0 });
      await first;
    });
    expect(conversation.session?.generation).toEqual({ temperature: 0.4 });

    window.b4m.chat.getSession = async () => ({ ...session, generation: { topK: 20 } });
    let saved: boolean | undefined;
    await act(async () => {
      failSecond(new Error('disk full'));
      saved = await second;
    });
    expect(saved).toBe(false);
    expect(conversation.notice).toBe("Could not save this chat's params. disk full");
    expect(conversation.session?.generation).toEqual({ topK: 20 });
  });

  it('does not put a save that lands after a switch on the conversation now open', async () => {
    const other: ChatSession = { ...session, id: 's2', generation: { topP: 0.5 } };
    window.b4m.chat.getSession = async (id: string) => (id === 's2' ? other : session);
    await act(async () => root.render(<Harness />));
    let answer: (summary: ChatSessionSummary) => void = () => {};
    setSessionGeneration.mockImplementationOnce(() => new Promise<ChatSessionSummary>(resolve => (answer = resolve)));
    let save: Promise<boolean> | undefined;
    await act(async () => {
      save = conversation.setGeneration({ topK: 20 });
    });
    await act(async () => root.render(<Harness id="s2" />));
    const { messages: _messages, generation: _generation, ...meta } = session;
    await act(async () => {
      answer({ ...meta, generation: { topK: 20 }, messageCount: 0 });
      await save;
    });
    expect(conversation.session?.id).toBe('s2');
    expect(conversation.session?.generation).toEqual({ topP: 0.5 });
  });

  it('keeps an older set main sends back from replacing a newer save that landed while it was read', async () => {
    await act(async () => root.render(<Harness />));
    let failFirst: (error: Error) => void = () => {};
    let read: (value: ChatSession) => void = () => {};
    setSessionGeneration.mockImplementationOnce(
      () => new Promise<ChatSessionSummary>((_resolve, reject) => (failFirst = reject))
    );
    window.b4m.chat.getSession = () => new Promise<ChatSession>(resolve => (read = resolve));
    let first: Promise<boolean> | undefined;
    await act(async () => {
      first = conversation.setGeneration({ topK: 20 });
    });
    await act(async () => failFirst(new Error('disk full')));
    await act(async () => conversation.setGeneration({ topK: 30 }));
    expect(conversation.session?.generation).toEqual({ topK: 30 });
    await act(async () => {
      read(session);
      await first;
    });
    expect(conversation.session?.generation).toEqual({ topK: 30 });
  });

  describe('across chats', () => {
    const { messages: _messages, generation: _generation, ...meta } = session;

    it('tells only the chat it failed in, and leaves the open one as it was', async () => {
      const other: ChatSession = { ...session, id: 's2', generation: { topP: 0.5 } };
      window.b4m.chat.getSession = async (id: string) => (id === 's2' ? other : session);
      await act(async () => root.render(<Harness />));
      let fail: (error: Error) => void = () => {};
      setSessionGeneration.mockImplementationOnce(
        () => new Promise<ChatSessionSummary>((_resolve, reject) => (fail = reject))
      );
      let save: Promise<boolean> | undefined;
      await act(async () => {
        save = conversation.setGeneration({ topK: 20 });
      });
      await act(async () => root.render(<Harness id="s2" />));
      await act(async () => {
        fail(new Error('disk full'));
        await save;
      });
      expect(conversation.session?.id).toBe('s2');
      expect(conversation.notice).toBeNull();
      expect(conversation.session?.generation).toEqual({ topP: 0.5 });
    });

    it("applies a chat's save that lands after a save in another chat", async () => {
      const other: ChatSession = { ...session, id: 's2', generation: undefined };
      window.b4m.chat.getSession = async (id: string) => (id === 's2' ? other : session);
      await act(async () => root.render(<Harness />));
      let answer: (summary: ChatSessionSummary) => void = () => {};
      setSessionGeneration.mockImplementationOnce(() => new Promise<ChatSessionSummary>(resolve => (answer = resolve)));
      let save: Promise<boolean> | undefined;
      await act(async () => {
        save = conversation.setGeneration({ topK: 20 });
      });
      await act(async () => root.render(<Harness id="s2" />));
      await act(async () => conversation.setGeneration({ topP: 0.7 }));
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => {
        answer({ ...meta, generation: { topK: 20 }, messageCount: 0 });
        await save;
      });
      expect(conversation.session?.id).toBe('s1');
      expect(conversation.session?.generation).toEqual({ topK: 20 });
    });

    it("reports a chat's failed save once it is open again, after a save in another chat", async () => {
      const other: ChatSession = { ...session, id: 's2', generation: undefined };
      window.b4m.chat.getSession = async (id: string) => (id === 's2' ? other : session);
      await act(async () => root.render(<Harness />));
      let fail: (error: Error) => void = () => {};
      setSessionGeneration.mockImplementationOnce(
        () => new Promise<ChatSessionSummary>((_resolve, reject) => (fail = reject))
      );
      let save: Promise<boolean> | undefined;
      await act(async () => {
        save = conversation.setGeneration({ topK: 20 });
      });
      await act(async () => root.render(<Harness id="s2" />));
      await act(async () => conversation.setGeneration({ topP: 0.7 }));
      await act(async () => root.render(<Harness id="s1" />));
      await act(async () => {
        fail(new Error('disk full'));
        await save;
      });
      expect(conversation.session?.id).toBe('s1');
      expect(conversation.notice).toBe("Could not save this chat's params. disk full");
      expect(conversation.session?.generation).toEqual({ temperature: 0.4 });
    });
  });

  it('saves nothing before the conversation has loaded', async () => {
    let finish: (value: ChatSession) => void = () => {};
    window.b4m.chat.getSession = () => new Promise<ChatSession>(resolve => (finish = resolve));
    await act(async () => root.render(<Harness />));
    expect(await conversation.setGeneration({ topK: 20 })).toBe(false);
    expect(setSessionGeneration).not.toHaveBeenCalled();
    await act(async () => finish(session));
  });
});
