// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestrateMiniApi } from '@shared/ipc';
import type { OrchestrateMiniPayload } from '@shared/orchestrateMini';
import { createThemedMount, el, query, snapshotFixture, viewAgentFixture } from '../chat/orchestrator/testUtils';
import { OrchestrateMini } from './OrchestrateMini';

const payload = (extra: Partial<OrchestrateMiniPayload> = {}): OrchestrateMiniPayload => ({
  snapshot: snapshotFixture([viewAgentFixture('a', 'needs-you'), viewAgentFixture('b', 'working')], 'needs-you'),
  presenting: false,
  skin: { id: null, states: {}, surfaces: {} },
  ...extra,
});

function fakeApi(initial: unknown) {
  let listener: ((value: unknown) => void) | null = null;
  const api = {
    getSnapshot: vi.fn(async () => initial),
    onSnapshot: vi.fn((next: (value: unknown) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
    focus: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } satisfies OrchestrateMiniApi;
  const push = async (value: unknown) => {
    await act(async () => listener?.(value));
  };
  return { api, push };
}

const themed = createThemedMount();
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="orchestrate-mini-row"]')];

describe('OrchestrateMini', () => {
  afterEach(() => {
    themed.unmount();
    vi.restoreAllMocks();
  });

  it('shows the needs-you count, counting the root, and every agent with its state', async () => {
    const { api } = fakeApi(payload());
    await themed.render(<OrchestrateMini api={api} />);

    expect(el('orchestrate-mini-needs-you-count').dataset.count).toBe('2');
    expect(rows().map(row => [row.dataset.agentId, row.dataset.state])).toEqual([
      ['root', 'needs-you'],
      ['a', 'needs-you'],
      ['b', 'working'],
    ]);
  });

  it('raises the app on a needs-you row and offers nothing to click on the others', async () => {
    const { api } = fakeApi(payload());
    await themed.render(<OrchestrateMini api={api} />);

    const buttons = [...document.querySelectorAll<HTMLElement>('[data-testid="orchestrate-mini-open"]')];
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[1].click());
    expect(api.focus).toHaveBeenCalledWith('a');
    const working = rows().find(row => row.dataset.agentId === 'b');
    expect(working?.querySelector('[data-testid="orchestrate-mini-open"]')).toBeNull();
  });

  it('follows pushes, keeps the last good payload over a malformed one, and empties on null', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { api, push } = fakeApi(payload());
    await themed.render(<OrchestrateMini api={api} />);

    await push(payload({ snapshot: snapshotFixture([viewAgentFixture('c', 'done')]) }));
    expect(el('orchestrate-mini-needs-you-count').dataset.count).toBe('0');
    expect(rows().map(row => row.dataset.agentId)).toEqual(['c']);

    await push({ ...payload(), prompt: 'not part of the contract' });
    expect(rows().map(row => row.dataset.agentId)).toEqual(['c']);

    await push(null);
    expect(query('orchestrate-mini-list')).toBeNull();
    expect(el('orchestrate-mini-empty').textContent).toContain('No orchestration on stage');
  });

  it('says when Presenter mode is on', async () => {
    const { api } = fakeApi(payload({ presenting: true }));
    await themed.render(<OrchestrateMini api={api} />);
    expect(query('orchestrate-mini-presenting')).not.toBeNull();
  });

  it('wears the skin it was sent, minus anything that looks like the needs-you amber', async () => {
    const { api } = fakeApi(
      payload({ skin: { id: 'nightglass', states: { working: '#3366ff', done: '#f5c542' }, surfaces: {} } })
    );
    await themed.render(<OrchestrateMini api={api} />);

    expect(el('orchestrate-mini').dataset.skin).toBe('nightglass');
    const root = document.documentElement.style;
    expect(root.getPropertyValue('--b4m-skin-state-working')).toBe('#3366ff');
    expect(root.getPropertyValue('--b4m-skin-state-done')).toBe('');
  });

  it('closes from its button and from Escape', async () => {
    const { api } = fakeApi(null);
    await themed.render(<OrchestrateMini api={api} />);
    await act(async () => el('orchestrate-mini-close').click());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(api.close).toHaveBeenCalledTimes(2);
  });
});
