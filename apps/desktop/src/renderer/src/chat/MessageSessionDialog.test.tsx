// @vitest-environment jsdom
import { chatBackedHostBridge } from '../__fixtures__/chatBackedHostBridge';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { SendMessageResult } from '@shared/chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageSessionDialog } from './MessageSessionDialog';

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

// Joy's popups (menus, selects, tooltips, modals) read every ancestor's computed style on each update,
// and jsdom resolves that against every emotion sheet with no layout to find; the inline style will do.
window.getComputedStyle = ((element: Element) => (element as HTMLElement).style) as typeof getComputedStyle;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const el = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

function mount(result: () => Promise<SendMessageResult>, onClose = vi.fn()) {
  const sendMessage = vi.fn(result);
  (window as unknown as { b4m: unknown }).b4m = { host: chatBackedHostBridge(), chat: { sendMessage } };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <CssVarsProvider>
        <MessageSessionDialog session={{ id: 'target', title: 'Docs pass' }} onClose={onClose} />
      </CssVarsProvider>
    );
  });
  return { sendMessage, onClose };
}

function type(text: string) {
  const input = el('message-session-input') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('MessageSessionDialog', () => {
  it('cannot send an empty message', () => {
    mount(async () => ({ ok: true, messageId: 'm' }));
    expect(el('message-session-send-btn')?.hasAttribute('disabled')).toBe(true);
  });

  it('sends as the user to that session id and closes on success', async () => {
    const { sendMessage, onClose } = mount(async () => ({ ok: true, messageId: 'm' }));
    type('  ship it  ');
    await act(async () => el('message-session-send-btn')?.click());
    expect(sendMessage).toHaveBeenCalledWith({ sessionId: 'target', text: 'ship it' });
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the dialog open and shows the refusal inline', async () => {
    const { onClose } = mount(async () => ({ ok: false, error: 'Sign in first' }));
    type('hi');
    await act(async () => el('message-session-send-btn')?.click());
    expect(el('message-session-error')?.textContent).toContain('Sign in first');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cancels without sending', () => {
    const { sendMessage, onClose } = mount(async () => ({ ok: true, messageId: 'm' }));
    act(() => el('message-session-cancel-btn')?.click());
    expect(onClose).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
