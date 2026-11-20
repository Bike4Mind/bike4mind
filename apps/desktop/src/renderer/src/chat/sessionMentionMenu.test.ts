import type { ChatSessionSummary } from '@shared/chat';
import { findSessionMentions } from '@shared/sessionMention';
import { describe, expect, it } from 'vitest';
import {
  expandMentions,
  insertMention,
  locateMentions,
  matchSessions,
  mentionableSessions,
  mentionQuery,
  type MentionableSession,
} from './sessionMentionMenu';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

describe('mentionQuery', () => {
  it('opens at the start of the draft and after whitespace', () => {
    expect(mentionQuery('@')).toEqual({ query: '', start: 0, end: 1 });
    expect(mentionQuery('ask @do')).toEqual({ query: 'do', start: 4, end: 7 });
  });

  it('stays closed for an address, a finished word or a caret inside a word', () => {
    expect(mentionQuery('me@host')).toBeNull();
    expect(mentionQuery('@docs rest')).toBeNull();
    expect(mentionQuery('@ab', 2)).toBeNull();
  });

  it('answers the token at the caret when text follows after a space', () => {
    expect(mentionQuery('@do and more', 3)).toEqual({ query: 'do', start: 0, end: 3 });
  });
});

function summary(id: string, title: string, over: Partial<ChatSessionSummary> = {}): ChatSessionSummary {
  return { id, title, updatedAt: '2026-01-01T00:00:00.000Z', ...over } as ChatSessionSummary;
}

describe('mentionableSessions', () => {
  it('drops the open session and archived ones, newest first, with the project folder name', () => {
    const list = mentionableSessions(
      [
        summary('old', 'Old', { updatedAt: '2026-01-01T00:00:00.000Z' }),
        summary('new', 'New', {
          updatedAt: '2026-02-01T00:00:00.000Z',
          project: { directory: '/Users/me/dev/app/', name: 'app', branch: 'main' } as ChatSessionSummary['project'],
        }),
        summary('cur', 'Current'),
        summary('arch', 'Archived', { archived: true }),
      ],
      'cur'
    );
    expect(list).toEqual([
      { id: 'new', title: 'New', projectName: 'app' },
      { id: 'old', title: 'Old', projectName: null },
    ]);
  });
});

describe('matchSessions', () => {
  const sessions: MentionableSession[] = [
    { id: '1', title: 'Billing fix', projectName: 'api' },
    { id: '2', title: 'Fix login', projectName: 'web' },
    { id: '3', title: 'Notes', projectName: 'fixtures' },
    { id: '4', title: 'fix', projectName: null },
  ];

  it('ranks exact, then prefix, then substring, then project folder', () => {
    expect(matchSessions(sessions, 'fix').map(session => session.id)).toEqual(['4', '2', '1', '3']);
  });

  it('returns everything, in order, for an empty query', () => {
    expect(matchSessions(sessions, '').map(session => session.id)).toEqual(['1', '2', '3', '4']);
  });

  it('caps the list', () => {
    expect(matchSessions(sessions, '', 2)).toHaveLength(2);
  });
});

describe('insertMention', () => {
  it('replaces the token and leaves the caret after a trailing space', () => {
    const token = mentionQuery('see @bil')!;
    expect(insertMention('see @bil', token, 'Billing fix')).toEqual({ text: 'see @Billing fix ', caret: 17 });
  });

  it('reuses a space that is already there', () => {
    const token = mentionQuery('@b rest', 2)!;
    expect(insertMention('@b rest', token, 'Bill').text).toBe('@Bill rest');
  });
});

describe('expandMentions', () => {
  const recorded = [{ id: ID_A, title: 'Billing fix' }];

  it('turns a surviving label into markup the thread and main can read back', () => {
    const sent = expandMentions('ask @Billing fix about it', recorded);
    expect(findSessionMentions(sent)).toMatchObject([{ sessionId: ID_A, title: 'Billing fix' }]);
    expect(sent.startsWith('ask @[Billing fix](session:')).toBe(true);
    expect(sent.endsWith(' about it')).toBe(true);
  });

  it('drops a mention whose label was deleted', () => {
    expect(expandMentions('no mention here', recorded)).toBe('no mention here');
  });

  it('does not match inside a longer word', () => {
    expect(expandMentions('@Fixture', [{ id: ID_A, title: 'Fix' }])).toBe('@Fixture');
  });

  it('prefers the longer label where two overlap', () => {
    const sent = expandMentions('@Fix up', [
      { id: ID_A, title: 'Fix' },
      { id: ID_B, title: 'Fix up' },
    ]);
    expect(findSessionMentions(sent)).toMatchObject([{ sessionId: ID_B }]);
  });

  it('maps repeated identical titles to their sessions in order', () => {
    const located = locateMentions('@Fix and @Fix', [
      { id: ID_A, title: 'Fix' },
      { id: ID_B, title: 'Fix' },
    ]);
    expect(located.map(entry => entry.mention.id)).toEqual([ID_A, ID_B]);
  });

  it('is the identity with nothing recorded', () => {
    expect(expandMentions('@x', [])).toBe('@x');
  });
});
