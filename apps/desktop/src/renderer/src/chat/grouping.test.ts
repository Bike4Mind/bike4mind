import { describe, expect, it, afterEach } from 'vitest';
import type { ChatProject, ChatSessionSummary } from '@shared/chat';
import { prAttentionRank } from '@shared/prAttention';
import { LOCAL_HOST_ID } from '@shared/hostBridge';
import type { PrSummary } from '@shared/pullRequest';
import {
  nestedSessionsOf,
  descendantsOf,
  groupSessions,
  orderedSessions,
  parentHints,
  projectForGroup,
  projectGroupDirectory,
  projectKeyOf,
  QUICK_SWITCH_LIMIT,
} from './grouping';
import { capRows, GROUP_ROW_CAP, GROUP_ROW_STEP, groupLimit, setGroupLimit } from './groupCap';

function project(directory: string, name: string): ChatProject {
  return {
    directory,
    name,
    branch: 'main',
    workspace: false,
    workingDirectory: directory,
    contextDirectories: [],
  };
}

function session(overrides: Partial<ChatSessionSummary> & Pick<ChatSessionSummary, 'id'>): ChatSessionSummary {
  return {
    title: overrides.id,
    model: 'test-model',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    mode: 'chat',
    approvalMode: 'ask',
    reasoningEffort: 'default',
    messageCount: 0,
    ...overrides,
  };
}

describe('groupSessions', () => {
  it('shows only the sessions of the selected mode', () => {
    const sessions = [session({ id: 'a' }), session({ id: 'b', mode: 'code', project: project('/r/one', 'one') })];

    expect(groupSessions(sessions, 'chat').loose.map(entry => entry.id)).toEqual(['a']);
    expect(groupSessions(sessions, 'code').projects).toHaveLength(1);
  });

  it('groups code sessions by project directory', () => {
    const sections = groupSessions(
      [
        session({ id: 'a', mode: 'code', project: project('/r/one', 'one') }),
        session({ id: 'b', mode: 'code', project: project('/r/two', 'two') }),
        session({ id: 'c', mode: 'code', project: project('/r/one', 'one') }),
      ],
      'code'
    );

    expect(sections.projects.map(group => [group.name, group.sessions.map(s => s.id)])).toEqual([
      ['one', ['a', 'c']],
      ['two', ['b']],
    ]);
  });

  // Two projects can share a basename; the directory is what identifies a group.
  it('keeps same-named projects in different directories apart', () => {
    const sections = groupSessions(
      [
        session({ id: 'a', mode: 'code', project: project('/work/api', 'api') }),
        session({ id: 'b', mode: 'code', project: project('/side/api', 'api') }),
      ],
      'code'
    );

    expect(sections.projects.map(group => group.directory)).toEqual(['/work/api', '/side/api']);
  });

  it('lifts a pinned session out of its group rather than showing it twice', () => {
    const sections = groupSessions(
      [
        session({ id: 'a', mode: 'code', pinned: true, project: project('/r/one', 'one') }),
        session({ id: 'b', mode: 'code', project: project('/r/one', 'one') }),
      ],
      'code'
    );

    expect(sections.pinned.map(entry => entry.id)).toEqual(['a']);
    expect(sections.projects[0].sessions.map(entry => entry.id)).toEqual(['b']);
  });

  it('keeps chat sessions loose, outside any group', () => {
    const sections = groupSessions([session({ id: 'a' }), session({ id: 'b', pinned: true })], 'chat');

    expect(sections.projects).toEqual([]);
    expect(sections.loose.map(entry => entry.id)).toEqual(['a']);
    expect(sections.pinned.map(entry => entry.id)).toEqual(['b']);
  });
});

