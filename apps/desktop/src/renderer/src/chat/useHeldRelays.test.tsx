// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatHeldRelay, ChatStreamEvent } from '@shared/chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useHeldRelays, type HeldRelaysController } from './useHeldRelays';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (id: string, sessionId: string): ChatHeldRelay => ({
  id,
  sessionId,
  text: 'please run the migration',
  relay: { fromSessionId: 'sender-1', fromTitle: 'Docs pass', hops: 1 },
  heldAt: '2026-10-05T00:00:00.000Z',
  reason: 'other-project',
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(sessionId: string, initial: ChatHeldRelay[]) {
  let push: (event: ChatStreamEvent) => void = () => {};
  const getHeldRelays = vi.fn(() => Promise.resolve(initial));
  (window as unknown as { b4m: unknown }).b4m = {
    chat: {
      getHeldRelays,
      resolveHeldRelay: vi.fn(),
      onStreamEvent: (callback: (event: ChatStreamEvent) => void) => {
        push = callback;
        return () => {};
      },
    },
  };
  let controller: HeldRelaysController | null = null;
  function Probe() {
    controller = useHeldRelays(sessionId);
    return null;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Probe />);
  });
  return { getHeldRelays, push: (event: ChatStreamEvent) => act(() => push(event)), held: () => controller?.held };
}

describe('useHeldRelays', () => {
  it('reads the held messages when the conversation opens', async () => {
    const { getHeldRelays, held } = await mount('s1', [entry('h1', 's1')]);
    expect(getHeldRelays).toHaveBeenCalledWith('s1');
    expect(held()?.map(item => item.id)).toEqual(['h1']);
  });

  it('replaces the list on a push for its own session and ignores another session', async () => {
    const { push, held } = await mount('s1', []);

    push({ type: 'held-relays', sessionId: 's1', held: [entry('h2', 's1')] });
    expect(held()?.map(item => item.id)).toEqual(['h2']);

    push({ type: 'held-relays', sessionId: 'other', held: [entry('h3', 'other')] });
    expect(held()?.map(item => item.id)).toEqual(['h2']);
  });
});
