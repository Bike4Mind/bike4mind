// @vitest-environment jsdom
import { chatBackedHostBridge } from '../../__fixtures__/chatBackedHostBridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatMessage, ChatToolCall } from '@shared/chat';
import type { ViewApproval } from '@shared/viewSnapshot';
import { useQuickApprovals, quickApprovalsIn } from './quickApprovals';
import type { AgentView, ParentView } from './roster';
import { agentFixture } from './testUtils';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const parked = (approvalId: string, command: string): ChatMessage =>
  ({
    id: `m-${approvalId}`,
    role: 'assistant',
    content: '',
    toolCalls: [
      {
        id: `c-${approvalId}`,
        name: 'bash_execute',
        input: { command },
        status: 'awaiting-approval',
        approvalId,
        approvalDetail: `$ ${command}`,
      },
    ],
  }) as unknown as ChatMessage;

let messagesBySession: Record<string, ChatMessage[] | Error>;
const getSession = vi.fn(async (sessionId: string) => {
  const found = messagesBySession[sessionId];
  if (found instanceof Error) throw found;
  return found ? { messages: found } : null;
});

let seen: ViewApproval[] = [];
let container: HTMLDivElement;
let root: Root;

function Probe(props: { enabled: boolean; agents: AgentView[]; parent: ParentView }) {
  seen = useQuickApprovals(props.enabled, 'root', props.agents, props.parent);
  return null;
}
const render = (props: Parameters<typeof Probe>[0]) => act(async () => root.render(<Probe {...props} />));

beforeEach(() => {
  seen = [];
  messagesBySession = {
    root: [parked('p-root', 'touch x')],
    a: [parked('p-a', 'ls')],
    b: [parked('p-b', 'pwd')],
    busy: [parked('p-busy', 'pwd')],
  };
  (window as unknown as { b4m: unknown }).b4m = { host: chatBackedHostBridge(), chat: { getSession } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('useQuickApprovals', () => {
  it('lists the root only while it needs action, and each waiting agent', async () => {
    const agents = [agentFixture('a', 'needs-you'), agentFixture('b', 'needs-you')];
    await render({ enabled: true, agents, parent: { status: 'needs-action' } });
    expect(seen).toEqual([
      { id: 'p-root', sessionId: 'root', label: 'bash_execute $ touch x' },
      { id: 'p-a', sessionId: 'a', label: 'bash_execute $ ls' },
      { id: 'p-b', sessionId: 'b', label: 'bash_execute $ pwd' },
    ]);

    getSession.mockClear();
    await render({ enabled: true, agents, parent: { status: 'processing' } });
    expect(seen.map(approval => approval.sessionId)).toEqual(['a', 'b']);
  });

  it('does not read a working agent', async () => {
    await render({ enabled: true, agents: [agentFixture('busy', 'working')], parent: {} });
    expect(getSession).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('reads nothing while disabled', async () => {
    await render({ enabled: false, agents: [agentFixture('a', 'needs-you')], parent: { status: 'needs-action' } });
    expect(getSession).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('does not read again for a fresh array with the same sessions and keys', async () => {
    await render({ enabled: true, agents: [agentFixture('a', 'needs-you')], parent: {} });
    expect(getSession).toHaveBeenCalledTimes(1);
    await render({ enabled: true, agents: [agentFixture('a', 'needs-you')], parent: {} });
    expect(getSession).toHaveBeenCalledTimes(1);
    await render({
      enabled: true,
      agents: [agentFixture('a', 'needs-you', { updatedAt: '2026-10-02T00:00:00.000Z' })],
      parent: {},
    });
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('lists the others when one session cannot be read', async () => {
    messagesBySession.a = new Error('gone');
    await render({
      enabled: true,
      agents: [agentFixture('a', 'needs-you'), agentFixture('b', 'needs-you')],
      parent: {},
    });
    expect(seen.map(approval => approval.id)).toEqual(['p-b']);
  });

  it('drops the result of a read that a newer key has replaced', async () => {
    let release: (value: { messages: ChatMessage[] }) => void = () => undefined;
    getSession.mockImplementationOnce(() => new Promise(resolve => (release = resolve)));
    await render({ enabled: true, agents: [agentFixture('a', 'needs-you')], parent: {} });
    await render({ enabled: true, agents: [agentFixture('b', 'needs-you')], parent: {} });
    await act(async () => release({ messages: [parked('p-late', 'ls')] }));
    expect(seen.map(approval => approval.id)).toEqual(['p-b']);
  });
});

describe('quickApprovals', () => {
  const call = (approvalId: string, extra: Partial<ChatToolCall> = {}): ChatToolCall =>
    ({
      id: `call-${approvalId}`,
      name: 'bash',
      input: { command: 'pnpm test' },
      status: 'awaiting-approval',
      approvalId,
      approvalDetail: 'pnpm test',
      ...extra,
    }) as ChatToolCall;

  const message = (toolCalls: ChatToolCall[]): ChatMessage =>
    ({ id: 'm1', role: 'assistant', content: '', toolCalls }) as unknown as ChatMessage;

  describe('quickApprovalsIn', () => {
    it('lists the calls the menu bar could answer, with its one-line summary', () => {
      expect(quickApprovalsIn('a', [message([call('p1')])])).toEqual([
        { id: 'p1', sessionId: 'a', label: 'bash pnpm test' },
      ]);
    });

    it('leaves out calls that need the full card or are no longer parked', () => {
      const calls = [
        call('irreversible', { approvalIrreversible: true }),
        call('warned', { approvalWarning: 'Touches the network' }),
        call('two-lines', { approvalDetail: 'pnpm test\nrm -rf dist' }),
        call('asked', { name: 'ask_user' }),
        call('done', { status: 'done' } as Partial<ChatToolCall>),
      ];
      expect(quickApprovalsIn('a', [message(calls)])).toEqual([]);
    });
  });
});
