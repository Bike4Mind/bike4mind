// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionMentionPicker } from './SessionMentionPicker';
import {
  NO_PROJECT_LABEL,
  type MentionableSession,
  expandMentions,
  insertMention,
  locateMentions,
  matchSessions,
  mentionableSessions,
  mentionQuery,
} from './sessionMentionMenu';
import type { ChatSessionSummary } from '@shared/chat';
import { findSessionMentions, formatSessionMention } from '@shared/sessionMention';
import type { PrSummary } from '@shared/pullRequest';
import { findSessionsByRef } from './sessionRefSearch';
import { MentionedText, SessionOpenerContext } from './SessionLink';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SessionMentionPicker', () => {
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
});

describe('sessionMentionMenu', () => {
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
    it('drops the open session, archived ones and Studio sessions, newest first, with the project folder name', () => {
      const list = mentionableSessions(
        [
          summary('old', 'Old', { updatedAt: '2026-01-01T00:00:00.000Z' }),
          summary('new', 'New', {
            updatedAt: '2026-02-01T00:00:00.000Z',
            project: { directory: '/Users/me/dev/app/', name: 'app', branch: 'main' } as ChatSessionSummary['project'],
          }),
          summary('cur', 'Current'),
          summary('arch', 'Archived', { archived: true }),
          summary('studio', 'Poster', { mode: 'studio' }),
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
});

describe('sessionRefSearch', () => {
  function session(id: string, title: string, extra: Partial<ChatSessionSummary> = {}): ChatSessionSummary {
    return {
      id,
      title,
      updatedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      mode: 'code',
      messageCount: 1,
      ...extra,
    } as ChatSessionSummary;
  }

  const NO_PRS = new Map<string, PrSummary>();

  describe('findSessionsByRef', () => {
    const titled = session('titled', '#1234 | PR#5678 | sidebar search', { updatedAt: '2026-03-01T00:00:00.000Z' });
    const bound = session('bound', 'Unrelated title');
    const mentioned = session('mentioned', 'Reading around', {
      githubRefs: [{ kind: 'issue', number: 1234, repo: 'acme/widgets' }],
    });
    const other = session('other', 'Upgrade to 1234 dependencies');
    const prs = new Map<string, PrSummary>([['bound', { number: 1234, state: 'open', repo: 'acme/widgets' }]]);

    it('returns nothing for a query that is not a ref', () => {
      expect(findSessionsByRef('sidebar', [titled], NO_PRS)).toEqual([]);
    });

    it('finds sessions by title, bound PR and mention, strongest first', () => {
      // Title and bound PR weigh the same; the more recent update wins between them.
      const hits = findSessionsByRef('1234', [mentioned, other, bound, titled], prs);
      expect(hits.map(hit => hit.session.id)).toEqual(['titled', 'bound', 'mentioned']);
      expect(hits.map(hit => hit.match.source)).toEqual(['title', 'pr', 'mention']);
    });

    it('tells issues from PRs when the query names a kind', () => {
      expect(findSessionsByRef('PR#5678', [titled, bound], prs).map(hit => hit.session.id)).toEqual(['titled']);
      expect(findSessionsByRef('issue 1234', [titled, bound], prs).map(hit => hit.session.id)).toEqual(['titled']);
    });

    it('finds a session from a pasted PR URL through its binding', () => {
      const hits = findSessionsByRef('https://github.com/acme/widgets/pull/1234', [bound, titled], prs);
      expect(hits[0].session.id).toBe('bound');
      expect(hits[0].match.ref).toEqual({ kind: 'pr', number: 1234, repo: 'acme/widgets' });
    });

    it('matches a ref in the branch', () => {
      const branched = session('branched', 'No number here', {
        project: { branch: 'fix/issue-42-crash' } as ChatSessionSummary['project'],
      });
      expect(findSessionsByRef('#42', [branched], NO_PRS)[0]?.match.source).toBe('branch');
    });

    it('breaks ties by the most recent update', () => {
      const older = session('older', 'PR#9 old', { updatedAt: '2026-01-01T00:00:00.000Z' });
      const newer = session('newer', 'PR#9 new', { updatedAt: '2026-02-01T00:00:00.000Z' });
      expect(findSessionsByRef('9', [older, newer], NO_PRS).map(hit => hit.session.id)).toEqual(['newer', 'older']);
    });
  });
});

describe('SessionLink', () => {
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

  const ID = '123e4567-e89b-12d3-a456-426614174000';

  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  function mount(text: string, open?: (sessionId: string) => void): void {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <CssVarsProvider>
          <SessionOpenerContext.Provider value={open}>
            <MentionedText text={text} />
          </SessionOpenerContext.Provider>
        </CssVarsProvider>
      );
    });
  }

  const link = () => host?.querySelector<HTMLElement>('[data-testid="session-mention-link"]') ?? null;

  describe('MentionedText', () => {
    it('renders plain text as text with no link', () => {
      mount('nothing to see here', vi.fn());
      expect(host?.textContent).toBe('nothing to see here');
      expect(link()).toBeNull();
    });

    it('draws a mention as a link that opens that conversation', () => {
      const open = vi.fn();
      mount(`ask ${formatSessionMention(ID, 'Docs pass')} about it`, open);

      expect(host?.textContent).toBe('ask @Docs pass about it');
      act(() => link()?.click());
      expect(open).toHaveBeenCalledWith(ID);
    });

    it('degrades to plain text when nothing can open a conversation', () => {
      mount(`ask ${formatSessionMention(ID, 'Docs pass')}`);
      expect(host?.textContent).toBe('ask @Docs pass');
      expect(link()).toBeNull();
    });
  });
});
