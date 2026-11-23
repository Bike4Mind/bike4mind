import type { ChatMessage, ChatToolCall } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import {
  collectMatches,
  describeCount,
  findPattern,
  messageScope,
  roundScope,
  stepMatch,
  threadSegments,
  toolScope,
} from './threadFind';

const at = '2026-11-01T00:00:00.000Z';
const call = (id: string, extra: Partial<ChatToolCall> = {}): ChatToolCall => ({
  id,
  name: 'bash_execute',
  input: { command: `grep needle ${id}` },
  status: 'done',
  preview: `needle in ${id} output`,
  ...extra,
});

const thread: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'Find the Needle please', createdAt: at },
  {
    id: 'a1',
    role: 'assistant',
    content: '',
    createdAt: at,
    rounds: [
      { text: 'Looking for needle.', toolCallIds: ['c1'] },
      { text: 'Here:\n```ts\nconst needle = 1;\n```', toolCallIds: [] },
    ],
    toolCalls: [call('c1')],
  },
  {
    id: 'r1',
    role: 'user',
    content: 'relayed needle',
    relay: { fromSessionId: 's2', fromTitle: 'Other', hops: 1 },
    createdAt: at,
  },
  { id: 'b1', role: 'assistant', content: 'cleared needle', boundary: { kind: 'clear' }, createdAt: at } as ChatMessage,
  {
    id: 'b2',
    role: 'assistant',
    content: 'summary needle',
    boundary: { kind: 'compact' },
    createdAt: at,
  } as ChatMessage,
  {
    id: 'k1',
    role: 'user',
    content: 'skill body needle',
    skill: { name: 'ship', source: 'account' },
    createdAt: at,
  } as ChatMessage,
];

describe('threadSegments', () => {
  it('collects user text, reply rounds, tool input and output, relays and compact summaries in thread order', () => {
    const segments = threadSegments(thread);
    expect(segments.map(segment => segment.scope)).toEqual([
      messageScope('u1'),
      roundScope('a1', 0),
      toolScope('c1', 'input'),
      toolScope('c1', 'output'),
      roundScope('a1', 1),
      messageScope('r1'),
      messageScope('b2'),
    ]);
    expect(segments.find(segment => segment.scope === toolScope('c1', 'output'))).toMatchObject({
      messageId: 'a1',
      messageIndex: 1,
      callId: 'c1',
      part: 'output',
    });
    // Code blocks are part of a round's text.
    expect(segments.find(segment => segment.scope === roundScope('a1', 1))?.text).toContain('const needle');
  });

  it('leaves out a skill body and a /clear divider, which draw no searchable text', () => {
    const scopes = threadSegments(thread).map(segment => segment.scope);
    expect(scopes).not.toContain(messageScope('k1'));
    expect(scopes).not.toContain(messageScope('b1'));
  });

  it('takes an errored call output from its error, and skips the input of a call that drew a diff', () => {
    const errored: ChatMessage = {
      id: 'a2',
      role: 'assistant',
      content: '',
      createdAt: at,
      rounds: [{ text: '', toolCallIds: ['c2'] }],
      toolCalls: [
        call('c2', {
          error: 'boom needle',
          preview: 'ignored',
          diff: { path: 'a.ts', hunks: [] } as unknown as ChatToolCall['diff'],
        }),
      ],
    };
    const segments = threadSegments([errored]);
    expect(segments.map(segment => [segment.scope, segment.text])).toEqual([
      [toolScope('c2', 'output'), 'boom needle'],
    ]);
  });
});

describe('collectMatches', () => {
  const segments = threadSegments(thread);

  it('is case-insensitive by default and counts every occurrence in each segment', () => {
    const matches = collectMatches(segments, 'needle', false);
    expect(matches).toHaveLength(7);
    expect(matches.filter(match => match.scope === toolScope('c1', 'input'))).toHaveLength(1);
    expect(matches[0]).toMatchObject({ scope: messageScope('u1'), occurrence: 0 });
  });

  it('honours the case toggle', () => {
    expect(collectMatches(segments, 'Needle', true).map(match => match.scope)).toEqual([messageScope('u1')]);
  });

  it('numbers repeated occurrences within one segment', () => {
    const repeated = threadSegments([{ id: 'u', role: 'user', content: 'ab ab AB', createdAt: at }]);
    expect(collectMatches(repeated, 'ab', false).map(match => match.occurrence)).toEqual([0, 1, 2]);
  });

  it('treats the query literally, not as a pattern', () => {
    const literal = threadSegments([{ id: 'u', role: 'user', content: 'a.b axb (x)', createdAt: at }]);
    expect(collectMatches(literal, 'a.b', false)).toHaveLength(1);
    expect(collectMatches(literal, '(x)', false)).toHaveLength(1);
  });

  it('finds nothing for an empty query and stops counting at the cap', () => {
    expect(collectMatches(segments, '', false)).toEqual([]);
    expect(findPattern('', false)).toBeNull();
    expect(collectMatches(segments, 'e', false, 3)).toHaveLength(3);
  });
});

describe('stepMatch and describeCount', () => {
  it('wraps at both ends', () => {
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });

  it('says where the bar is, and when the count stopped at the cap', () => {
    expect(describeCount(2, 12)).toBe('3 of 12');
    expect(describeCount(-1, 0)).toBe('No results');
    expect(describeCount(0, 10, 10)).toBe('1 of 10+');
  });
});
