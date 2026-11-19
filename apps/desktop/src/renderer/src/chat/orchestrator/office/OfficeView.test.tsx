// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentFixture, createThemedMount, el } from '../testUtils';
import { OfficeView } from './OfficeView';

const mount = createThemedMount();
afterEach(() => mount.unmount());

describe('OfficeView', () => {
  it('keeps Morgan visible with an empty roster and opens the parent session', async () => {
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
    expect(el('office-room-break-room').contains(el('office-agent-done'))).toBe(true);
    expect(el('office-room-conference-room').contains(el('office-agent-idle'))).toBe(true);
    expect(el('office-room-manager-door').contains(el('office-agent-waiting'))).toBe(true);
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
    expect(el('office-room-desks').contains(el('office-agent-done'))).toBe(true);
    expect(el('office-agent-done').getAttribute('aria-label')).toBe(`${character}: Agent done, working`);
    expect(el('office-agent-done').textContent).toBe(character.split(' ')[0]);
    expect(el('office-agent-done').getAttribute('aria-pressed')).toBe('true');
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
