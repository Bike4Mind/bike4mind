// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMac } from '../platform';
import { OrchestrateToggle, describeAgentStates, isSurfaceToggleKey } from './OrchestrateToggle';
import type { SessionSurface } from './orchestratorPrefs';
import type { AgentState } from './roster';
import { createThemedMount, el, query } from './testUtils';

const onSurfaceChange = vi.fn();
const themed = createThemedMount();

const renderToggle = (states: AgentState[], surface: SessionSurface = 'chat', canStart = false) =>
  themed.render(
    <OrchestrateToggle states={states} surface={surface} onSurfaceChange={onSurfaceChange} canStart={canStart} />
  );

afterEach(() => {
  themed.unmount();
  vi.clearAllMocks();
});

describe('OrchestrateToggle', () => {
  it('renders nothing when the session has no agents and cannot start', async () => {
    await renderToggle([]);
    expect(query('chat-surface-toggle-orchestrate')).toBeNull();
    expect(query('chat-surface-toggle-chat')).toBeNull();
  });

  it('opens the agents view of an agentless code session, icon-only with named buttons', async () => {
    await renderToggle([], 'chat', true);
    expect(el('chat-surface-toggle-chat').getAttribute('aria-label')).toBe('Conversation');
    expect(el('chat-surface-toggle-orchestrate').getAttribute('aria-label')).toBe('Agents');
    expect(el('chat-surface-toggle-orchestrate').textContent).toBe('');
    expect(query('chat-orchestrate-count')).toBeNull();
    act(() => el('chat-surface-toggle-orchestrate').click());
    expect(onSurfaceChange).toHaveBeenCalledWith('orchestrate');
  });

  it('switches back to the conversation, and ignores a click on the shown view', async () => {
    await renderToggle([], 'orchestrate', true);
    act(() => el('chat-surface-toggle-orchestrate').click());
    expect(onSurfaceChange).not.toHaveBeenCalled();
    act(() => el('chat-surface-toggle-chat').click());
    expect(onSurfaceChange).toHaveBeenCalledWith('chat');
  });

  it('badges the agent count on the Agents segment, neutral when nothing needs attention', async () => {
    await renderToggle(['done', 'idle', 'stopped']);
    expect(el('chat-orchestrate-count').textContent).toBe('3');
    expect(el('chat-surface-toggle-orchestrate').textContent).toBe('3');
    expect(el('chat-orchestrate-count').dataset.tone).toBe('neutral');
    expect(query('chat-orchestrate-working')).toBeNull();
  });

  it('shows the working dot while any agent is working', async () => {
    await renderToggle(['working', 'done']);
    expect(query('chat-orchestrate-working')).not.toBeNull();
    expect(el('chat-orchestrate-count').dataset.tone).toBe('neutral');
  });

  it('turns the badge red for a failed agent and orange for one that needs you, which wins', async () => {
    await renderToggle(['working', 'failed']);
    expect(el('chat-orchestrate-count').dataset.tone).toBe('danger');
    expect(query('chat-orchestrate-working')).toBeNull();

    await renderToggle(['failed', 'needs-you']);
    expect(el('chat-orchestrate-count').dataset.tone).toBe('warning');
  });

  it('describes the agents in the badge label, most urgent first', async () => {
    await renderToggle(['done', 'working', 'needs-you', 'idle']);
    expect(el('chat-orchestrate-count').getAttribute('aria-label')).toBe('4 agents: 1 needs you, 1 working, 2 done');
    expect(describeAgentStates(['failed'])).toBe('1 agent: 1 failed');
    expect(describeAgentStates([])).toBe('No agents yet');
  });

  it('marks the shown surface as pressed', async () => {
    await renderToggle(['done'], 'orchestrate');
    expect(el('chat-surface-toggle-orchestrate').getAttribute('aria-pressed')).toBe('true');
    expect(el('chat-surface-toggle-chat').getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps the same control, with the count, on the orchestrate surface', async () => {
    await renderToggle(['working'], 'orchestrate');
    expect(el('chat-orchestrate-count').textContent).toBe('1');
    act(() => el('chat-surface-toggle-chat').click());
    expect(onSurfaceChange).toHaveBeenCalledWith('chat');
  });

  describe('Mod+Shift+O', () => {
    const chord = (extra: Partial<KeyboardEventInit> = {}) =>
      new KeyboardEvent('keydown', { code: 'KeyO', shiftKey: true, metaKey: isMac, ctrlKey: !isMac, ...extra });
    const press = (extra?: Partial<KeyboardEventInit>) => act(() => void window.dispatchEvent(chord(extra)));

    it('matches only the full chord', () => {
      expect(isSurfaceToggleKey(chord())).toBe(true);
      expect(isSurfaceToggleKey(chord({ shiftKey: false }))).toBe(false);
      expect(isSurfaceToggleKey(chord({ altKey: true }))).toBe(false);
      expect(isSurfaceToggleKey(chord({ code: 'KeyP' }))).toBe(false);
    });

    it('flips between the conversation and the agents', async () => {
      await renderToggle(['done'], 'chat');
      press();
      expect(onSurfaceChange).toHaveBeenLastCalledWith('orchestrate');
      await renderToggle(['done'], 'orchestrate');
      press();
      expect(onSurfaceChange).toHaveBeenLastCalledWith('chat');
    });

    it('opens the agents view of an agentless code session, and does nothing where the switch is absent', async () => {
      await renderToggle([], 'chat', true);
      press();
      expect(onSurfaceChange).toHaveBeenCalledTimes(1);

      await renderToggle([], 'chat', false);
      press();
      expect(onSurfaceChange).toHaveBeenCalledTimes(1);
    });
  });
});
