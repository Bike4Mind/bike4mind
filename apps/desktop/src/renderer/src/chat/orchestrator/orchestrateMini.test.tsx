// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatBackedHostBridge } from '../../__fixtures__/chatBackedHostBridge';
import { orchestrateMiniPayloadSchema, type OrchestrateMiniPayload } from '@shared/orchestrateMini';
import { OrchestratorStage } from './OrchestratorStage';
import { toMiniPayload } from './orchestrateMini';
import { singlePaneLayout } from './orchestratorLayout';
import type { AgentView } from './roster';
import { DEFAULT_SKIN_THEME } from './statePalette';
import { agentFixture, createThemedMount, el, query, snapshotFixture, viewAgentFixture } from './testUtils';

vi.mock('./chime', () => ({ playChime: vi.fn() }));

const SECRET_TITLES = ['Rotate the billing webhook secret', 'Migrate customer exports'];
const ROSTER: AgentView[] = [
  agentFixture('a1', 'needs-you', { title: SECRET_TITLES[0] }),
  agentFixture('a2', 'working', { title: SECRET_TITLES[1] }),
];

type Bridge = {
  publish: ReturnType<typeof vi.fn<(payload: OrchestrateMiniPayload | null) => Promise<void>>>;
  toggle: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  isOpen: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  onOpenChanged: ReturnType<typeof vi.fn<(listener: (open: boolean) => void) => () => void>>;
};

let bridge: Bridge;
const themed = createThemedMount();

const chatStub = () => ({
  getSession: vi.fn().mockResolvedValue(null),
  getHeldRelays: vi.fn().mockResolvedValue([]),
  onStreamEvent: vi.fn(() => () => undefined),
  onQueueChanged: vi.fn(() => () => undefined),
  getRunSpend: vi.fn().mockResolvedValue({ status: 'unattributed' }),
});

function installBridge(open: boolean) {
  bridge = {
    publish: vi.fn(async () => undefined),
    toggle: vi.fn(async () => !open),
    isOpen: vi.fn(async () => open),
    onOpenChanged: vi.fn(() => () => undefined),
  };
  (window as unknown as { b4m: unknown }).b4m = {
    host: chatBackedHostBridge(),
    chat: chatStub(),
    orchestrateMini: bridge,
  };
}

const renderStage = (presenting: boolean) =>
  themed.render(
    <OrchestratorStage
      agents={ROSTER}
      rootId="root"
      layout={singlePaneLayout('table')}
      onLayoutChange={vi.fn()}
      actions={{ open: vi.fn(), stop: vi.fn(), archive: vi.fn() }}
      introPlaying={false}
      presenter={{ on: presenting, onToggle: vi.fn() }}
    />
  );

/** The last non-null payload the stage published, validated as main would on receipt. */
function lastPublished(): OrchestrateMiniPayload {
  const payloads = bridge.publish.mock.calls.map(([payload]) => payload).filter(payload => payload !== null);
  const last = payloads.at(-1);
  if (!last) throw new Error('nothing published');
  return orchestrateMiniPayloadSchema.parse(last);
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  themed.unmount();
  vi.clearAllMocks();
});

describe('the stage feeding the Orchestrate mini window', () => {
  it('publishes the redacted snapshot while Presenter mode is on', async () => {
    installBridge(true);
    await renderStage(true);

    const payload = lastPublished();
    expect(payload.presenting).toBe(true);
    expect(payload.snapshot.agents.map(agent => agent.title)).toEqual(['Agent 1', 'Agent 2']);
    expect(payload.snapshot.agents.map(agent => agent.state)).toEqual(['needs-you', 'working']);
    const wire = JSON.stringify(bridge.publish.mock.calls);
    for (const title of SECRET_TITLES) expect(wire).not.toContain(title);
  });

  it('publishes the real titles once Presenter mode is off', async () => {
    installBridge(true);
    await renderStage(false);

    const payload = lastPublished();
    expect(payload.presenting).toBe(false);
    expect(payload.snapshot.agents.map(agent => agent.title)).toEqual(SECRET_TITLES);
  });

  it('switches to the redacted snapshot when Presenter mode turns on mid-run', async () => {
    installBridge(true);
    await renderStage(false);
    await renderStage(true);

    expect(lastPublished().snapshot.agents.map(agent => agent.title)).toEqual(['Agent 1', 'Agent 2']);
  });

  it('publishes nothing while the window is closed, and withdraws its payload when the stage goes', async () => {
    installBridge(false);
    await renderStage(false);
    expect(bridge.publish).not.toHaveBeenCalled();

    themed.unmount();
    expect(bridge.publish).toHaveBeenLastCalledWith(null);
  });

  it('toggles the window from the view menu', async () => {
    installBridge(false);
    await renderStage(false);
    await act(async () => el('orchestrator-view-menu-btn').click());
    const toggle = el('orchestrator-mini-window-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    await act(async () => toggle.click());
    expect(bridge.toggle).toHaveBeenCalledTimes(1);
  });

  it('leaves the menu item out where there is no bridge to toggle with', async () => {
    (window as unknown as { b4m: unknown }).b4m = {
      host: chatBackedHostBridge(),
      chat: chatStub(),
    };
    await renderStage(false);
    await act(async () => el('orchestrator-view-menu-btn').click());
    expect(query('orchestrator-mini-window-toggle')).toBeNull();
  });
});

describe('toMiniPayload', () => {
  it('leaves quick approvals behind, since the mini window never answers', () => {
    const snapshot = {
      ...snapshotFixture([viewAgentFixture('a', 'needs-you')]),
      approvals: [{ id: 'ap', sessionId: 'a', label: 'bash ls' }],
    };
    const payload = toMiniPayload(snapshot, DEFAULT_SKIN_THEME, false);
    expect(payload.snapshot).not.toHaveProperty('approvals');
    expect(orchestrateMiniPayloadSchema.safeParse(payload).success).toBe(true);
  });
});
