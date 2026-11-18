import { describe, expect, it } from 'vitest';
import type { AgentState } from '../roster';
import { OFFICE_CAST, OFFICE_PARENT, assignOfficeCast } from './officeCast';
import { OFFICE_ROOMS } from './officeLayout';
import { groupOfficeAgents, officeRoomFor } from './scene';

const subject = (id: string, createdAt = '2026-10-01T00:00:00.000Z') => ({ id, createdAt });

describe('Office scene', () => {
  it.each<[AgentState, string]>([
    ['working', 'desks'],
    ['needs-you', 'michael-door'],
    ['done', 'break-room'],
    ['failed', 'conference-room'],
    ['stopped', 'conference-room'],
    ['idle', 'conference-room'],
  ])('routes %s agents to %s', (state, room) => {
    expect(officeRoomFor({ state })).toBe(room);
  });

  it('provides every room for an empty scene', () => {
    expect([...groupOfficeAgents([])]).toEqual(OFFICE_ROOMS.map(room => [room.id, []]));
  });

  it('assigns the full cast before repeating and reserves Michael for the parent', () => {
    const agents = Array.from({ length: OFFICE_CAST.length + 1 }, (_, index) => subject(String(index).padStart(2, '0')));
    const cast = [...assignOfficeCast(agents).values()];
    expect(new Set(cast.slice(0, OFFICE_CAST.length)).size).toBe(OFFICE_CAST.length);
    expect(cast[OFFICE_CAST.length]).toBe(cast[0]);
    expect(cast).not.toContain(OFFICE_PARENT);
  });

  it('keeps assignments deterministic across roster reordering without mutating the input', () => {
    const agents = [subject('b'), subject('a'), subject('c', '2026-10-02T00:00:00.000Z')];
    expect([...assignOfficeCast(agents)]).toEqual([...assignOfficeCast([...agents].reverse())]);
    expect(agents.map(agent => agent.id)).toEqual(['b', 'a', 'c']);
  });

  it('returns a resumed agent to the desks instead of the break room', () => {
    expect(officeRoomFor({ state: 'done' })).toBe('break-room');
    expect(officeRoomFor({ state: 'working' })).toBe('desks');
  });
});
