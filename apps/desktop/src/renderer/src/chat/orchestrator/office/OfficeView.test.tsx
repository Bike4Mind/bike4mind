// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentFixture, createThemedMount, el, typeInto } from '../testUtils';
import { OfficeView } from './OfficeView';

const mount = createThemedMount();
afterEach(() => mount.unmount());

describe('OfficeView', () => {
  it('keeps Michael visible with an empty roster and opens the parent session', async () => {
    const focus = vi.fn();
    await mount.render(<OfficeView agents={[]} personas={new Map()} selectedId={null} onSelect={vi.fn()} introPlaying={false} onInnkeeperSelect={focus} />);
    await act(async () => el('office-parent').click());
    expect(focus).toHaveBeenCalledOnce();
    expect(el('office-room-break-room').textContent).toContain('Completed agents');
  });

  it('routes completed agents to the break room, preserves selection and returns resumed agents to desks', async () => {
    const select = vi.fn();
    const props = { personas: new Map(), selectedId: 'done', onSelect: select, introPlaying: false };
    await mount.render(<OfficeView {...props} agents={[agentFixture('done', 'done'), agentFixture('idle', 'idle'), agentFixture('waiting', 'needs-you')]} />);
    expect(el('office-room-break-room').contains(el('office-agent-done'))).toBe(true);
    expect(el('office-room-conference-room').contains(el('office-agent-idle'))).toBe(true);
    expect(el('office-room-michael-door').contains(el('office-agent-waiting'))).toBe(true);
    expect(el('office-agent-done').getAttribute('aria-pressed')).toBe('true');
    const character = el('office-agent-done').textContent;
    await act(async () => el('office-agent-done').click());
    expect(select).toHaveBeenCalledWith('done');
    await mount.render(<OfficeView {...props} agents={[agentFixture('done', 'working'), agentFixture('idle', 'idle'), agentFixture('waiting', 'needs-you')]} />);
    expect(el('office-room-desks').contains(el('office-agent-done'))).toBe(true);
    expect(el('office-agent-done').textContent).toBe(character);
  });

  it('sends a trimmed memo through the existing parent desk', async () => {
    const send = vi.fn();
    await mount.render(<OfficeView agents={[]} personas={new Map()} selectedId={null} onSelect={vi.fn()} introPlaying={false} desk={{ send, onReadReply: vi.fn(), onOpenConversation: vi.fn(), conversationHidden: true }} />);
    await act(async () => el('office-write-memo').click());
    const input = el('office-message-form').querySelector('textarea');
    expect(input).not.toBeNull();
    await typeInto(input!, '  Status report please  ');
    await act(async () => el('office-message-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(send).toHaveBeenCalledWith('Status report please');
  });
});
