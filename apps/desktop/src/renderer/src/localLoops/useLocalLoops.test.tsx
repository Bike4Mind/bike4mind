// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LocalLoopDetail, LocalTicket } from '@shared/localLoops';
import { useLocalLoop } from './useLocalLoops';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ticket: LocalTicket = {
  id: 't1',
  loopId: 'l1',
  title: 'Fix the docs',
  stage: 'todo',
  status: 'open',
  dependencies: [],
  runCount: 0,
  stageHistory: [],
  createdAt: '',
  updatedAt: '',
};
const detail = {
  loop: { id: 'l1', name: 'Docs', stages: ['todo', 'doing'] },
  lanesBusy: 0,
  spentToday: 0,
  needsYou: 0,
  tickets: [ticket],
  runs: [],
  events: [],
} as unknown as LocalLoopDetail;

let resolveUpdate: (value: unknown) => void;
const api = {
  get: vi.fn(async () => ({ ok: true, value: detail })),
  updateTicket: vi.fn(() => new Promise(resolve => (resolveUpdate = resolve))),
  onChanged: vi.fn(() => () => undefined),
};
let hook: ReturnType<typeof useLocalLoop>;
function Probe() {
  hook = useLocalLoop('l1');
  return null;
}
let root: Root;

beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(window, { b4m: { localLoops: api } });
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Probe />));
});
afterEach(async () => {
  await act(async () => root.unmount());
});

const stageOf = () => hook.detail?.tickets[0].stage;

it('shows a move before the store answers, and keeps the stored ticket', async () => {
  let moved!: Promise<boolean>;
  act(() => void (moved = hook.moveTicket('t1', { stage: 'doing' })));
  expect(stageOf()).toBe('doing');
  expect(api.updateTicket).toHaveBeenCalledWith({ id: 't1', stage: 'doing' });
  await act(async () => {
    resolveUpdate({ ok: true, value: { ...ticket, stage: 'doing', runCount: 0, updatedAt: 'now' } });
    await moved;
  });
  expect(hook.detail?.tickets[0]).toMatchObject({ stage: 'doing', updatedAt: 'now' });
  expect(hook.error).toBeNull();
});

it('rolls a refused move back and says why', async () => {
  let moved!: Promise<boolean>;
  act(() => void (moved = hook.moveTicket('t1', { stage: 'doing' })));
  expect(stageOf()).toBe('doing');
  await act(async () => {
    resolveUpdate({ ok: false, error: 'Running - pause the loop or wait for the run to end.' });
    expect(await moved).toBe(false);
  });
  expect(stageOf()).toBe('todo');
  expect(hook.error).toBe('Running - pause the loop or wait for the run to end.');
});
