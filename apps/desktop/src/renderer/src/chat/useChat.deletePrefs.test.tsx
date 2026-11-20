// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatSessionSummary } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const storePrefs = (id: string) => {
  window.localStorage.setItem(`b4m.orchestrator.surface.${id}`, 'orchestrate');
  window.localStorage.setItem(`b4m.orchestrator.view.${id}`, 'board');
};
const hasPrefs = (id: string) =>
  window.localStorage.getItem(`b4m.orchestrator.surface.${id}`) !== null ||
  window.localStorage.getItem(`b4m.orchestrator.view.${id}`) !== null;

let root: Root | null = null;
let host: HTMLElement | null = null;
let controller: SessionsController | null = null;

async function mount() {
  (window as unknown as { b4m: unknown }).b4m = {
    chat: {
      listSessions: vi.fn(() => Promise.resolve([summary('listed')])),
      deleteSession: vi.fn(() => Promise.resolve()),
      onSessionSummary: vi.fn(() => () => {}),
      onStreamEvent: vi.fn(() => () => {}),
    },
  };
  function Harness() {
    controller = useSessions();
    return null;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness />));
}

beforeEach(() => window.localStorage.clear());

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  controller = null;
});

describe('orchestrator prefs and the session list', () => {
  it('keeps prefs of sessions the listing does not include, such as another account scope', async () => {
    storePrefs('listed');
    storePrefs('other-scope');
    await mount();
    expect(controller?.loading).toBe(false);
    expect(hasPrefs('listed')).toBe(true);
    expect(hasPrefs('other-scope')).toBe(true);
  });

  it('forgets a session prefs when that session is deleted, and only its', async () => {
    storePrefs('listed');
    storePrefs('other-scope');
    await mount();
    await act(async () => controller?.remove('listed'));
    expect(hasPrefs('listed')).toBe(false);
    expect(hasPrefs('other-scope')).toBe(true);
  });
});
