import { describe, expect, it } from 'vitest';
import type { ChatProject, ChatSessionSummary } from '@shared/chat';
import { groupSessions, orderedSessions } from './grouping';

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
