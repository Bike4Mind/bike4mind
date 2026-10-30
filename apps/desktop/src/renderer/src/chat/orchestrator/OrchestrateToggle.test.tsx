// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrchestrateToggle } from './OrchestrateToggle';
import type { SessionSurface } from './orchestratorPrefs';
import type { AgentState } from './roster';
import { createThemedMount, el, query } from './testUtils';

const onSurfaceChange = vi.fn();
const onStart = vi.fn();
const themed = createThemedMount();

const renderToggle = (states: AgentState[], surface: SessionSurface = 'chat', canStart = false) =>
  themed.render(
    <OrchestrateToggle
      states={states}
      surface={surface}
      onSurfaceChange={onSurfaceChange}
      canStart={canStart}
      onStart={onStart}
    />
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

  it('shows the segmented control on the chat surface of an agentless code session, and starting turns Orchestrate on', async () => {
    await renderToggle([], 'chat', true);
    expect(el('chat-surface-toggle-chat')).not.toBeNull();
    expect(el('chat-surface-toggle-orchestrate').textContent).toBe('Orchestrate');
    expect(query('chat-orchestrate-count')).toBeNull();
    act(() => el('chat-surface-toggle-orchestrate').click());
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onSurfaceChange).not.toHaveBeenCalled();
  });

  it('keeps the same control once orchestrating an agentless code session, and Chat switches back', async () => {
    await renderToggle([], 'orchestrate', true);
    act(() => el('chat-surface-toggle-orchestrate').click());
    expect(onStart).not.toHaveBeenCalled();
    act(() => el('chat-surface-toggle-chat').click());
    expect(onSurfaceChange).toHaveBeenCalledWith('chat');
  });

  it('switches the surface from the Orchestrate segment once agents exist, even on a code session', async () => {
    await renderToggle(['working'], 'chat', true);
    act(() => el('chat-surface-toggle-orchestrate').click());
    expect(onSurfaceChange).toHaveBeenCalledWith('orchestrate');
    expect(onStart).not.toHaveBeenCalled();
  });

  it('badges the agent count on the Orchestrate segment', async () => {
    await renderToggle(['done', 'failed', 'idle']);
    expect(el('chat-orchestrate-count').textContent).toBe('3');
    expect(el('chat-surface-toggle-orchestrate').textContent).toBe('Orchestrate3');
    expect(query('chat-orchestrate-working')).toBeNull();
    expect(query('chat-orchestrate-needs-you')).toBeNull();
  });

  it('shows the working indicator while any agent is working', async () => {
    await renderToggle(['working', 'done']);
    expect(query('chat-orchestrate-working')).not.toBeNull();
    expect(query('chat-orchestrate-needs-you')).toBeNull();
  });

  it('flags an agent that needs you, taking over from the working indicator', async () => {
    await renderToggle(['working', 'needs-you']);
    expect(query('chat-orchestrate-needs-you')).not.toBeNull();
    expect(query('chat-orchestrate-working')).toBeNull();
  });

  it('keeps the same control, with the count, on the orchestrate surface', async () => {
    await renderToggle(['working'], 'orchestrate');
    expect(el('chat-orchestrate-count').textContent).toBe('1');
    act(() => el('chat-surface-toggle-chat').click());
    expect(onSurfaceChange).toHaveBeenCalledWith('chat');
  });
});
