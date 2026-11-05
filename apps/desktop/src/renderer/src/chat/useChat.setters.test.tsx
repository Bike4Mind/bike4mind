// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession, ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import { useConversation, type ConversationController } from './useChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const at = '2026-10-01T00:00:00.000Z';
const sessionFor = (id: string): ChatSession => ({
  id,
  title: `Chat ${id}`,
  model: 'local:',
  mode: 'chat',
  approvalMode: 'ask',
  reasoningEffort: 'default',
  createdAt: at,
  updatedAt: at,
  messages: [],
});
const summaryFor = (id: string, patch: Partial<ChatSessionSummary>): ChatSessionSummary => {
  const { messages, ...rest } = sessionFor(id);
  return { ...rest, messageCount: messages.length, ...patch } as ChatSessionSummary;
};

type Save = (id: string) => Promise<ChatSessionSummary | null>;
const saves: Record<string, ReturnType<typeof vi.fn<Save>>> = {};
const cases: {
  name: string;
  save: string;
  call: (c: ConversationController) => Promise<void>;
  patch: Partial<ChatSessionSummary>;
  read: (c: ConversationController) => unknown;
  stale: unknown;
}[] = [
  {
    name: 'setReasoningEffort',
    save: 'setSessionReasoningEffort',
    call: c => c.setReasoningEffort('high'),
    patch: { reasoningEffort: 'high' },
    read: c => c.session?.reasoningEffort,
    stale: 'default',
  },
  {
    name: 'setPromptCacheTtl',
    save: 'setSessionPromptCacheTtl',
    call: c => c.setPromptCacheTtl('1h'),
    patch: { promptCacheTtl: '1h' },
    read: c => c.session?.promptCacheTtl,
    stale: undefined,
  },
  {
    name: 'setApprovalMode',
    save: 'setApprovalMode',
    call: c => c.setApprovalMode('auto'),
    patch: { approvalMode: 'auto' },
    read: c => c.session?.approvalMode,
    stale: 'ask',
  },
  {
    name: 'setModel',
    save: 'setSessionModel',
    call: c => c.setModel('other:model'),
    patch: { model: 'other:model' },
    read: c => c.session?.model,
    stale: 'local:',
  },
  {
    name: 'rename',
    save: 'renameSession',
    call: c => c.rename('Renamed'),
    patch: { title: 'Renamed' },
    read: c => c.session?.title,
    stale: 'Chat s2',
  },
];

const extras = { setSessionHistory: vi.fn(), settleLocalModel: vi.fn() };
let root: Root;
let host: HTMLElement;
let conversation: ConversationController;
const onSummaryChanged = vi.fn();

function Harness({ id }: { id: string }) {
  conversation = useConversation(id, onSummaryChanged);
  return null;
}

