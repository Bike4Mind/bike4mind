// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectoryRequestCard } from './DirectoryRequestCard';

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

describe('DirectoryRequestCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(warning?: string) {
    const onAdd = vi.fn();
    const onDecline = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <CssVarsProvider>
          <DirectoryRequestCard
            path="/Users/someone/.claude/skills"
            reason="Edit SKILL.md."
            {...(warning ? { warning } : {})}
            onAdd={onAdd}
            onDecline={onDecline}
          />
        </CssVarsProvider>
      )
    );
    const card = container.querySelector('[data-testid="chat-directory-request"]') as HTMLElement;
    const press = (key: string) =>
      act(() => {
        card.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    return { onAdd, onDecline, card, press };
  }

  it('shows the folder, what it allows and the reason', () => {
    const { card } = render();
    expect(card.textContent).toContain('would like to add this folder to the session:');
    expect(container.querySelector('[data-testid="chat-directory-request-path"]')?.textContent).toBe(
      '/Users/someone/.claude/skills'
    );
    expect(card.textContent).toContain('read and change files in this folder for this session.');
    expect(container.querySelector('[data-testid="chat-directory-request-reason"]')?.textContent).toContain(
      'Edit SKILL.md.'
    );
    expect(container.querySelector('[data-testid="chat-directory-request-warning"]')).toBeNull();
  });

  it('adds on Enter and on the button, once', () => {
    const { onAdd, press } = render();
    press('Enter');
    press('Enter');
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('declines on Escape', () => {
    const { onAdd, onDecline, press } = render();
    press('Escape');
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('declines from the Not now button', () => {
    const { onDecline } = render();
    act(() => (container.querySelector('[data-testid="chat-directory-request-decline-btn"]') as HTMLElement).click());
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it('does not grant on Enter after text was typed at the card', () => {
    const { onAdd, press } = render();
    press('h');
    press('i');
    press('Enter');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('draws the broad-path warning and still allows adding', () => {
    render('This is your whole home folder.');
    expect(container.querySelector('[data-testid="chat-directory-request-warning"]')?.textContent).toContain(
      'whole home folder'
    );
    const add = container.querySelector('[data-testid="chat-directory-request-add-btn"]') as HTMLButtonElement;
    expect(add.disabled).toBe(false);
  });
});