describe('orderedSessions', () => {
  it('reads pinned first, then each project, then the loose rows', () => {
    const sections = groupSessions(
      [
        session({ id: 'loose' }),
        session({ id: 'pin', pinned: true }),
        session({ id: 'one-a', mode: 'code', project: project('/r/one', 'one') }),
        session({ id: 'two-a', mode: 'code', project: project('/r/two', 'two') }),
        session({ id: 'one-b', mode: 'code', project: project('/r/one', 'one') }),
      ],
      'chat'
    );
    expect(orderedSessions(sections).map(entry => entry.id)).toEqual(['pin', 'loose']);

    const code = groupSessions(
      [
        session({ id: 'pin', mode: 'code', pinned: true, project: project('/r/one', 'one') }),
        session({ id: 'one-a', mode: 'code', project: project('/r/one', 'one') }),
        session({ id: 'two-a', mode: 'code', project: project('/r/two', 'two') }),
        session({ id: 'one-b', mode: 'code', project: project('/r/one', 'one') }),
      ],
      'code'
    );
    expect(orderedSessions(code).map(entry => entry.id)).toEqual(['pin', 'one-a', 'one-b', 'two-a']);
  });
});

describe('archived sessions', () => {
  it('lifts them out of every other section, pinned included', () => {
    const sections = groupSessions(
      [
        session({ id: 'live', mode: 'code', project: project('/r/one', 'one') }),
        session({ id: 'gone', mode: 'code', archived: true, project: project('/r/one', 'one') }),
        // Archiving outranks pinning, or archive would be the one action with no visible effect.
        session({ id: 'pinned-gone', mode: 'code', pinned: true, archived: true, project: project('/r/one', 'one') }),
      ],
      'code'
    );

    expect(sections.archived.map(entry => entry.id)).toEqual(['gone', 'pinned-gone']);
    expect(sections.pinned).toEqual([]);
    expect(sections.projects.flatMap(group => group.sessions).map(entry => entry.id)).toEqual(['live']);
  });

  it('keeps archived rows out of the quick-switch order, which counts what is drawn', () => {
    const sections = groupSessions([session({ id: 'live' }), session({ id: 'gone', archived: true })], 'chat');
    expect(orderedSessions(sections).map(entry => entry.id)).toEqual(['live']);
  });
});

