// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMac } from '../platform';
import { OrchestrateToggle, isSurfaceToggleKey } from './OrchestrateToggle';
import type { SessionSurface } from './orchestratorPrefs';
import { describeAgentStates, type AgentState } from './roster';
import { createThemedMount, el, query } from './testUtils';

const onSurfaceChange = vi.fn();
const themed = createThemedMount();

const renderToggle = (states: AgentState[], surface: SessionSurface = 'chat') =>
  themed.render(<OrchestrateToggle states={states} surface={surface} onSurfaceChange={onSurfaceChange} />);

afterEach(() => {
  themed.unmount();
  vi.clearAllMocks();
});

describe('OrchestrateToggle', () => {
  it('renders nothing while the session has no agents', async () => {
    await renderToggle([]);
    expect(query('chat-surface-toggle')).toBeNull();
  });

  it('reads as navigation: a labelled Agents segment and an icon-only conversation one', async () => {
    await renderToggle(['working']);
    expect(el('chat-surface-toggle-chat').getAttribute('aria-label')).toBe('Show conversation');
    expect(el('chat-surface-toggle-chat').textContent).toBe('');
    expect(el('chat-surface-toggle-orchestrate').getAttribute('aria-label')).toBe('Show agents, 1 agent: 1 working');
    expect(el('chat-orchestrate-label').textContent).toBe('Agents');
    expect(el('chat-surface-toggle').textContent).not.toMatch(/orchestrate/i);
    expect(el('chat-surface-toggle').getAttribute('aria-label')).not.toMatch(/orchestrate/i);
    act(() => el('chat-surface-toggle-orchestrate').click());
    expect(onSurfaceChange).toHaveBeenCalledWith('orchestrate');
  });

  it('switches back to the conversation, and ignores a click on the shown view', async () => {
    await renderToggle(['done'], 'orchestrate');
    act(() => el('chat-surface-toggle-orchestrate').click());
    expect(onSurfaceChange).not.toHaveBeenCalled();
    act(() => el('chat-surface-toggle-chat').click());
    expect(onSurfaceChange).toHaveBeenCalledWith('chat');
  });

  it('badges the agent count on the Agents segment, neutral when nothing needs attention', async () => {
    await renderToggle(['done', 'idle', 'stopped']);
    expect(el('chat-orchestrate-count').textContent).toBe('3');
    expect(el('chat-surface-toggle-orchestrate').textContent).toBe('Agents3');
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

  it('names the agents segment with the agent states, most urgent first, and hides the badge', async () => {
    await renderToggle(['done', 'working', 'needs-you', 'idle']);
    expect(el('chat-surface-toggle-orchestrate').getAttribute('aria-label')).toBe(
      'Show agents, 4 agents: 1 needs you, 1 working, 1 idle, 1 done'
    );
    expect(el('chat-surface-toggle-orchestrate').getAttribute('aria-label')).toContain('1 needs you');
    expect(el('chat-orchestrate-count').getAttribute('aria-hidden')).toBe('true');
    expect(el('chat-orchestrate-count').hasAttribute('aria-label')).toBe(false);
    expect(describeAgentStates(['failed'])).toBe('1 agent: 1 failed');
    expect(describeAgentStates([])).toBe('No agents yet');
    // Idle and stopped are never done; a waiting parent adds to "needs you" without adding an agent.
    expect(describeAgentStates(['idle', 'stopped', 'done'], 1)).toBe(
      '3 agents: 1 needs you, 1 stopped, 1 idle, 1 done'
    );
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

    it('ignores a chord another handler already consumed', async () => {
      await renderToggle(['done'], 'chat');
      press({ cancelable: true });
      expect(onSurfaceChange).toHaveBeenCalledTimes(1);
      const handled = chord({ cancelable: true });
      handled.preventDefault();
      act(() => void window.dispatchEvent(handled));
      expect(onSurfaceChange).toHaveBeenCalledTimes(1);
    });

    it('does nothing while the session has no agents', async () => {
      await renderToggle([], 'chat');
      press();
      expect(onSurfaceChange).not.toHaveBeenCalled();
    });
  });
});
