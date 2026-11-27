// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatToolCall } from '@shared/chat';
import type { PendingDecision } from '@shared/pendingDecisions';
import type { AgentState } from '@shared/agentState';
import { agentFixture, createThemedMount } from '../testUtils';
import { useAskStates } from './useAskStates';

const mount = createThemedMount();
afterEach(() => mount.unmount());

const approval = (sessionId: string, command: string): PendingDecision => ({
  kind: 'approval',
  sessionId,
  decisionId: `approval:ap-${command}`,
  approvalId: `ap-${command}`,
  call: {
    id: `call-${command}`,
    name: 'bash_execute',
    input: { command },
    status: 'awaiting-approval',
  } as ChatToolCall,
  collectsSecrets: false,
});
const failure: PendingDecision = {
  kind: 'error',
  sessionId: 'a',
  decisionId: 'error:m1',
  messageId: 'm1',
  error: 'boom',
};

let hook: ReturnType<typeof useAskStates>;
function Harness({ state }: { state: AgentState }) {
  hook = useAskStates(true, [agentFixture('a', state)]);
  return null;
}
const renderAs = (state: AgentState) => mount.render(<Harness state={state} />);
const report = (asks: [string, PendingDecision][]) => act(async () => hook.onAsksChange(new Map(asks)));

describe('useAskStates', () => {
  it('shows the request the box answered, not the first one its session asked', async () => {
    await renderAs('needs-you');
    await report([['a', approval('a', 'first')]]);
    await act(async () => hook.onAnswered(approval('a', 'second'), 'approved'));
    expect(hook.outcomes.get('a')).toMatchObject({ state: 'approved', ask: { what: 'bash_execute second' } });
  });

  it('keeps an answer from the box that settles after the request already left', async () => {
    await renderAs('needs-you');
    await report([['a', approval('a', 'first')]]);
    await renderAs('working');
    await report([]);
    expect(hook.outcomes.get('a')?.state).toBe('elsewhere');
    await act(async () => hook.onAnswered(approval('a', 'first'), 'denied'));
    expect(hook.outcomes.get('a')?.state).toBe('denied');
  });

  it('says nothing when a failed agent is rerun and its Retry card goes', async () => {
    await renderAs('failed');
    await report([['a', failure]]);
    await renderAs('working');
    await report([]);
    expect(hook.outcomes.size).toBe(0);
  });
});
