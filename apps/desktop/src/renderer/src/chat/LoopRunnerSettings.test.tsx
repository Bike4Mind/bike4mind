// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LoopRunnerState } from '@shared/loopRunner';
import { desktopTheme } from '../theme';
import { LoopRunnerSettings, loopRunnerSummary } from './LoopRunnerSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const state: LoopRunnerState = {
  signedIn: true,
  server: 'https://app.example.com',
  settings: { enabled: true, runOnBattery: false },
  openAtLogin: false,
  lanes: { cap: 2, busy: 1 },
  tickets: [
    {
      ticketId: 't1',
      title: 'Fix the docs',
      loopId: 'loop-1',
      loopName: 'Docs loop',
      stage: 'build',
      runId: 'run-1',
      sessionId: 's1',
      startedAt: '',
    },
  ],
  waitingReason: 'you are active',
  pendingApprovals: [{ loopId: 'loop-2', loopName: 'Tests loop', repoHint: 'example-org/widgets' }],
  policies: [{ loopId: 'loop-1', loopName: 'Docs loop', approvalMode: 'auto', directory: '/repo', approvedAt: '' }],
};

const api = {
  setSettings: vi.fn(async () => state),
  setOpenAtLogin: vi.fn(async () => state),
  approve: vi.fn(async () => ({ ok: false as const, error: 'That folder is not example-org/widgets.' })),
  revoke: vi.fn(async () => state),
};
const openExternal = vi.fn(async () => undefined);
const onState = vi.fn();
let root: Root;
let host: HTMLElement;

const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement;

beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(window, { b4m: { loopRunner: api, shell: { openExternal } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <CssVarsProvider theme={desktopTheme}>
        <LoopRunnerSettings state={state} onState={onState} />
      </CssVarsProvider>
    )
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it('shows lanes, the waiting reason and opens a run in the web', async () => {
  expect(byTestId('loop-runner-lanes').textContent).toBe('1 of 2 lanes busy - waiting: you are active');
  await act(async () => byTestId('loop-runner-open-run-btn').click());
  expect(openExternal).toHaveBeenCalledWith('https://app.example.com/loops/loop-1?run=run-1');
});

it('turns the runner off', async () => {
  await act(async () => byTestId('loop-runner-enabled-switch').click());
  expect(api.setSettings).toHaveBeenCalledWith({ enabled: false });
});

it('approves a pending loop and shows why it failed', async () => {
  await act(async () => byTestId('loop-runner-approve-btn').click());
  expect(api.approve).toHaveBeenCalledWith({
    loopId: 'loop-2',
    loopName: 'Tests loop',
    repoHint: 'example-org/widgets',
    approvalMode: 'auto',
  });
  expect(byTestId('loop-runner-approve-error').textContent).toBe('That folder is not example-org/widgets.');
});

it('revokes a policy', async () => {
  await act(async () => byTestId('loop-runner-revoke-btn').click());
  expect(api.revoke).toHaveBeenCalledWith('loop-1');
});

it('summarises the runner', () => {
  expect(loopRunnerSummary(state)).toBe('Working on 1 ticket.');
  expect(loopRunnerSummary({ ...state, tickets: [] })).toBe('Waiting: you are active.');
  expect(loopRunnerSummary({ ...state, settings: { enabled: false, runOnBattery: false } })).toMatch(/^Off/);
});
