// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatMessage, ChatToolCall } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageThread } from './MessageThread';
import { REGENERATE_WARNING_TEXT, REWIND_WARNING_TEXT } from './RewindControls';

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

const at = '2026-11-01T00:00:00.000Z';
const user = (id: string, content = id): ChatMessage => ({ id, role: 'user', content, createdAt: at });
const reply = (id: string, calls: Pick<ChatToolCall, 'name' | 'status'>[] = []): ChatMessage => ({
  id,
  role: 'assistant',
  content: `reply ${id}`,
  createdAt: at,
  ...(calls.length ? { toolCalls: calls.map((call, index) => ({ id: `${id}-${index}`, input: {}, ...call })) } : {}),
});

describe('edit and regenerate in the thread', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onEditMessage = vi.fn<(messageId: string, text: string) => Promise<boolean>>();
  const onRegenerate = vi.fn();

  beforeEach(() => {
    Element.prototype.scrollIntoView = () => undefined;
    onEditMessage.mockReset().mockResolvedValue(true);
    onRegenerate.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (messages: ChatMessage[], streaming = false) =>
    act(() =>
      root.render(
        <CssVarsProvider>
          <MessageThread
            messages={messages}
            sessionId="s1"
            streaming={streaming}
            onRespond={() => undefined}
            onContinue={() => undefined}
            onEditMessage={onEditMessage}
            onRegenerate={onRegenerate}
          />
        </CssVarsProvider>
      )
    );

  const all = (testId: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
  const one = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const click = (element: HTMLElement | null) => act(() => element?.click());
  const type = (text: string) => {
    const input = one('chat-message-user-editor-input') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const press = (key: string) =>
    act(() => {
      one('chat-message-user-editor-input')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });

  it('opens an inline editor with the prompt, and sends the edit for that message', async () => {
    render([user('u1', 'first'), reply('a1')]);
    click(all('chat-message-user-edit-btn')[0]);
    expect((one('chat-message-user-editor-input') as HTMLTextAreaElement).value).toBe('first');

    type('first, edited');
    await act(async () => one('chat-message-user-editor-send-btn')!.click());
    expect(onEditMessage).toHaveBeenCalledWith('u1', 'first, edited');
  });

  it('cancels with Escape and leaves the message as it was', () => {
    render([user('u1', 'first'), reply('a1')]);
    click(all('chat-message-user-edit-btn')[0]);
    type('changed my mind');
    press('Escape');
    expect(one('chat-message-user-editor')).toBeNull();
    expect(onEditMessage).not.toHaveBeenCalled();
  });

  it('warns that files are not restored only when a later turn changed them', () => {
    render([
      user('u1'),
      reply('a1', [{ name: 'file_write', status: 'done' }]),
      user('u2'),
      reply('a2', [{ name: 'grep_search', status: 'done' }]),
    ]);
    const [first, second] = all('chat-message-user-edit-btn');

    click(first);
    expect(one('chat-message-user-editor-warning')?.textContent).toBe(REWIND_WARNING_TEXT.changes);
    press('Escape');

    click(second);
    expect(one('chat-message-user-editor-warning')?.textContent).toBe(REWIND_WARNING_TEXT.later);
  });

  it('disables Edit and hides Regenerate while a turn is running', () => {
    render([user('u1'), reply('a1'), user('u2')], true);
    expect(all('chat-message-user-edit-btn').every(button => button.hasAttribute('disabled'))).toBe(true);
    expect(one('chat-message-assistant-regenerate-btn')).toBeNull();
  });

  it('offers no Edit on a prompt that is not stored yet', () => {
    render([user('pending-123')]);
    expect(one('chat-message-user-edit-btn')).toBeNull();
  });

  it('offers Regenerate on the last reply only, and runs it at once when nothing changed', () => {
    render([user('u1'), reply('a1'), user('u2'), reply('a2')]);
    expect(all('chat-message-assistant-regenerate-btn')).toHaveLength(1);
    click(one('chat-message-assistant-regenerate-btn'));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it('asks first when the reply being replaced changed files', () => {
    render([user('u1'), reply('a1', [{ name: 'bash_execute', status: 'done' }])]);
    click(one('chat-message-assistant-regenerate-btn'));
    expect(onRegenerate).not.toHaveBeenCalled();
    expect(one('chat-message-assistant-regenerate-confirm')?.textContent).toContain(REGENERATE_WARNING_TEXT);
    click(one('chat-message-assistant-regenerate-confirm-btn'));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });
});