describe('user sections', () => {
  const userSections = {
    sections: [
      { id: 'work', name: 'Work' },
      { id: 'home', name: 'Home' },
    ],
    assignments: { filed: 'work', 'pinned-filed': 'work', 'archived-filed': 'work', 'stale-filed': 'gone' },
  };

  it('moves a filed session out of its project group and into its section', () => {
    const sections = groupSessions(
      [
        session({ id: 'filed', mode: 'code', project: project('/r/one', 'one') }),
        session({ id: 'unfiled', mode: 'code', project: project('/r/one', 'one') }),
      ],
      'code',
      userSections
    );

    expect(sections.custom.map(group => [group.section.name, group.sessions.map(entry => entry.id)])).toEqual([
      ['Work', ['filed']],
      ['Home', []],
    ]);
    expect(sections.projects.flatMap(group => group.sessions).map(entry => entry.id)).toEqual(['unfiled']);
  });

  it('lets pinning and archiving outrank a section, and ignores a section that is gone', () => {
    const sections = groupSessions(
      [
        session({ id: 'pinned-filed', pinned: true }),
        session({ id: 'archived-filed', archived: true }),
        session({ id: 'stale-filed' }),
      ],
      'chat',
      userSections
    );

    expect(sections.pinned.map(entry => entry.id)).toEqual(['pinned-filed']);
    expect(sections.archived.map(entry => entry.id)).toEqual(['archived-filed']);
    expect(sections.loose.map(entry => entry.id)).toEqual(['stale-filed']);
    expect(sections.custom.every(group => group.sessions.length === 0)).toBe(true);
  });

  it('counts section rows in the quick-switch order right after the pinned ones', () => {
    const sections = groupSessions(
      [session({ id: 'loose' }), session({ id: 'filed' }), session({ id: 'pin', pinned: true })],
      'chat',
      userSections
    );

    expect(orderedSessions(sections).map(entry => entry.id)).toEqual(['pin', 'filed', 'loose']);
  });

  describe('a section that holds sessions of only one mode', () => {
    const state = {
      sections: [
        { id: 'code-only', name: 'Code only' },
        { id: 'empty', name: 'Empty' },
        { id: 'both', name: 'Both' },
      ],
      assignments: { c1: 'code-only', c2: 'both', h1: 'both' },
    };
    const sessions = [
      session({ id: 'c1', mode: 'code', project: project('/r/one', 'one') }),
      session({ id: 'c2', mode: 'code', project: project('/r/one', 'one') }),
      session({ id: 'h1' }),
    ];
    const names = (mode: 'chat' | 'code') =>
      groupSessions(sessions, mode, state).custom.map(group => group.section.name);

    it('is hidden in the mode it has no sessions in, and shown in the other', () => {
      expect(names('chat')).not.toContain('Code only');
      expect(names('code')).toContain('Code only');
    });

    it('stays in both modes while it has no sessions at all', () => {
      expect(names('chat')).toContain('Empty');
      expect(names('code')).toContain('Empty');
    });

    it('shows in both modes when it holds a session of each', () => {
      expect(names('chat')).toContain('Both');
      expect(names('code')).toContain('Both');
    });
  });

  it('keeps untouched Claude imports in their own section unless asked to show them inline', () => {
    const origin = { kind: 'claude-code' as const, sourceId: 's', importedAt: 'x', sourceUpdatedAt: 'x' };
    const sessions = [
      session({ id: 'own' }),
      session({ id: 'imported', importOrigin: origin }),
      session({ id: 'continued', importOrigin: { ...origin, forkedAt: 'x' } }),
      session({ id: 'pinned-import', pinned: true, importOrigin: origin }),
    ];
    const grouped = groupSessions(sessions, 'chat');
    expect(grouped.imported.map(entry => entry.id)).toEqual(['imported']);
    expect(grouped.loose.map(entry => entry.id)).toEqual(['own', 'continued']);
    expect(grouped.pinned.map(entry => entry.id)).toEqual(['pinned-import']);
    expect(orderedSessions(grouped).map(entry => entry.id)).not.toContain('imported');

    const inline = groupSessions(sessions, 'chat', undefined, true);
    expect(inline.imported).toEqual([]);
    expect(inline.loose.map(entry => entry.id)).toEqual(['own', 'imported', 'continued']);
  });
});

describe('Claude Code worktrees', () => {
  it('files a project picked inside one under its repository', () => {
    const sessions = [
      session({ id: 'root', mode: 'code', project: project('/work/repo', 'repo') }),
      session({ id: 'tree', mode: 'code', project: project('/work/repo/.claude/worktrees/wt', 'repo') }),
      session({ id: 'other', mode: 'code', project: project('/work/repo/.manifold/worktrees/run', 'run') }),
    ];
    const { projects } = groupSessions(sessions, 'code');
    expect(projects.map(group => [group.directory, group.name, group.sessions.map(entry => entry.id)])).toEqual([
      ['/work/repo', 'repo', ['root', 'tree']],
      ['/work/repo/.manifold/worktrees/run', 'run', ['other']],
    ]);
  });

  it('names the sidebar group directory of a project', () => {
    expect(projectGroupDirectory(project('/work/repo/.claude/worktrees/wt', 'wt'))).toBe('/work/repo');
    expect(projectGroupDirectory(project('/work/repo', 'repo'))).toBe('/work/repo');
    expect(projectGroupDirectory(project('/work/repo/.manifold/worktrees/run', 'run'))).toBe(
      '/work/repo/.manifold/worktrees/run'
    );
  });
});

