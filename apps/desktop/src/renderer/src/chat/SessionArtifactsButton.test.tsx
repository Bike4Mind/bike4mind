// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { NO_SESSION_ARTIFACTS, SessionArtifactsButton } from './SessionArtifactsButton';
import { type SessionArtifact, paneDocument, sessionArtifacts, updatedLabel } from './sessionArtifacts';
import type { ChatArtifact, ChatMessage } from '@shared/chat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SessionArtifactsButton', () => {
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
});

describe('sessionArtifacts', () => {
  const artifact = (id: string, extra: Partial<ChatArtifact> = {}): ChatArtifact => ({
    id,
    type: 'html',
    title: id,
    content: `<p>${id}</p>`,
    mimeType: 'text/html',
    ...extra,
  });

  const reply = (createdAt: string, artifacts: ChatArtifact[]): ChatMessage => ({
    id: createdAt,
    role: 'assistant',
    content: '',
    createdAt,
    artifacts,
  });

  describe('sessionArtifacts', () => {
    it('lists every artifact newest first', () => {
      const rows = sessionArtifacts([
        reply('2026-11-18T10:00:00Z', [artifact('a')]),
        { id: 'u', role: 'user', content: 'more', createdAt: '2026-11-18T10:30:00Z' },
        reply('2026-11-18T11:00:00Z', [artifact('b'), artifact('c')]),
      ]);
      expect(rows.map(row => row.key)).toEqual(['c', 'b', 'a']);
      expect(rows[2].updatedAt).toBe('2026-11-18T10:00:00Z');
    });

    it('keeps one row per identifier, at its latest version and time', () => {
      const rows = sessionArtifacts([
        reply('2026-11-18T10:00:00Z', [artifact('v1', { identifier: 'chart', title: 'Chart' })]),
        reply('2026-11-18T11:00:00Z', [artifact('other')]),
        reply('2026-11-18T12:00:00Z', [artifact('v2', { identifier: 'chart', title: 'Chart v2' })]),
      ]);
      expect(rows.map(row => [row.key, row.artifact.title])).toEqual([
        ['chart', 'Chart v2'],
        ['other', 'other'],
      ]);
    });

    it('is empty for a conversation with no artifacts', () => {
      expect(sessionArtifacts([reply('2026-11-18T10:00:00Z', [])])).toEqual([]);
    });
  });

  describe('paneDocument', () => {
    it('passes HTML through untouched', () => {
      expect(paneDocument({ type: 'html', title: 'Page', content: '<p>x</p>' })).toBe('<p>x</p>');
    });

    it('wraps an SVG in a page titled after the artifact, even when the SVG has its own title', () => {
      const page = paneDocument({ type: 'svg', title: 'Beta & co', content: '<svg><title>inner</title></svg>' });
      expect(page).toMatch(/^<!DOCTYPE html><html><head><meta charset="utf-8"><title>Beta &amp; co<[/]title><[/]head>/);
      expect(page).toContain('<body style="margin:0"><svg><title>inner</title></svg></body>');
    });

    it('shows any other type as escaped source', () => {
      const page = paneDocument({ type: 'code', title: 'Snippet', content: 'if (a < b && c) {}' });
      expect(page).toContain('<title>Snippet</title>');
      expect(page).toContain('<pre');
      expect(page).toContain('if (a &lt; b &amp;&amp; c) {}');
    });
  });

  describe('updatedLabel', () => {
    const now = new Date(2026, 10, 18, 15, 0);

    it('gives the time for today and the date otherwise', () => {
      expect(updatedLabel(new Date(2026, 10, 18, 9, 5).toISOString(), now)).toMatch(/9:05/);
      expect(updatedLabel(new Date(2026, 10, 2, 9, 5).toISOString(), now)).not.toMatch(/9:05|2026/);
      expect(updatedLabel(new Date(2025, 10, 2).toISOString(), now)).toMatch(/2025/);
    });

    it('is empty for a missing or unreadable time', () => {
      expect(updatedLabel('', now)).toBe('');
      expect(updatedLabel('nope', now)).toBe('');
    });
  });
});
