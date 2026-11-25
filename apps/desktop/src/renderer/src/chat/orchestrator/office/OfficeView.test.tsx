// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { agentFixture, createThemedMount, el, query } from '../testUtils';
import { OfficeView } from './OfficeView';
import type { AgentState } from '../roster';
import { OFFICE_CAST, OFFICE_PARENT, assignOfficeCast } from './officeCast';
import { OFFICE_ROOMS } from './officeLayout';
import { groupOfficeAgents, officeRoomFor } from './scene';

const mount = createThemedMount();
afterEach(() => mount.unmount());

describe('OfficeView', () => {
  it('keeps Manager visible with an empty roster and opens the parent session', async () => {
    const focus = vi.fn();
    await mount.render(
      <OfficeView
        agents={[]}
        personas={new Map()}
        selectedId={null}
        onSelect={vi.fn()}
        introPlaying={false}
        onInnkeeperSelect={focus}
      />
    );
    expect(el('office-parent').textContent).toContain('Manager');
    await act(async () => el('office-parent').click());
    expect(focus).toHaveBeenCalledOnce();
    expect(el('office-room-break-room').getAttribute('aria-label')).toBe('Break room');
  });

  it('routes completed agents to the break room, preserves selection and returns resumed agents to desks', async () => {
    const select = vi.fn();
    const props = { personas: new Map(), selectedId: 'done', onSelect: select, introPlaying: false };
    await mount.render(
      <OfficeView
        {...props}
        agents={[agentFixture('done', 'done'), agentFixture('idle', 'idle'), agentFixture('waiting', 'needs-you')]}
      />
    );
    expect(el('office-agent-done').dataset.officeRoom).toBe('break-room');
    expect(el('office-agent-idle').dataset.officeRoom).toBe('conference-room');
    expect(el('office-agent-waiting').dataset.officeRoom).toBe('conference-room');
    expect(el('office-room-conference-room').dataset.occupants).toBe('2');
    expect(el('office-agent-done').getAttribute('aria-pressed')).toBe('true');
    const character = el('office-agent-done').getAttribute('aria-label')!.split(':')[0];
    expect(el('office-agent-done').textContent).toBe(`${character.split(' ')[0]} *`);
    await act(async () => el('office-agent-done').click());
    expect(select).toHaveBeenCalledWith('done');
    await mount.render(
      <OfficeView
        {...props}
        agents={[agentFixture('done', 'working'), agentFixture('idle', 'idle'), agentFixture('waiting', 'needs-you')]}
      />
    );
    expect(el('office-agent-done').dataset.officeRoom).toBe('desks');
    expect(el('office-agent-done').getAttribute('aria-label')).toBe(`${character}: Agent done, working`);
    expect(el('office-agent-done').textContent).toBe(character.split(' ')[0]);
    expect(el('office-agent-done').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the same agent node when it walks to another room, so the move animates', async () => {
    const props = { personas: new Map(), selectedId: null, onSelect: vi.fn(), introPlaying: false };
    await mount.render(<OfficeView {...props} agents={[agentFixture('a', 'working')]} />);
    const before = el('office-agent-a');
    await mount.render(<OfficeView {...props} agents={[agentFixture('a', 'needs-you')]} />);
    expect(el('office-agent-a')).toBe(before);
    expect(before.dataset.officeRoom).toBe('conference-room');
  });

  it('marks Manager with an exclamation mark only while the parent needs action', async () => {
    const props = { agents: [], personas: new Map(), selectedId: null, onSelect: vi.fn(), introPlaying: false };
    await mount.render(<OfficeView {...props} parent={{ status: 'processing' } as never} />);
    expect(query('office-parent-alert')).toBeNull();
    await mount.render(<OfficeView {...props} parent={{ status: 'needs-action' } as never} />);
    expect(el('office-parent-alert').textContent).toBe('!');
    expect(el('office-parent').getAttribute('aria-label')).toBe('Manager, parent session, needs you');
  });

  it('opens the parent reply in the shared conversation window', async () => {
    const read = vi.fn();
    await mount.render(
      <OfficeView
        agents={[]}
        personas={new Map()}
        selectedId={null}
        onSelect={vi.fn()}
        introPlaying={false}
        desk={{
          reply: { id: 'reply-1', snippet: 'Ready for the next task.' },
          onReadReply: read,
          conversationHidden: true,
        }}
      />
    );
    await act(async () => el('office-parent-reply').click());
    expect(read).toHaveBeenCalledWith('reply-1');
  });
});

describe('office scene', () => {
  const subject = (id: string, createdAt = '2026-10-01T00:00:00.000Z') => ({ id, createdAt });

  describe('Office scene', () => {
    it.each<[AgentState, string]>([
      ['working', 'desks'],
      ['needs-you', 'conference-room'],
      ['done', 'break-room'],
      ['failed', 'conference-room'],
      ['stopped', 'conference-room'],
      ['idle', 'conference-room'],
    ])('routes %s agents to %s', (state, room) => {
      expect(officeRoomFor({ state })).toBe(room);
    });

    it('seats agents waiting on the user at the front of the meeting room', () => {
      const rooms = groupOfficeAgents([
        agentFixture('idle', 'idle'),
        agentFixture('broke', 'failed'),
        agentFixture('asking', 'needs-you'),
      ]);
      expect(rooms.get('conference-room')?.map(agent => agent.id)).toEqual(['asking', 'idle', 'broke']);
    });

    it('provides every room for an empty scene', () => {
      expect([...groupOfficeAgents([])]).toEqual(OFFICE_ROOMS.map(room => [room.id, []]));
    });

    it('assigns the full cast before repeating and reserves Manager for the parent', () => {
      const agents = Array.from({ length: OFFICE_CAST.length + 1 }, (_, index) =>
        subject(String(index).padStart(2, '0'))
      );
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
});
