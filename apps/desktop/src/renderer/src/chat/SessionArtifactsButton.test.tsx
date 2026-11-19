// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { NO_SESSION_ARTIFACTS, SessionArtifactsButton } from './SessionArtifactsButton';
import type { SessionArtifact } from './sessionArtifacts';

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

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const find = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const get = (testId: string) => {
  const found = find(testId);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};

const entry = (key: string, title: string, type = 'html'): SessionArtifact => ({
  key,
  artifact: { id: `${key}-id`, type, title, content: '<p></p>', mimeType: 'text/html' },
  updatedAt: '2026-11-18T10:00:00Z',
});

async function mount(artifacts: SessionArtifact[], onOpen = vi.fn()) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <SessionArtifactsButton artifacts={artifacts} onOpen={onOpen} />
      </CssVarsProvider>
    );
  });
  return onOpen;
}

describe('SessionArtifactsButton', () => {
  it('lists the artifacts in the order given, with type and updated time', async () => {
    await mount([entry('b', 'Second', 'svg'), entry('a', 'First')]);
    await act(async () => get('chat-session-artifacts-btn').click());

    const rows = [...get('chat-session-artifacts-menu').querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(rows.map(row => row.dataset.artifactKey)).toEqual(['b', 'a']);
    expect(rows[0].textContent).toContain('Second');
    expect(rows[0].textContent).toContain('SVG');
    expect(rows[0].querySelector('[data-testid="chat-session-artifacts-updated"]')?.textContent).not.toBe('');
  });

  it('hands the clicked artifact to onOpen', async () => {
    const onOpen = await mount([entry('b', 'Second'), entry('a', 'First')]);
    await act(async () => get('chat-session-artifacts-btn').click());
    const rows = document.querySelectorAll<HTMLElement>('[data-testid="chat-session-artifacts-item"]');

    await act(async () => rows[1].click());

    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: 'a' }));
  });

  it('stays visible but disabled with no artifacts, and says why', async () => {
    const onOpen = await mount([]);
    const button = get('chat-session-artifacts-btn');

    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-label')).toBe(NO_SESSION_ARTIFACTS);
    await act(async () => button.click());
    expect(find('chat-session-artifacts-item')).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
