// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrchestrateToggle } from './OrchestrateToggle';
import type { SessionSurface } from './orchestratorPrefs';
import type { AgentView } from './roster';
import { agentFixture, createThemedMount, el, query } from './testUtils';

const onSurfaceChange = vi.fn();
const themed = createThemedMount();

const renderToggle = (agents: AgentView[], surface: SessionSurface = 'chat') =>
  themed.render(<OrchestrateToggle agents={agents} surface={surface} onSurfaceChange={onSurfaceChange} />);

afterEach(() => {
  themed.unmount();
  vi.clearAllMocks();
});

describe('OrchestrateToggle', () => {
  it('renders nothing when the session has no agents', async () => {
    await renderToggle([]);
    expect(query('chat-orchestrate-chip')).toBeNull();
    expect(query('chat-surface-toggle-chat')).toBeNull();
  });

  it('counts agents and says when any is working', async () => {
    await renderToggle([agentFixture('a', 'working'), agentFixture('b', 'done'), agentFixture('c', 'failed')]);
    expect(el('chat-orchestrate-chip').textContent).toBe('3 agents working \u00B7 Orchestrate');
  });

  it('drops "working" when every agent has settled', async () => {
    await renderToggle([agentFixture('a', 'done'), agentFixture('b', 'failed')]);
    expect(el('chat-orchestrate-chip').textContent).toBe('2 agents \u00B7 Orchestrate');
  });

  it('switches to the orchestrate surface when the chip is clicked', async () => {
    await renderToggle([agentFixture('a')]);
    // Joy routes a chip's click through its inner action button.
    act(() => el('chat-orchestrate-chip').querySelector('button')?.click());
    expect(onSurfaceChange).toHaveBeenCalledWith('orchestrate');
  });

  it('offers a Chat / Orchestrate control in the orchestrate surface', async () => {
    await renderToggle([agentFixture('a')], 'orchestrate');
    expect(query('chat-orchestrate-chip')).toBeNull();
    act(() => el('chat-surface-toggle-chat').click());
    expect(onSurfaceChange).toHaveBeenCalledWith('chat');
  });
});
