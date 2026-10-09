import { describe, expect, it } from 'vitest';
import type { ChatArtifactSummary } from '@shared/chat';
import { avatarColors, countTypes, indexArtifacts, initialOf, selectArtifacts, shortDate } from './artifactLibrary';

const rows: ChatArtifactSummary[] = [
  { id: 'a', title: 'beta chart', type: 'html', createdAt: '2026-03-02T00:00:00.000Z' },
  { id: 'b', title: 'Alpha flow', type: 'mermaid', createdAt: '2026-01-05T00:00:00.000Z', description: 'Login FLOW' },
  { id: 'c', title: 'Gamma page', type: 'html', createdAt: '2026-06-10T00:00:00.000Z' },
  { id: 'd', title: 'no date', type: 'code', createdAt: '' },
];
const indexed = indexArtifacts(rows);
const ids = (list: ChatArtifactSummary[]) => list.map(row => row.id);

describe('selectArtifacts', () => {
  it('sorts newest first, oldest first and by title, with undated rows last on both date orders', () => {
    expect(ids(selectArtifacts(indexed, { query: '', type: null, sort: 'newest' }))).toEqual(['c', 'a', 'b', 'd']);
    expect(ids(selectArtifacts(indexed, { query: '', type: null, sort: 'oldest' }))).toEqual(['b', 'a', 'c', 'd']);
    expect(ids(selectArtifacts(indexed, { query: '', type: null, sort: 'title' }))).toEqual(['b', 'a', 'c', 'd']);
  });

  it('searches title and description case-insensitively', () => {
    expect(ids(selectArtifacts(indexed, { query: 'PAGE', type: null, sort: 'newest' }))).toEqual(['c']);
    expect(ids(selectArtifacts(indexed, { query: ' login flow ', type: null, sort: 'newest' }))).toEqual(['b']);
  });

  it('narrows by type and combines with search', () => {
    expect(ids(selectArtifacts(indexed, { query: '', type: 'html', sort: 'newest' }))).toEqual(['c', 'a']);
    expect(ids(selectArtifacts(indexed, { query: 'beta', type: 'html', sort: 'newest' }))).toEqual(['a']);
    expect(selectArtifacts(indexed, { query: 'beta', type: 'mermaid', sort: 'newest' })).toEqual([]);
  });

  it('does not reorder the indexed rows it was given', () => {
    selectArtifacts(indexed, { query: '', type: null, sort: 'title' });
    expect(indexed.map(row => row.summary.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('countTypes', () => {
  it('counts every loaded row per type, largest first, labelled like the row chip', () => {
    expect(countTypes(indexed)).toEqual([
      { type: 'html', label: 'HTML', count: 2 },
      { type: 'code', label: 'Code', count: 1 },
      { type: 'mermaid', label: 'Diagram', count: 1 },
    ]);
  });

  it('labels an unknown type with its raw value', () => {
    expect(countTypes(indexArtifacts([{ id: 'x', title: 't', type: 'mystery', createdAt: '' }]))[0]?.label).toBe(
      'mystery'
    );
  });
});

describe('row helpers', () => {
  it('gives an id the same avatar colour every time, and a distinct pair per mode', () => {
    expect(avatarColors('abc', 'light')).toEqual(avatarColors('abc', 'light'));
    expect(avatarColors('abc', 'light')).not.toEqual(avatarColors('abc', 'dark'));
    const hues = new Set(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map(id => avatarColors(id, 'light').background));
    expect(hues.size).toBeGreaterThan(3);
  });

  it('takes a whole first character for the initial, and a placeholder for a blank title', () => {
    expect(initialOf('  report')).toBe('R');
    expect(initialOf('\u{1F600} smile')).toBe('\u{1F600}');
    expect(initialOf('   ')).toBe('?');
  });

  it('drops the year from a same-year date only', () => {
    const now = new Date('2026-10-09T12:00:00.000Z');
    expect(shortDate('2026-08-27T12:00:00.000Z', now)).not.toMatch(/2026/);
    expect(shortDate('2025-08-27T12:00:00.000Z', now)).toMatch(/2025/);
    expect(shortDate('not a date', now)).toBe('');
  });
});
