// @vitest-environment jsdom
import { chatBackedHostBridge } from '../__fixtures__/chatBackedHostBridge';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatStreamEvent } from '@shared/chat';
import { afterEach, describe, expect, it } from 'vitest';
import { SpawnFailureToast } from './SpawnFailureToast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
let emit: (event: ChatStreamEvent) => void = () => undefined;
(window as unknown as { b4m: unknown }).b4m = {
  host: chatBackedHostBridge(),
  chat: {
    onStreamEvent: (listener: (event: ChatStreamEvent) => void) => {
      emit = listener;
      return () => undefined;
    },
  },
};

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const toast = () => document.querySelector<HTMLElement>('[data-testid="spawn-failure-toast"]');

describe('SpawnFailureToast', () => {
  it('shows the failed session and why it could not start, for a session nobody is subscribed to', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root?.render(
        <CssVarsProvider>
          <SpawnFailureToast />
        </CssVarsProvider>
      )
    );
    expect(toast()).toBeNull();

    act(() =>
      emit({
        type: 'spawn-failed',
        sessionId: 's1',
        title: 'Fix the build',
        message: 'The worktree could not be created.',
      })
    );

    expect(toast()?.textContent).toContain('"Fix the build" could not start');
    expect(toast()?.textContent).toContain('The worktree could not be created.');
  });
});
