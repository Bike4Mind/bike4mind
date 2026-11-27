// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PresenterPendingNotice } from './PresenterPendingNotice';

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

function render(count: number, onTurnOff = vi.fn()) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <CssVarsProvider>
        <PresenterPendingNotice count={count} onTurnOff={onTurnOff} />
      </CssVarsProvider>
    )
  );
  return onTurnOff;
}

const notice = () => document.querySelector('[data-testid="chat-presenter-pending-notice"]');

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('PresenterPendingNotice', () => {
  it('renders nothing when no item is waiting', () => {
    render(0);
    expect(notice()).toBeNull();
  });

  it('uses the singular for one item', () => {
    render(1);
    expect(notice()?.textContent).toContain('1 item waiting. Turn off Presenter mode to review.');
  });

  it('counts several items and turns Presenter mode off from the button', () => {
    const onTurnOff = render(3);
    expect(notice()?.textContent).toContain('3 items waiting.');
    act(() => {
      (document.querySelector('[data-testid="chat-presenter-pending-off-btn"]') as HTMLElement).click();
    });
    expect(onTurnOff).toHaveBeenCalledTimes(1);
  });
});
