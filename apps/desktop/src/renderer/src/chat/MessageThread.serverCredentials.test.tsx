// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SERVER_CREDENTIALS_STOP, type ChatMessage } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageThread } from './MessageThread';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

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

describe('a reply a model server refused for credentials', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Element.prototype.scrollIntoView = () => undefined;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('offers the way to new credentials', () => {
    const message: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      error: 'gpu box refused the saved credentials. Enter new ones in Settings, Model servers.',
      stopReason: SERVER_CREDENTIALS_STOP,
    };
    act(() =>
      root.render(
        <CssVarsProvider>
          <MessageThread
            messages={[message]}
            sessionId="s1"
            streaming={false}
            onRespond={() => undefined}
            onContinue={() => undefined}
          />
        </CssVarsProvider>
      )
    );
    expect(container.querySelector('[data-testid="chat-server-credentials-chip"]')).not.toBeNull();
    act(() => container.querySelector<HTMLElement>('[data-testid="chat-server-credentials-btn"]')!.click());
    expect(navigate).toHaveBeenCalledWith({ to: '/settings', search: { section: 'servers' } });
  });
});
