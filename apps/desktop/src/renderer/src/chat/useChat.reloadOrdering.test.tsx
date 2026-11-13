// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatSessionSummary } from '@shared/chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSessions, type SessionsController } from './useChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summary = (id: string) =>
  ({
    id,
    title: id,
    mode: 'chat',
    messageCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }) as ChatSessionSummary;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(listSessions: () => Promise<ChatSessionSummary[]>) {
  (window as unknown as { b4m: unknown }).b4m = {
    chat: {
      listSessions,
      onSessionSummary: vi.fn(() => () => {}),
      onStreamEvent: vi.fn(() => () => {}),
    },
  };
  let controller: SessionsController | null = null;
  function Harness() {
    controller = useSessions();
    return null;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness />));
  return () => {
    if (!controller) throw new Error('not mounted');
    return controller;
  };
}

// The first send in a new chat awaits a reload and then selects the new id, and the shell
// reselects away from an open id the list lacks. So a reload must not resolve before a list that
// contains what it read has been applied, even when a newer reload (a status push) overtook it.
describe('reloading the session list', () => {
  it('resolves an overtaken reload only once the newer listing has been applied', async () => {
    const first = deferred<ChatSessionSummary[]>();
    const second = deferred<ChatSessionSummary[]>();
    const listSessions = vi
      .fn<() => Promise<ChatSessionSummary[]>>()
      .mockResolvedValueOnce([summary('old')])
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const controller = await mount(listSessions);

    let firstDone = false;
    let listedWhenFirstDone: string[] = [];
    await act(async () => {
      void controller()
        .reload()
        .then(() => {
          firstDone = true;
          listedWhenFirstDone = controller().sessions.map(session => session.id);
        });
      void controller().reload();
      first.resolve([summary('fresh'), summary('old')]);
    });
    expect(firstDone).toBe(false);

    await act(async () => second.resolve([summary('fresh'), summary('old')]));

    expect(firstDone).toBe(true);
    expect(listedWhenFirstDone).toContain('fresh');
  });

  it('still lets the newer listing win when the older one lands last', async () => {
    const first = deferred<ChatSessionSummary[]>();
    const second = deferred<ChatSessionSummary[]>();
    const listSessions = vi
      .fn<() => Promise<ChatSessionSummary[]>>()
      .mockResolvedValueOnce([summary('old')])
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const controller = await mount(listSessions);

    let pending!: Promise<void>;
    await act(async () => {
      pending = controller().reload();
      void controller().reload();
      second.resolve([summary('newer'), summary('old')]);
    });
    await act(async () => {
      first.resolve([summary('old')]);
      await pending;
    });

    expect(controller().sessions.map(session => session.id)).toEqual(['newer', 'old']);
  });
});
