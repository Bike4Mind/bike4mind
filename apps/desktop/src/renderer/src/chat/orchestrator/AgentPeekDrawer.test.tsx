// @vitest-environment jsdom
import { act } from 'react';
import type { ChatQueueEvent, ChatQueuedMessage } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPeekDrawer } from './AgentPeekDrawer';
import type { AgentView } from './roster';
import { agentFixture, createThemedMount, el, query, typeInto } from './testUtils';

let queueListener: ((event: ChatQueueEvent) => void) | null = null;
const queueUnsubscribe = vi.fn();
const chat = {
  onQueueChanged: vi.fn((listener: (event: ChatQueueEvent) => void) => {
    queueListener = listener;
    return queueUnsubscribe;
  }),
  getSession: vi.fn(),
  sendMessage: vi.fn(),
  cancelQueuedMessage: vi.fn(),
  sendQueuedMessageNow: vi.fn(),
};
const actions = { open: vi.fn(), stop: vi.fn(), archive: vi.fn() };
const onClose = vi.fn();
const themed = createThemedMount();

const renderDrawer = (agent: AgentView) =>
  themed.render(<AgentPeekDrawer agent={agent} onClose={onClose} actions={actions} />);

const sessionWith = (...contents: string[]) => ({
  messages: contents.map((content, index) => ({ id: `m${index}`, role: 'assistant', content })),
});

const input = () => el('orchestrator-peek-reply-input') as HTMLTextAreaElement;

async function typeAndSend(text: string) {
  await typeInto(input(), text);
  await act(async () => el('orchestrator-peek-send-btn').click());
}

const pressEnter = (init: KeyboardEventInit = {}) =>
  act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));
  });

beforeEach(() => {
  vi.clearAllMocks();
  queueListener = null;
  chat.getSession.mockResolvedValue(sessionWith('message 1', 'message 2', 'message 3', 'message 4'));
  chat.sendMessage.mockResolvedValue({ ok: true, messageId: 'x' });
  chat.cancelQueuedMessage.mockResolvedValue(undefined);
  chat.sendQueuedMessageNow.mockResolvedValue(undefined);
  (window as unknown as { b4m: unknown }).b4m = { chat };
});

afterEach(() => themed.unmount());

