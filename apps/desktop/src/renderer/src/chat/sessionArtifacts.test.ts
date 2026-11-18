import { describe, expect, it } from 'vitest';
import type { ChatArtifact, ChatMessage } from '@shared/chat';
import { paneDocument, sessionArtifacts, updatedLabel } from './sessionArtifacts';

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
