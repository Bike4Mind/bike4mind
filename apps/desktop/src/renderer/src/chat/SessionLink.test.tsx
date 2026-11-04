// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { formatSessionMention } from '@shared/sessionMention';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MentionedText, SessionOpenerContext } from './SessionLink';

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

const ID = '123e4567-e89b-12d3-a456-426614174000';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(text: string, open?: (sessionId: string) => void): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <CssVarsProvider>
        <SessionOpenerContext.Provider value={open}>
          <MentionedText text={text} />
        </SessionOpenerContext.Provider>
      </CssVarsProvider>
    );
  });
}

const link = () => host?.querySelector<HTMLElement>('[data-testid="session-mention-link"]') ?? null;

describe('MentionedText', () => {
  it('renders plain text as text with no link', () => {
    mount('nothing to see here', vi.fn());
    expect(host?.textContent).toBe('nothing to see here');
    expect(link()).toBeNull();
  });

  it('draws a mention as a link that opens that conversation', () => {
    const open = vi.fn();
    mount(`ask ${formatSessionMention(ID, 'Docs pass')} about it`, open);

    expect(host?.textContent).toBe('ask @Docs pass about it');
    act(() => link()?.click());
    expect(open).toHaveBeenCalledWith(ID);
  });

  it('degrades to plain text when nothing can open a conversation', () => {
    mount(`ask ${formatSessionMention(ID, 'Docs pass')}`);
    expect(host?.textContent).toBe('ask @Docs pass');
    expect(link()).toBeNull();
  });
});
