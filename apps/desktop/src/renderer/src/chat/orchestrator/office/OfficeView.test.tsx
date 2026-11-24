// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentFixture, createThemedMount, el, query } from '../testUtils';
import { OfficeView } from './OfficeView';

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
