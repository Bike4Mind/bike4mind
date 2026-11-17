// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assignPersonas } from '@shared/agentPersona';
import type { ViewAction } from '@shared/viewSnapshot';
import type { OrchestratorViewProps } from './OrchestratorStage';
import type { AgentView, ParentView } from './roster';
import { snapshotView, type SnapshotViewProps } from './snapshotView';
import { agentFixture, createThemedMount, el } from './testUtils';
import { ORCHESTRATOR_VIEW_COMPONENTS } from './viewRegistry';

const themed = createThemedMount();
const onSelect = vi.fn();
const onInnkeeperSelect = vi.fn();
let seen: SnapshotViewProps | undefined;

/** Records what the host hands a snapshot view, and asks for whatever a test passes it. */
function Probe(props: SnapshotViewProps) {
  seen = props;
  return <div data-testid="probe" />;
}
const ProbeView = snapshotView(Probe, { displayName: 'ProbeView' });

const hostProps = (agents: AgentView[], parent: ParentView = {}): OrchestratorViewProps => ({
  agents,
  parent,
  rootId: 'root-1',
  onSelect,
  onInnkeeperSelect,
  selectedId: null,
  introPlaying: false,
  personas: assignPersonas(agents),
});

afterEach(() => {
  themed.unmount();
  vi.clearAllMocks();
  seen = undefined;
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

const ask = (action: unknown) => act(() => seen?.onAction(action as ViewAction));

describe('snapshotView', () => {
  it('hands the view the snapshot, display data only', async () => {
    await themed.render(<ProbeView {...hostProps([agentFixture('a', 'working', { seedPrompt: 'secret prompt' })])} />);
    expect(seen?.snapshot.root).toEqual({ id: 'root-1', state: 'idle' });
    expect(seen?.snapshot.agents.map(agent => agent.id)).toEqual(['a']);
    expect(JSON.stringify(seen?.snapshot)).not.toContain('secret prompt');
  });

  it('opens an agent the snapshot lists, and the root, and nothing else', async () => {
    await themed.render(<ProbeView {...hostProps([agentFixture('a')], { status: 'needs-action' })} />);
    expect(seen?.snapshot.root.state).toBe('needs-you');
    ask({ kind: 'open-agent', agentId: 'a' });
    expect(onSelect).toHaveBeenCalledWith('a');
    ask({ kind: 'open-root' });
    expect(onInnkeeperSelect).toHaveBeenCalledTimes(1);
    ask({ kind: 'open-agent', agentId: 'not-listed' });
    ask({ kind: 'answer', agentId: 'a', text: 'yes' });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('pauses every animation under it while the window is hidden', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await themed.render(<ProbeView {...hostProps([agentFixture('a')])} />);
    expect(el('probe').parentElement?.dataset.paused).toBe('hidden');
  });

  it.each(['tile-wall', 'aquarium'] as const)('registers %s as a snapshot view that opens agents', async view => {
    const View = ORCHESTRATOR_VIEW_COMPONENTS[view];
    await themed.render(<View {...hostProps([agentFixture('a', 'needs-you')])} />);
    const target = view === 'tile-wall' ? el('orchestrator-tile-a') : el('orchestrator-fish-a');
    act(() => target.click());
    expect(onSelect).toHaveBeenCalledWith('a');
  });
});
