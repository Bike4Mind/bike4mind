// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assignPersonas } from '@shared/agentPersona';
import type { OrchestratorViewProps } from '../OrchestratorStage';
import type { AgentView } from '../roster';
import { sceneView } from '../scene/SceneStage';
import { agentFixture, createThemedMount, el, query } from '../testUtils';
import { MANAGER_ART } from './officeArt';
import { OFFICE_SCENE } from './officeScene';
import { chatBackedHostBridge } from '../../../__fixtures__/chatBackedHostBridge';

const OfficeView = sceneView(OFFICE_SCENE);
const mount = createThemedMount();
const { map } = OFFICE_SCENE;

function render(agents: AgentView[], extra: Partial<OrchestratorViewProps> = {}) {
  return mount.render(
    <OfficeView
      agents={agents}
      personas={assignPersonas(agents)}
      selectedId={null}
      onSelect={vi.fn()}
      introPlaying={false}
      {...extra}
    />
  );
}

beforeEach(() => {
  (window as unknown as { b4m: unknown }).b4m = {
    host: chatBackedHostBridge(),
    chat: {
      getSession: vi.fn().mockResolvedValue(null),
      getHeldRelays: vi.fn().mockResolvedValue([]),
      onStreamEvent: vi.fn(() => () => undefined),
      onQueueChanged: vi.fn(() => () => undefined),
    },
  };
});

afterEach(() => {
  mount.unmount();
  vi.restoreAllMocks();
});

describe('the Office on the scene framework', () => {
  it('keeps the Manager in the office with an empty roster and opens the parent session', async () => {
    const onInnkeeperSelect = vi.fn();
    await render([], { onInnkeeperSelect, desk: { onReadReply: vi.fn(), conversationHidden: true } });
    expect(el('orchestrator-office').getAttribute('aria-label')).toBe('Office');
    const host = el('orchestrator-office-host');
    expect(host.getAttribute('aria-label')).toBe('Manager: At the desk');
    expect(host.style.left).toBe(`${map.host.x}%`);
    expect(el('orchestrator-office-host-art').getAttribute('src')).toBe(MANAGER_ART.idle);
    expect(el('orchestrator-office-host-greeting').textContent).toBe('What are we working on?');
    await act(async () => host.click());
    expect(onInnkeeperSelect).toHaveBeenCalledOnce();
  });

  it('seats agents by room: setting up in reception, working at a desk, done in the break room', async () => {
    await render([
      agentFixture('setup', 'working', { preparing: 'worktree' }),
      agentFixture('busy', 'working'),
      agentFixture('done', 'done'),
    ]);
    const at = (id: string) => {
      const sprite = el(`orchestrator-office-agent-${id}`);
      return { x: sprite.style.left, y: sprite.style.top };
    };
    const point = (zone: string) => ({ x: `${map.zones[zone].slots[0].x}%`, y: `${map.zones[zone].slots[0].y}%` });
    expect(at('setup')).toEqual(point('reception'));
    expect(at('busy')).toEqual(point('desks'));
    expect(at('done')).toEqual(point('break'));
    const rest = el('orchestrator-office-agent-done').querySelector('img')?.getAttribute('src');
    expect(OFFICE_SCENE.cast.sheets.map(sheet => sheet.sprites.rest)).toContain(rest);
  });

  it('queues a waiting agent outside the door, answerable from its bubble or the dialogue box', async () => {
    await render([agentFixture('ask', 'needs-you')]);
    expect(el('orchestrator-office-agent-ask').style.left).toBe(`${map.zones['manager-door'].slots[0].x}%`);
    expect(query('orchestrator-office-bubble-ask-open')).not.toBeNull();
    await render([agentFixture('ask', 'needs-you')], { inSceneDecisions: true });
    expect(query('orchestrator-office-bubble-ask-open')).toBeNull();
    expect(el('orchestrator-office-bubble-ask').textContent).toBe('Needs you!');
  });

  it('pins tasks on the bulletin board', async () => {
    await render([agentFixture('a', 'working')]);
    expect(el('orchestrator-office-quest-board').getAttribute('aria-label')).toBe('Bulletin board: 1 open task');
  });

  it("hangs the Manager's reply to the right, while the conversation is hidden", async () => {
    await render([agentFixture('a')], {
      desk: { onReadReply: vi.fn(), conversationHidden: true, reply: { id: 'm1', snippet: 'All done.' } },
    });
    const bubble = el('orchestrator-office-reply-bubble');
    expect(el('orchestrator-office-reply-text').textContent).toBe('All done.');
    expect(getComputedStyle(bubble).left).toBe('15%');
    expect(getComputedStyle(bubble).right).not.toBe('15%');
  });

  it('cheers through the finale', async () => {
    await render([agentFixture('a', 'done')], { celebrating: true });
    expect(el('orchestrator-office-host').dataset.pose).toBe('cheering');
    expect(el('orchestrator-office-agent-a').dataset.cheering).toBe('true');
  });
});