beforeEach(() => {
  onSummaryChanged.mockReset();
  extras.setSessionHistory.mockReset();
  extras.settleLocalModel.mockReset();
  const chat: Record<string, unknown> = {
    getSession: async (id: string) => sessionFor(id),
    getQueuedMessages: async () => [],
    onSessionSummary: (_listener: (summary: ChatSessionSummary) => void) => () => {},
    onQueueChanged: () => () => {},
    onStreamEvent: (_listener: (event: ChatStreamEvent) => void) => () => {},
    setSessionHistory: extras.setSessionHistory,
    settleLocalModel: extras.settleLocalModel,
  };
  for (const entry of cases) {
    saves[entry.save] = vi.fn<Save>();
    chat[entry.save] = saves[entry.save];
  }
  Object.assign(window, { b4m: { chat, claudeImport: { onSessionsChanged: () => () => {} } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe.each(cases)('$name', entry => {
  it('does not paint a save that lands after the chat was switched', async () => {
    let resolve: (summary: ChatSessionSummary) => void = () => {};
    saves[entry.save].mockReturnValue(new Promise(done => (resolve = done)));
    await act(async () => root.render(<Harness id="s1" />));
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = entry.call(conversation);
    });
    await act(async () => root.render(<Harness id="s2" />));
    expect(conversation.session?.id).toBe('s2');

    await act(async () => {
      resolve(summaryFor('s1', entry.patch));
      await pending;
    });

    expect(conversation.session?.id).toBe('s2');
    expect(entry.read(conversation)).toBe(entry.stale);
    expect(onSummaryChanged).toHaveBeenCalledWith(expect.objectContaining({ id: 's1', ...entry.patch }));
  });

  it('shows no notice for a save that is rejected after the chat was switched', async () => {
    let reject: (error: Error) => void = () => {};
    saves[entry.save].mockReturnValue(new Promise((_, fail) => (reject = fail)));
    await act(async () => root.render(<Harness id="s1" />));
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = entry.call(conversation);
    });
    await act(async () => root.render(<Harness id="s2" />));

    await act(async () => {
      reject(new Error('disk full'));
      await pending;
    });

    expect(conversation.notice).toBeNull();
  });

  it('applies a save that lands while its chat is still open', async () => {
    saves[entry.save].mockImplementation(async id => summaryFor(id, entry.patch));
    await act(async () => root.render(<Harness id="s1" />));
    await act(async () => entry.call(conversation));
    expect(entry.read(conversation)).toBe(Object.values(entry.patch)[0]);
  });

  it('reports a rejected save as a notice instead of throwing', async () => {
    saves[entry.save].mockRejectedValue(new Error('disk full'));
    await act(async () => root.render(<Harness id="s1" />));
    await act(async () => {
      await expect(entry.call(conversation)).resolves.toBeUndefined();
    });
    expect(conversation.notice).toContain('disk full');
  });
});

describe('setModel notice', () => {
  it('clears a notice left by an earlier rejected save', async () => {
    saves.setSessionReasoningEffort.mockRejectedValue(new Error('disk full'));
    saves.setSessionModel.mockImplementation(async id => summaryFor(id, { model: 'other:model' }));
    await act(async () => root.render(<Harness id="s1" />));
    await act(async () => conversation.setReasoningEffort('high'));
    expect(conversation.notice).toContain('disk full');

    await act(async () => conversation.setModel('other:model'));

    expect(conversation.notice).toBeNull();
  });

  it('leaves the open chat notice alone when the save was for another chat', async () => {
    let resolve: (summary: ChatSessionSummary) => void = () => {};
    saves.setSessionModel.mockReturnValue(new Promise(done => (resolve = done)));
    saves.setSessionReasoningEffort.mockRejectedValue(new Error('disk full'));
    await act(async () => root.render(<Harness id="s1" />));
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = conversation.setModel('other:model');
    });
    await act(async () => root.render(<Harness id="s2" />));
    await act(async () => conversation.setReasoningEffort('high'));
    expect(conversation.notice).toContain('disk full');

    await act(async () => {
      resolve(summaryFor('s1', { model: 'other:model' }));
      await pending;
    });

    expect(conversation.notice).toContain('disk full');
  });
});

describe.each([
  { name: 'setHistory', fn: 'setSessionHistory', call: (c: ConversationController) => c.setHistory(true) },
  { name: 'settleLocalModel', fn: 'settleLocalModel', call: (c: ConversationController) => c.settleLocalModel() },
] as const)('$name rejection', entry => {
  it('reports a rejection as a notice instead of throwing', async () => {
    extras[entry.fn].mockRejectedValue(new Error('disk full'));
    await act(async () => root.render(<Harness id="s1" />));
    await act(async () => {
      await expect(entry.call(conversation)).resolves.toBeUndefined();
    });
    expect(conversation.notice).toContain('disk full');
  });

  it('shows no notice for a rejection after the chat was switched', async () => {
    let reject: (error: Error) => void = () => {};
    extras[entry.fn].mockReturnValue(new Promise((_, fail) => (reject = fail)));
    await act(async () => root.render(<Harness id="s1" />));
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = entry.call(conversation);
    });
    await act(async () => root.render(<Harness id="s2" />));

    await act(async () => {
      reject(new Error('disk full'));
      await pending;
    });

    expect(conversation.notice).toBeNull();
  });
});