describe('projects on two hosts', () => {
  it('keeps the same folder on two hosts as two projects, each starting sessions on its own host', () => {
    const local = project('/work/repo', 'repo');
    const remote = project('/work/repo', 'repo');
    const sessions = [
      session({ id: 'here', mode: 'code', project: local }),
      session({ id: 'there', mode: 'code', project: remote, hostId: 'devbox' }),
    ];
    const { projects } = groupSessions(sessions, 'code');
    expect(
      projects.map(group => [group.hostId, group.directory, group.key, group.sessions.map(entry => entry.id)])
    ).toEqual([
      [LOCAL_HOST_ID, '/work/repo', '/work/repo', ['here']],
      ['devbox', '/work/repo', 'devbox\n/work/repo', ['there']],
    ]);
    expect(projectForGroup(sessions, 'devbox', '/work/repo')).toBe(remote);
    expect(projectForGroup(sessions, LOCAL_HOST_ID, '/work/repo')).toBe(local);
  });
});

describe('starting a session from a project group', () => {
  it('finds a manually selected Claude worktree when no session names its repository root', () => {
    const worktree = project('/work/repo/.claude/worktrees/wt', 'wt');
    const sessions = [session({ id: 'tree', mode: 'code', project: worktree })];
    const group = groupSessions(sessions, 'code').projects[0];
    expect(group.directory).toBe('/work/repo');
    expect(projectForGroup(sessions, LOCAL_HOST_ID, group.directory)).toBe(worktree);
  });

  it('uses the most recent matching project without grouping unrelated worktrees', () => {
    const tree = project('/work/repo/.claude/worktrees/wt', 'wt');
    const root = project('/work/repo', 'repo');
    const other = project('/work/repo/.manifold/worktrees/other', 'other');
    const sessions = [
      session({ id: 'tree', mode: 'code', project: tree }),
      session({ id: 'root', mode: 'code', project: root }),
      session({ id: 'other', mode: 'code', project: other }),
    ];
    expect(projectForGroup(sessions, LOCAL_HOST_ID, '/work/repo')).toBe(tree);
    expect(projectForGroup(sessions, LOCAL_HOST_ID, other.directory)).toBe(other);
    expect(projectForGroup(sessions, LOCAL_HOST_ID, '/missing')).toBeUndefined();
  });
});

