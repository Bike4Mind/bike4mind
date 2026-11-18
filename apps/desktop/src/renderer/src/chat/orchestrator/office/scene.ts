import type { AgentState, AgentView } from '../roster';
import { OFFICE_ROOMS, type OfficeRoom } from './officeLayout';

const ROOM_BY_STATE: Record<AgentState, OfficeRoom> = {
  working: 'desks',
  'needs-you': 'michael-door',
  done: 'break-room',
  failed: 'conference-room',
  stopped: 'conference-room',
  idle: 'conference-room',
};

export function officeRoomFor(agent: Pick<AgentView, 'state' | 'preparing'>): OfficeRoom {
  if (agent.state === 'working' && agent.preparing !== undefined) return 'reception';
  return ROOM_BY_STATE[agent.state];
}

export function groupOfficeAgents(agents: readonly AgentView[]): ReadonlyMap<OfficeRoom, readonly AgentView[]> {
  const rooms = new Map<OfficeRoom, AgentView[]>(OFFICE_ROOMS.map(room => [room.id, []]));
  for (const agent of agents) rooms.get(officeRoomFor(agent))?.push(agent);
  return rooms;
}
