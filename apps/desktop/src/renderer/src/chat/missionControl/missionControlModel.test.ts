import { describe, expect, it } from 'vitest';
import type { ChatProject, ChatSessionStatus } from '@shared/chat';
import { sessionFixture } from '../orchestrator/sessionFixture';
import { buildTiles, filterTiles, missionControlTiles, presentTiles, sortTiles } from './missionControlModel';

const project = (name: string) =>
  ({ name, directory: `/repos/${name}`, workingDirectory: `/repos/${name}` }) as ChatProject;

const at = (minute: number) => `2026-11-24T10:${String(minute).padStart(2, '0')}:00.000Z`;

const SESSIONS = [
  sessionFixture('calm', undefined, { title: 'Calm run', updatedAt: at(5), project: project('alpha') }),
  sessionFixture('calm-a', 'calm', { updatedAt: at(40), lastOutcome: 'finished' }),
  sessionFixture('busy', undefined, { title: 'Busy run', updatedAt: at(1) }),
  sessionFixture('busy-a', 'busy', { updatedAt: at(2) }),
  sessionFixture('busy-b', 'busy-a', { updatedAt: at(3) }),
  sessionFixture('asks', undefined, { title: 'Asking run', updatedAt: at(0) }),
  sessionFixture('asks-a', 'asks', { updatedAt: at(0), lastOutcome: 'failed' }),
  sessionFixture('flagged', undefined, { title: 'Flagged only', orchestrate: true, updatedAt: at(20) }),
  sessionFixture('plain', undefined, { title: 'Plain chat', updatedAt: at(59) }),
  sessionFixture('gone', undefined, { title: 'Archived run', archived: true }),
  sessionFixture('gone-a', 'gone'),
];

const STATUSES = new Map<string, ChatSessionStatus>([
  ['busy-a', 'processing'],
  ['busy-b', 'processing'],
  ['asks', 'needs-action'],
]);

const byId = (id: string) => buildTiles(SESSIONS, STATUSES).find(tile => tile.id === id);

describe('buildTiles', () => {
  it('makes one tile per live top-level orchestration, with no cap', () => {
    expect(
      buildTiles(SESSIONS, STATUSES)
        .map(tile => tile.id)
        .sort()
    ).toEqual(['asks', 'busy', 'calm', 'flagged']);
  });

  it('counts the whole agent tree by state', () => {
    expect(byId('busy')?.counts).toEqual({ working: 2, needsYou: 0, done: 0, failed: 0, total: 2 });
    expect(byId('calm')?.counts).toEqual({ working: 0, needsYou: 0, done: 1, failed: 0, total: 1 });
    expect(byId('asks')?.counts).toMatchObject({ failed: 1, needsYou: 1, total: 1 });
  });

  it('flags needs-you from the orchestrating session or any agent', () => {
    expect(byId('asks')?.needsYou).toBe(true);
    expect(byId('busy')?.needsYou).toBe(false);
    const agentAsks = buildTiles(SESSIONS, new Map([['busy-b', 'needs-action' as const]]));
    expect(agentAsks.find(tile => tile.id === 'busy')?.needsYou).toBe(true);
  });

  it('takes the project name and the latest activity across the tree', () => {
    expect(byId('calm')).toMatchObject({ project: 'alpha', lastActivity: at(40) });
    expect(byId('busy')?.project).toBeUndefined();
    expect(byId('busy')?.lastActivity).toBe(at(3));
  });
});

describe('sortTiles', () => {
  it('puts needs-you first, then working, then the most recent', () => {
    expect(sortTiles(buildTiles(SESSIONS, STATUSES)).map(tile => tile.id)).toEqual(['asks', 'busy', 'calm', 'flagged']);
  });
});

describe('presentTiles', () => {
  it('numbers titles in shown order and drops projects', () => {
    const shown = presentTiles(sortTiles(buildTiles(SESSIONS, STATUSES)), true);
    expect(shown.map(tile => tile.title)).toEqual(['Session 1', 'Session 2', 'Session 3', 'Session 4']);
    expect(shown.every(tile => tile.project === undefined)).toBe(true);
  });

  it('keeps tiles as they are when not presenting', () => {
    expect(presentTiles(buildTiles(SESSIONS, STATUSES), false).map(tile => tile.title)).toContain('Calm run');
  });
});

describe('filterTiles', () => {
  it('narrows by title, ignoring case and surrounding space', () => {
    const tiles = buildTiles(SESSIONS, STATUSES);
    expect(filterTiles(tiles, '  RUN ').map(tile => tile.id)).toEqual(['calm', 'busy', 'asks']);
    expect(filterTiles(tiles, '')).toHaveLength(4);
  });

  it('matches the shown titles while presenting, never the hidden ones', () => {
    expect(missionControlTiles(SESSIONS, STATUSES, { presenting: true, query: 'Calm' })).toEqual([]);
    expect(
      missionControlTiles(SESSIONS, STATUSES, { presenting: true, query: 'session 2' }).map(tile => tile.id)
    ).toEqual(['busy']);
  });
});
