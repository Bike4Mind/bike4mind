// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionMentionPicker } from './SessionMentionPicker';
import { NO_PROJECT_LABEL, type MentionableSession } from './sessionMentionMenu';

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

const sessions: MentionableSession[] = [
  { id: 'a', title: 'Docs pass', projectName: 'docs' },
  { id: 'b', title: 'Scratch', projectName: null },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(onPick: (session: MentionableSession) => void): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <CssVarsProvider>
        <SessionMentionPicker sessions={sessions} activeIndex={0} onPick={onPick} />
      </CssVarsProvider>
    );
  });
}

const options = () => [...(host?.querySelectorAll<HTMLElement>('[data-testid="composer-mention-option"]') ?? [])];

describe('SessionMentionPicker', () => {
  it('lists each candidate with its project, or a label when it has none', () => {
    mount(vi.fn());
    expect(options().map(option => option.textContent)).toEqual(['Docs passdocs', `Scratch${NO_PROJECT_LABEL}`]);
  });

  it('picks the candidate that was pressed', () => {
    const onPick = vi.fn();
    mount(onPick);
    act(() => {
      options()[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(onPick).toHaveBeenCalledWith(sessions[1]);
  });
});
