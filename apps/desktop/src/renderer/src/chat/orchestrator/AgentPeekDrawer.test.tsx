// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../../theme';
import { AgentPeekDrawer } from './AgentPeekDrawer';
import type { AgentView } from './roster';

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

const agent = (extra: Partial<AgentView> = {}): AgentView => ({
  id: 'a1',
  title: 'Agent one',
  parentId: 'root',
  depth: 1,
  seedPrompt: 'Do the thing',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  model: 'm',
  state: 'working',
  ...extra,
});

let root: Root | null = null;
let host: HTMLElement | null = null;
const chat = {
  getSession: vi.fn(),
  sendMessage: vi.fn(),
  cancelQueuedMessage: vi.fn(),
  sendQueuedMessageNow: vi.fn(),
};
const actions = { open: vi.fn(), stop: vi.fn(), archive: vi.fn() };
const onClose = vi.fn();

async function mount(view: AgentView) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <AgentPeekDrawer agent={view} onClose={onClose} actions={actions} />
      </CssVarsProvider>
    );
  });
}

const el = (testId: string) => {
  const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};
const query = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

async function typeAndSend(text: string) {
  const input = el('orchestrator-peek-reply-input') as HTMLTextAreaElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => el('orchestrator-peek-send-btn').click());
}

beforeEach(() => {
  vi.clearAllMocks();
  chat.getSession.mockResolvedValue({
    messages: [1, 2, 3, 4].map(n => ({ id: `m${n}`, role: 'assistant', content: `message ${n}` })),
  });
  (window as unknown as { b4m: unknown }).b4m = { chat };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('AgentPeekDrawer', () => {
  it('shows the last three messages', async () => {
    await mount(agent());
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('message 1');
    expect(text).toContain('message 2');
    expect(text).toContain('message 4');
  });

  it('sends the reply to the agent session', async () => {
    chat.sendMessage.mockResolvedValue({ ok: true, messageId: 'x' });
    await mount(agent());
    await typeAndSend('hello');
    expect(chat.sendMessage).toHaveBeenCalledWith({ sessionId: 'a1', text: 'hello' });
    expect(query('orchestrator-peek-queued-note')).toBeNull();
  });

  it('shows the queued note and cancels the queued message', async () => {
    chat.sendMessage.mockResolvedValue({
      ok: true,
      queued: true,
      message: { id: 'q1', sessionId: 'a1', text: 'hello' },
    });
    await mount(agent());
    await typeAndSend('hello');
    expect(el('orchestrator-peek-queued-note').textContent).toContain(
      'Queued - it will send when this agent finishes its current step.'
    );
    await act(async () => el('orchestrator-peek-queued-cancel-btn').click());
    expect(chat.cancelQueuedMessage).toHaveBeenCalledWith('a1', 'q1');
    expect(query('orchestrator-peek-queued-note')).toBeNull();
  });

  it('shows the error when the send is refused', async () => {
    chat.sendMessage.mockResolvedValue({ ok: false, error: 'Signed out' });
    await mount(agent());
    await typeAndSend('hello');
    expect(el('orchestrator-peek-error').textContent).toBe('Signed out');
  });

  it('hides Stop for a finished agent but offers it while working', async () => {
    await mount(agent({ state: 'done' }));
    expect(query('orchestrator-peek-stop-btn')).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    await mount(agent({ state: 'working' }));
    await act(async () => el('orchestrator-peek-stop-btn').click());
    expect(actions.stop).toHaveBeenCalledWith('a1');
  });

  it('archives then closes', async () => {
    await mount(agent());
    await act(async () => el('orchestrator-peek-archive-btn').click());
    expect(actions.archive).toHaveBeenCalledWith('a1');
    expect(onClose).toHaveBeenCalled();
  });
});
