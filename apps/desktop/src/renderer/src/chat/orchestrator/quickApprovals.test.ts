import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatToolCall } from '@shared/chat';
import { quickApprovalsIn } from './quickApprovals';

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
