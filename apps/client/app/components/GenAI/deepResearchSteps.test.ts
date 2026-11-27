import { describe, expect, it } from 'vitest';
import { buildResearchSteps, formatElapsed, type DeepResearchActivity } from './deepResearchSteps';

const START = Date.parse('2026-11-05T10:00:00.000Z');
const at = (sec: number) => new Date(START + sec * 1000).toISOString();
const act = (
  type: DeepResearchActivity['type'],
  status: DeepResearchActivity['status'],
  message: string,
  sec = 0
): DeepResearchActivity => ({ type, status, message, timestamp: at(sec), depth: 1 });

const sources = [
  { url: 'https://example.com/a', title: 'A', description: 'about a', status: 'found' as const, timestamp: at(0) },
  { url: 'https://example.org/b', title: 'B', description: 'about b', status: 'found' as const, timestamp: at(0) },
];

describe('buildResearchSteps', () => {
  it('folds a search start and its result count into one step, without the engine name', () => {
    const steps = buildResearchSteps(
      [
        act('search', 'pending', 'Searching with searxng for: "ndfeb magnets"', 2),
        act('search', 'complete', 'searxng found 3 results for: "ndfeb magnets"', 5),
      ],
      [],
      START
    );
    expect(steps).toEqual([
      { id: '0', kind: 'search', status: 'complete', query: 'ndfeb magnets', resultCount: 3, elapsedSec: 2 },
    ]);
    expect(JSON.stringify(steps)).not.toContain('searxng');
  });

  it('marks a failed search on its own step and keeps the provider error out of it', () => {
    const steps = buildResearchSteps(
      [
        act('search', 'pending', 'Searching with searxng for: "q"'),
        act('search', 'error', 'searxng search failed: searxng returned 502'),
      ],
      [],
      START
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: 'search', status: 'error' });
  });

  it('folds a page read into one step numbered by its place in the sources', () => {
    const steps = buildResearchSteps(
      [
        act('extract', 'pending', 'Extracting content from https://example.org/b', 10),
        act('extract', 'pending', 'Extracting content from https://example.com/a', 10),
        act('extract', 'complete', 'Successfully extracted content from https://example.com/a', 12),
        act('extract', 'error', 'Failed to extract content from https://example.org/b', 13),
      ],
      sources,
      START
    );
    expect(steps).toEqual([
      expect.objectContaining({ kind: 'read', sourceIndex: 2, status: 'error' }),
      expect.objectContaining({ kind: 'read', sourceIndex: 1, status: 'complete', elapsedSec: 10 }),
    ]);
  });

  it('keeps the analysis summary and drops the bare completion line of the report step', () => {
    const steps = buildResearchSteps(
      [
        act('analyze', 'pending', 'Analyzing findings'),
        act('analyze', 'complete', 'China supplies most of the magnets.'),
        act('synthesis', 'pending', 'Synthesizing research findings into comprehensive report'),
        act('synthesis', 'complete', 'Research completed'),
      ],
      [],
      START
    );
    expect(steps).toEqual([
      expect.objectContaining({ kind: 'analyze', status: 'complete', detail: 'China supplies most of the magnets.' }),
      expect.objectContaining({ kind: 'write', status: 'complete', detail: '' }),
    ]);
  });

  it('keeps an unrecognised message as a note rather than dropping it', () => {
    const steps = buildResearchSteps([act('thought', 'error', 'Research failed: boom')], [], START);
    expect(steps).toEqual([
      expect.objectContaining({ kind: 'note', status: 'error', detail: 'Research failed: boom' }),
    ]);
  });
});

describe('formatElapsed', () => {
  it('formats seconds as m:ss', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(134.6)).toBe('2:14');
  });
});
