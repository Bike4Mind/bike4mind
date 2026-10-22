// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatMessage } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageThread } from './MessageThread';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no matchMedia, and Joy's colour-scheme provider asks for one on mount.
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

const at = '2026-10-22T00:00:00.000Z';

const prompt: ChatMessage = {
  id: 'u1',
  role: 'user',
  content: 'Why does https://example.com/a_b. fail (see https://example.com/c)?',
  createdAt: at,
};

const reply: ChatMessage = {
  id: 'a1',
  role: 'assistant',
  content: 'It redirects to https://example.com/login.\n\nSee [the docs](https://docs.example.com) too.',
  createdAt: at,
};

describe('links and copy in the thread', () => {
  let container: HTMLDivElement;
  let root: Root;
  const openExternal = vi.fn(async () => undefined);
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    Element.prototype.scrollIntoView = () => undefined;
    openExternal.mockClear();
    writeText.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('b4m', { shell: { openExternal } });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
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
          />
        </CssVarsProvider>
      )
    );

  const within = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
  const hrefs = (scope: HTMLElement, linkTestId: string) =>
    [...scope.querySelectorAll(`[data-testid="${linkTestId}"]`)].map(anchor => anchor.getAttribute('href'));

  it('links the urls in a prompt without rendering the prompt as markdown', () => {
    render([prompt]);

    const user = within('chat-message-user');
    expect(hrefs(user, 'chat-message-link')).toEqual(['https://example.com/a_b', 'https://example.com/c']);
    // Still literal: nothing parsed the underscore or the parentheses as markup.
    expect(within('chat-message-user-text').textContent).toBe(prompt.content);
  });

  it('links a bare url in a reply as well as a written-out one', () => {
    render([prompt, reply]);

    expect(hrefs(within('chat-message-assistant'), 'chat-markdown-link')).toEqual([
      'https://example.com/login',
      'https://docs.example.com',
    ]);
  });

  it('opens a link from either side in the system browser', () => {
    render([prompt, reply]);

    act(() => within('chat-message-user').querySelector<HTMLAnchorElement>('a')!.click());
    act(() => within('chat-message-assistant').querySelector<HTMLAnchorElement>('a')!.click());

    expect(openExternal.mock.calls).toEqual([['https://example.com/a_b'], ['https://example.com/login']]);
  });

  it('copies the prompt as typed and the reply as its markdown source', async () => {
    render([prompt, reply]);

    await act(async () => within('chat-message-user-copy-btn').click());
    await act(async () => within('chat-message-assistant-copy-btn').click());

    expect(writeText.mock.calls).toEqual([[prompt.content], [reply.content]]);
    expect(within('chat-message-user-copy-btn').dataset.state).toBe('copied');
    expect(within('chat-message-assistant-copy-btn').dataset.state).toBe('copied');
  });

  it('copies the invocation on a skill turn, not the body it expanded to', async () => {
    render([
      {
        ...prompt,
        content: 'A page of skill instructions.',
        skill: { name: 'summary', args: 'notes', source: 'project' },
      },
    ]);

    await act(async () => within('chat-message-user-copy-btn').click());

    expect(writeText).toHaveBeenCalledExactlyOnceWith('/summary notes');
  });

  it('offers no copy on a reply that is still being written', () => {
    render([prompt, reply], true);

    expect(within('chat-message-user-copy-btn')).not.toBeNull();
    expect(within('chat-message-assistant-copy-btn')).toBeNull();
  });

  it('offers no copy on a turn with no text, or on a notice the app wrote', () => {
    render([
      { ...reply, id: 'a0', content: '' },
      { id: 's1', role: 'user', system: true, content: 'Done: https://example.com/pr/1', createdAt: at },
    ]);

    expect(container.querySelector('[data-testid$="-copy-btn"]')).toBeNull();
    // The notice's url is still a link.
    expect(hrefs(within('chat-message-system'), 'chat-message-link')).toEqual(['https://example.com/pr/1']);
  });
});