describe('AgentPeekDrawer', () => {
  it('shows the last three messages', async () => {
    await renderDrawer(agentFixture('a1'));
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('message 1');
    expect(text).toContain('message 2');
    expect(text).toContain('message 4');
  });

  it('refetches when the agent updatedAt changes', async () => {
    await renderDrawer(agentFixture('a1'));
    expect(chat.getSession).toHaveBeenCalledTimes(1);
    chat.getSession.mockResolvedValue(sessionWith('fresh news'));
    await renderDrawer(agentFixture('a1', 'working', { updatedAt: '2026-10-02T00:00:00.000Z' }));
    expect(chat.getSession).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('fresh news');
  });

  it('ignores a fetch that resolves after a newer one was requested', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    chat.getSession.mockReturnValueOnce(new Promise(resolve => (resolveFirst = resolve)));
    await renderDrawer(agentFixture('a1'));
    chat.getSession.mockResolvedValue(sessionWith('current'));
    await renderDrawer(agentFixture('a1', 'working', { updatedAt: '2026-10-02T00:00:00.000Z' }));
    await act(async () => resolveFirst(sessionWith('outdated')));
    const text = document.body.textContent ?? '';
    expect(text).toContain('current');
    expect(text).not.toContain('outdated');
  });

  it('shows an inline error when the session cannot be read', async () => {
    chat.getSession.mockRejectedValue(new Error('disk gone'));
    await renderDrawer(agentFixture('a1'));
    expect(el('orchestrator-peek-load-error').textContent).toBe('disk gone');
  });

  it('sends the reply to the agent session', async () => {
    await renderDrawer(agentFixture('a1'));
    await typeAndSend('hello');
    expect(chat.sendMessage).toHaveBeenCalledWith({ sessionId: 'a1', text: 'hello' });
    expect(query('orchestrator-peek-queued-note')).toBeNull();
    expect(input().value).toBe('');
  });

  it('sends on Enter but not on Shift+Enter or while composing', async () => {
    await renderDrawer(agentFixture('a1'));
    await typeInto(input(), 'hello');
    await pressEnter({ shiftKey: true });
    await pressEnter({ isComposing: true });
    expect(chat.sendMessage).not.toHaveBeenCalled();
    await pressEnter();
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('sends once when Enter is pressed twice before the first send settles', async () => {
    let finish: (value: unknown) => void = () => {};
    chat.sendMessage.mockReturnValue(new Promise(resolve => (finish = resolve)));
    await renderDrawer(agentFixture('a1'));
    await typeInto(input(), 'hello');
    await pressEnter();
    await pressEnter();
    expect((el('orchestrator-peek-send-btn') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish({ ok: true, messageId: 'x' }));
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('shows the queued note, cancels, and sends now with the queued id', async () => {
    chat.sendMessage.mockResolvedValue({
      ok: true,
      queued: true,
      message: { id: 'q1', sessionId: 'a1', text: 'hello' },
    });
    await renderDrawer(agentFixture('a1'));
    await typeAndSend('hello');
    expect(el('orchestrator-peek-queued-note').textContent).toContain(
      'Queued - it will send when this agent finishes its current step.'
    );
    await act(async () => el('orchestrator-peek-queued-send-now-btn').click());
    expect(chat.sendQueuedMessageNow).toHaveBeenCalledWith('a1', 'q1');
    expect(query('orchestrator-peek-queued-note')).toBeNull();

    await typeAndSend('again');
    await act(async () => el('orchestrator-peek-queued-cancel-btn').click());
    expect(chat.cancelQueuedMessage).toHaveBeenCalledWith('a1', 'q1');
    expect(query('orchestrator-peek-queued-note')).toBeNull();
  });

  it('clears the queued note once the message leaves that session queue, and unsubscribes', async () => {
    const message = { id: 'q1', sessionId: 'a1', text: 'hello' } as ChatQueuedMessage;
    chat.sendMessage.mockResolvedValue({ ok: true, queued: true, message });
    await renderDrawer(agentFixture('a1'));
    await typeAndSend('hello');
    expect(chat.onQueueChanged).toHaveBeenCalledTimes(1);

    const emit = (event: ChatQueueEvent) => act(async () => queueListener?.(event));
    await emit({ sessionId: 'other', queued: [] });
    await emit({ sessionId: 'a1', queued: [message] });
    expect(query('orchestrator-peek-queued-note')).not.toBeNull();

    await emit({ sessionId: 'a1', queued: [] });
    expect(query('orchestrator-peek-queued-note')).toBeNull();
    expect(queueUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes from queue changes on unmount', async () => {
    chat.sendMessage.mockResolvedValue({ ok: true, queued: true, message: { id: 'q1', sessionId: 'a1', text: 'x' } });
    await renderDrawer(agentFixture('a1'));
    await typeAndSend('x');
    themed.unmount();
    expect(queueUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps the queued note and shows the error when settling it fails', async () => {
    chat.sendMessage.mockResolvedValue({
      ok: true,
      queued: true,
      message: { id: 'q1', sessionId: 'a1', text: 'hello' },
    });
    chat.cancelQueuedMessage.mockRejectedValue(new Error('too late'));
    await renderDrawer(agentFixture('a1'));
    await typeAndSend('hello');
    await act(async () => el('orchestrator-peek-queued-cancel-btn').click());
    expect(el('orchestrator-peek-error').textContent).toBe('too late');
    expect(query('orchestrator-peek-queued-note')).not.toBeNull();
  });

  it('shows the error when the send is refused or throws', async () => {
    chat.sendMessage.mockResolvedValueOnce({ ok: false, error: 'Signed out' });
    await renderDrawer(agentFixture('a1'));
    await typeAndSend('hello');
    expect(el('orchestrator-peek-error').textContent).toBe('Signed out');
    chat.sendMessage.mockRejectedValueOnce(new Error('ipc down'));
    await act(async () => el('orchestrator-peek-send-btn').click());
    expect(el('orchestrator-peek-error').textContent).toBe('ipc down');
  });

  it('hides Stop for a finished agent but offers it while working', async () => {
    await renderDrawer(agentFixture('a1', 'done'));
    expect(query('orchestrator-peek-stop-btn')).toBeNull();
    themed.unmount();
    await renderDrawer(agentFixture('a1', 'working'));
    await act(async () => el('orchestrator-peek-stop-btn').click());
    expect(actions.stop).toHaveBeenCalledWith('a1');
  });

  it('archives then closes', async () => {
    await renderDrawer(agentFixture('a1'));
    await act(async () => el('orchestrator-peek-archive-btn').click());
    expect(actions.archive).toHaveBeenCalledWith('a1');
    expect(onClose).toHaveBeenCalled();
  });
});