describe('nested sub-sessions', () => {
  const spawned = (id: string, parentSessionId: string, extra: Partial<ChatSessionSummary> = {}) =>
    session({ id, origin: { parentSessionId, depth: 1, seedPrompt: 'go' }, ...extra });

  it('hangs children under their parent and out of the flat list', () => {
    const sessions = [session({ id: 'root' }), spawned('kid', 'root'), spawned('grandkid', 'kid')];
    const grouped = groupSessions(sessions, 'chat', undefined, false, true);
    expect(grouped.loose.map(entry => entry.id)).toEqual(['root']);
    expect(descendantsOf(grouped.children, 'root').map(entry => entry.id)).toEqual(['kid', 'grandkid']);
  });

  it('nests a grandchild under its own parent, however deep the chain', () => {
    const sessions = [session({ id: 'root' }), spawned('kid', 'root'), spawned('grandkid', 'kid')];
    const grouped = groupSessions(sessions, 'chat', undefined, false, true);
    expect(grouped.children.get('root')?.map(entry => entry.id)).toEqual(['kid']);
    expect(grouped.children.get('kid')?.map(entry => entry.id)).toEqual(['grandkid']);
    expect(parentHints(sessions, grouped.children).size).toBe(0);
  });

  it('orders children by creation, not recency', () => {
    const sessions = [
      session({ id: 'root' }),
      spawned('late', 'root', { createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z' }),
      spawned('early', 'root', { createdAt: '2026-09-02T00:00:00.000Z' }),
    ];
    const grouped = groupSessions(sessions, 'chat', undefined, false, true);
    expect(grouped.children.get('root')?.map(entry => entry.id)).toEqual(['early', 'late']);
  });

  it('sorts a group by its most recently active member', () => {
    const sessions = [
      session({ id: 'newer', updatedAt: '2026-09-05T00:00:00.000Z' }),
      session({ id: 'busy-parent', updatedAt: '2026-09-02T00:00:00.000Z' }),
      spawned('busy-kid', 'busy-parent', { updatedAt: '2026-09-08T00:00:00.000Z' }),
      session({ id: 'older', updatedAt: '2026-09-01T00:00:00.000Z' }),
    ];
    expect(groupSessions(sessions, 'chat', undefined, false, true).loose.map(entry => entry.id)).toEqual([
      'busy-parent',
      'newer',
      'older',
    ]);
    expect(groupSessions(sessions, 'chat').loose.map(entry => entry.id)).toEqual([
      'newer',
      'busy-parent',
      'busy-kid',
      'older',
    ]);
  });

  it('hints "from" on an orphan whose parent exists, and on a pinned child; none when the parent is deleted', () => {
    const sessions = [
      session({ id: 'gone', title: 'Archived parent', archived: true }),
      spawned('orphan', 'gone'),
      spawned('missing-parent', 'deleted'),
      session({ id: 'root', title: 'Root' }),
      spawned('pinned-kid', 'root', { pinned: true }),
    ];
    const grouped = groupSessions(sessions, 'chat', undefined, false, true);
    const hints = parentHints(sessions, grouped.children);
    expect(hints.get('orphan')).toBe('Archived parent');
    expect(hints.get('pinned-kid')).toBe('Root');
    expect(hints.has('missing-parent')).toBe(false);
  });

  it('sorts pinned roots by group activity too', () => {
    const sessions = [
      session({ id: 'p-new', pinned: true, updatedAt: '2026-09-05T00:00:00.000Z' }),
      session({ id: 'p-old', pinned: true, updatedAt: '2026-09-01T00:00:00.000Z' }),
      spawned('p-old-kid', 'p-old', { updatedAt: '2026-09-09T00:00:00.000Z' }),
    ];
    const grouped = groupSessions(sessions, 'chat', undefined, false, true);
    expect(grouped.pinned.map(entry => entry.id)).toEqual(['p-old', 'p-new']);
  });

  it('nests a grandchild under a filed child, and survives a chain that runs into a cycle', () => {
    const state = { sections: [{ id: 's1', name: 'Mine' }], assignments: { kid: 's1' } };
    const filed = groupSessions(
      [session({ id: 'root' }), spawned('kid', 'root'), spawned('grandkid', 'kid')],
      'chat',
      state,
      false,
      true
    );
    expect(filed.custom[0].sessions.map(entry => entry.id)).toEqual(['kid']);
    expect(filed.children.get('kid')?.map(entry => entry.id)).toEqual(['grandkid']);

    const cyclic = groupSessions(
      [spawned('a', 'b'), spawned('b', 'a'), spawned('c', 'a')],
      'chat',
      undefined,
      false,
      true
    );
    expect(cyclic.loose.map(entry => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('lists a flattened grandchild in quick-switch order only while its group is open', () => {
    const grouped = groupSessions(
      [session({ id: 'root' }), spawned('kid', 'root'), spawned('grandkid', 'kid')],
      'chat',
      undefined,
      false,
      true
    );
    expect(orderedSessions(grouped, { isOpen: () => true }).map(entry => entry.id)).toEqual([
      'root',
      'kid',
      'grandkid',
    ]);
  });

  it('gives no hint to a session that names itself as its parent', () => {
    const all = [spawned('loop', 'loop')];
    expect(parentHints(all, new Map()).size).toBe(0);
  });

  it('hints "from" on every spawned session in a flat list, including when the parent is not a match', () => {
    const all = [session({ id: 'root', title: 'Root' }), spawned('kid', 'root')];
    const matching = [all[1]];
    const grouped = groupSessions(matching, 'chat', undefined, false, false);
    expect(grouped.loose.map(entry => entry.id)).toEqual(['kid']);
    expect(parentHints(all, grouped.children).get('kid')).toBe('Root');
  });

  it('stays flat when nesting is off', () => {
    const grouped = groupSessions([session({ id: 'root' }), spawned('kid', 'root')], 'chat');
    expect(grouped.loose.map(entry => entry.id)).toEqual(['root', 'kid']);
    expect(grouped.children.size).toBe(0);
  });

  it('gives a child its own row when the parent is not drawn, or the user placed it', () => {
    const sessions = [
      session({ id: 'gone', archived: true }),
      spawned('orphan', 'gone'),
      spawned('missing-parent', 'deleted'),
      session({ id: 'root' }),
      spawned('pinned-kid', 'root', { pinned: true }),
      spawned('filed-kid', 'root'),
    ];
    const state = { sections: [{ id: 's1', name: 'Mine' }], assignments: { 'filed-kid': 's1' } };
    const grouped = groupSessions(sessions, 'chat', state, false, true);
    expect(grouped.loose.map(entry => entry.id)).toEqual(['orphan', 'missing-parent', 'root']);
    expect(grouped.pinned.map(entry => entry.id)).toEqual(['pinned-kid']);
    expect(grouped.custom[0].sessions.map(entry => entry.id)).toEqual(['filed-kid']);
    expect(grouped.children.size).toBe(0);
  });

  it('survives a corrupt cycle by drawing its members flat', () => {
    const grouped = groupSessions([spawned('a', 'b'), spawned('b', 'a')], 'chat', undefined, false, true);
    expect(grouped.loose.map(entry => entry.id)).toEqual(['a', 'b']);
  });

  it('counts open children in the quick-switch order and skips folded ones', () => {
    const grouped = groupSessions(
      [session({ id: 'root' }), spawned('kid', 'root'), session({ id: 'next' })],
      'chat',
      undefined,
      false,
      true
    );
    expect(orderedSessions(grouped).map(entry => entry.id)).toEqual(['root', 'next']);
    expect(orderedSessions(grouped, { isOpen: () => true }).map(entry => entry.id)).toEqual(['root', 'kid', 'next']);
  });
});

describe('needs-attention order', () => {
  const repo = project('/r/one', 'one');
  const sessions = [
    session({ id: 'quiet', mode: 'code', project: repo }),
    session({ id: 'merged', mode: 'code', project: repo }),
    session({ id: 'ready', mode: 'code', project: repo }),
    session({ id: 'failing', mode: 'code', project: repo }),
    session({ id: 'draft', mode: 'code', project: repo }),
    session({ id: 'conflict', mode: 'code', project: repo }),
    session({ id: 'also-failing', mode: 'code', project: repo }),
    session({ id: 'chat-a', mode: 'chat' }),
  ];
  const prs = new Map<string, PrSummary>([
    ['merged', { number: 1, state: 'merged' }],
    ['ready', { number: 2, state: 'open', attention: 'ready' }],
    ['failing', { number: 3, state: 'open', attention: 'ciFailed' }],
    ['draft', { number: 4, state: 'draft' }],
    ['conflict', { number: 5, state: 'open', attention: 'conflict' }],
    ['also-failing', { number: 6, state: 'open', attention: 'ciFailed' }],
  ]);
  const rank = (entry: ChatSessionSummary) => prAttentionRank(prs.get(entry.id));
  const ids = (sections: ReturnType<typeof groupSessions>) => sections.projects[0]?.sessions.map(entry => entry.id);

  it('puts the worst PR first within a group, ties keeping activity order, no PR and finished last', () => {
    expect(ids(groupSessions(sessions, 'code', undefined, false, false, rank))).toEqual([
      'conflict',
      'failing',
      'also-failing',
      'ready',
      'draft',
      'quiet',
      'merged',
    ]);
  });

  it('leaves the order exactly as before when off', () => {
    expect(ids(groupSessions(sessions, 'code'))).toEqual(
      sessions.filter(entry => entry.mode === 'code').map(entry => entry.id)
    );
  });
});

const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `s${index}`, title: `S${index}` }) as ChatSessionSummary);
const none = () => false;

describe('capRows', () => {
  it('draws a group of exactly the cap whole', () => {
    const capped = capRows(rows(GROUP_ROW_CAP), GROUP_ROW_CAP, none);
    expect(capped.visible).toHaveLength(GROUP_ROW_CAP);
    expect(capped.hidden).toBe(0);
  });

  it('hides the one row past the cap', () => {
    const capped = capRows(rows(21), GROUP_ROW_CAP, none);
    expect(capped.visible.map(row => row.id)).toEqual(rows(20).map(row => row.id));
    expect(capped.hidden).toBe(1);
    expect(capped.nextLimit).toBe(21);
  });

  it('steps a long group ten at a time', () => {
    const sessions = rows(500);
    const capped = capRows(sessions, GROUP_ROW_CAP, none);
    expect(capped.visible).toHaveLength(20);
    expect(capped.hidden).toBe(480);
    expect(capped.nextLimit).toBe(20 + GROUP_ROW_STEP);
  });

  it('draws a kept row past the limit in its own place, counted as visible', () => {
    const sessions = rows(500);
    const capped = capRows(sessions, GROUP_ROW_CAP, session => session.id === 's300' || session.id === 's25');
    expect(capped.visible).toHaveLength(22);
    expect(capped.visible.slice(-2).map(row => row.id)).toEqual(['s25', 's300']);
    expect(capped.hidden).toBe(478);
    // The kept s25 sits inside the next ten, so reaching ten newly drawn rows goes one further.
    expect(capped.nextLimit).toBe(31);
  });

  it('hides nothing when every row past the limit is kept', () => {
    const capped = capRows(rows(30), GROUP_ROW_CAP, () => true);
    expect(capped.visible).toHaveLength(30);
    expect(capped.hidden).toBe(0);
  });
});

describe('group limits', () => {
  afterEach(() => setGroupLimit('project:/a', GROUP_ROW_CAP));

  it('start at the cap, and going back to it forgets the group', () => {
    expect(groupLimit('project:/a')).toBe(GROUP_ROW_CAP);
    setGroupLimit('project:/a', 40);
    expect(groupLimit('project:/a')).toBe(40);
    expect(groupLimit('project:/b')).toBe(GROUP_ROW_CAP);
    setGroupLimit('project:/a', GROUP_ROW_CAP);
    expect(groupLimit('project:/a')).toBe(GROUP_ROW_CAP);
  });

  it('never hide a row the quick-switch shortcut can reach', () => {
    expect(GROUP_ROW_CAP).toBeGreaterThanOrEqual(QUICK_SWITCH_LIMIT);
  });
});

describe('nestedSessionsOf', () => {
  const origin = (parentSessionId: string) => ({ parentSessionId, depth: 1, seedPrompt: '' });
  it('collects live descendants at any depth, skipping archived subtrees and unrelated sessions', () => {
    const sessions = [
      session({ id: 'parent' }),
      session({ id: 'child', origin: origin('parent') }),
      session({ id: 'grandchild', origin: origin('child') }),
      session({ id: 'archived', origin: origin('parent'), archived: true }),
      session({ id: 'under-archived', origin: origin('archived') }),
      session({ id: 'other', origin: origin('elsewhere') }),
    ];
    expect(nestedSessionsOf(sessions, 'parent').map(found => found.id)).toEqual(['child', 'grandchild']);
  });
  it('terminates on a corrupt origin cycle', () => {
    const sessions = [session({ id: 'a', origin: origin('b') }), session({ id: 'b', origin: origin('a') })];
    expect(nestedSessionsOf(sessions, 'a').map(found => found.id)).toEqual(['b']);
  });
});

describe('projectKeyOf', () => {
  const repo = project('/work/repo', 'repo');

  it('keys a local project by its bare directory, as saved prefs were, and a remote one by host too', () => {
    expect(projectKeyOf(LOCAL_HOST_ID, repo)).toBe('/work/repo');
    expect(projectKeyOf('devbox', repo)).toBe('devbox\n/work/repo');
    expect(projectKeyOf('devbox', repo)).not.toBe(projectKeyOf('nas', repo));
  });
});
