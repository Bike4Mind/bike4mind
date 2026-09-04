import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { IChatHistoryItem } from '@bike4mind/common';
import { seatStreamingQuest } from './seatStreamingQuest';

const quest = (id: string, over: Partial<IChatHistoryItem> = {}) =>
  ({ id, prompt: `prompt ${id}`, replies: [], status: 'done', ...over }) as IChatHistoryItem;

describe('seatStreamingQuest', () => {
  it('leaves the history alone when nothing is streaming', () => {
    const history = [quest('b'), quest('a')];
    expect(seatStreamingQuest(history, null, null)).toBe(history);
  });

  // Substituting rather than inserting is what keeps one MessageContent instance across
  // the streaming -> completed handoff, so the node never remounts mid-answer.
  it('substitutes in place when the history already holds the streaming quest', () => {
    const streaming = quest('b', { status: 'running', replies: ['partial'] });
    const result = seatStreamingQuest([quest('b'), quest('a')], 'b', streaming);

    expect(result.map(q => q.id)).toEqual(['b', 'a']);
    expect(result[0]).toBe(streaming);
  });

  // The merge builds a quest from the socket alone when chunks beat React Query to it
  // (fresh sessions). Substituting alone matched nothing, so the turn - and the
  // rapid-reply bubble that rides on it - rendered nowhere.
  it('inserts the streaming quest when the history does not have it yet', () => {
    const streaming = quest('new', { status: 'running', replies: ['first tokens'] });
    const result = seatStreamingQuest([quest('a')], 'new', streaming);

    expect(result.map(q => q.id)).toEqual(['new', 'a']);
    expect(result[0]).toBe(streaming);
  });

  it('seats the streaming quest into an empty history', () => {
    const streaming = quest('only', { status: 'running' });
    expect(seatStreamingQuest([], 'only', streaming)).toEqual([streaming]);
  });

  // A pin or search filter runs before this and would otherwise drop the running turn,
  // leaving a footer spinner with no message to spin over.
  it('re-seats a streaming quest that the filters removed', () => {
    const streaming = quest('b', { status: 'running' });
    const result = seatStreamingQuest([quest('a', { pinned: true })], 'b', streaming);

    expect(result.map(q => q.id)).toEqual(['b', 'a']);
  });
});

/**
 * The helper's own behaviour is covered above, but the fix also depends on WHERE
 * SessionMiddle calls it: seating before the pin/search filters lets them drop the
 * running turn again, which is the regression this PR fixes. Nothing else fails if
 * that call moves back up, so the position is asserted here.
 *
 * Source-level, mirroring the useSendMessage.*.test.ts precedent - SessionMiddle
 * renders Virtuoso plus ~15 providers, so a render test would assert far less for
 * far more setup.
 */
describe('SessionMiddle - seats the streaming quest last', () => {
  const source = readFileSync(resolve(__dirname, 'SessionMiddle.tsx'), 'utf8');
  const memo = source.match(/const filteredChatHistory = useMemo\([\s\S]*?\}, \[/)?.[0] ?? '';

  it('locates the filteredChatHistory memo', () => {
    expect(memo).not.toBe('');
  });

  it('calls seatStreamingQuest after the pinned and search filters', () => {
    const seatAt = memo.indexOf('seatStreamingQuest(');
    const pinnedAt = memo.indexOf('showPinnedOnly');
    const searchAt = memo.indexOf('lowCaseSearch');

    expect(seatAt).toBeGreaterThan(-1);
    expect(pinnedAt).toBeGreaterThan(-1);
    expect(searchAt).toBeGreaterThan(-1);
    expect(seatAt).toBeGreaterThan(pinnedAt);
    expect(seatAt).toBeGreaterThan(searchAt);
  });

  it('does not filter the list after seating', () => {
    const afterSeat = memo.slice(memo.indexOf('seatStreamingQuest('));
    expect(afterSeat).not.toMatch(/\.filter\(/);
  });
});
