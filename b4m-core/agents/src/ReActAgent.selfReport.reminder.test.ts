import { describe, it, expect, vi } from 'vitest';
import { ReActAgent, WORKFLOW_REMINDER_MARKER } from './ReActAgent';
import type { AgentContext } from './types';
import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import type { IMessage } from '@bike4mind/common';

function createContext(llm: ICompletionBackend, overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userId: 'u1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    llm,
    model: 'test-model',
    tools: [noopTool],
    maxIterations: 5,
    ...overrides,
  };
}

const noopTool = {
  toolFn: async () => 'ok',
  toolSchema: { name: 'noop', description: 'noop', parameters: { type: 'object' as const, properties: {} } },
};

/** Calls a tool on the first N completions, then answers; snapshots the messages of every request. */
function createToolThenAnswerLlm(toolTurns: number) {
  const requests: IMessage[][] = [];
  let call = 0;
  const llm: ICompletionBackend = {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (
      _model: string,
      messages: IMessage[],
      _options: Partial<ICompletionOptions>,
      callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
    ) => {
      requests.push(messages.map(m => ({ ...m })));
      call++;
      if (call <= toolTurns) {
        await callback([''], {
          inputTokens: 5,
          outputTokens: 2,
          toolsUsed: [{ id: `call-${call}`, name: 'noop', arguments: '{}' }],
          stopReason: 'tool_use',
        });
        return;
      }
      await callback(['done'], { inputTokens: 5, outputTokens: 2, toolsUsed: [], stopReason: 'end_turn' });
    },
    pushToolMessages: (messages, toolCall, observation) => {
      messages.push({ role: 'assistant', content: `[tool_use ${toolCall.id}]` } as IMessage);
      messages.push({ role: 'user', content: `[tool_result ${toolCall.id}] ${observation}` } as IMessage);
    },
  };
  return { llm, requests };
}

const lastContent = (messages: IMessage[]) => String(messages[messages.length - 1].content);
const reminders = (messages: IMessage[]) =>
  messages.filter(
    m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(WORKFLOW_REMINDER_MARKER)
  );

const drivers: Array<[string, (agent: ReActAgent) => Promise<unknown>]> = [
  ['run()', agent => agent.run('probe it')],
  [
    'runIteration()',
    async agent => {
      await agent.runIteration('probe it');
      await agent.runIteration();
      await agent.runIteration();
    },
  ],
];

describe.each(drivers)('self-report reminder on turns after a tool result - %s', (_name, drive) => {
  it('reminds the model to tag on every request that follows a tool result, not on the first', async () => {
    const { llm, requests } = createToolThenAnswerLlm(2);
    await drive(new ReActAgent(createContext(llm, { selfReportConfidence: true })));

    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(reminders(requests[0])).toHaveLength(0);
    for (const request of requests.slice(1)) {
      expect(reminders(request)).toHaveLength(1);
      expect(lastContent(request)).toContain('<confidence score=');
    }
  });

  it('never stacks the reminder across iterations', async () => {
    const { llm, requests } = createToolThenAnswerLlm(3);
    await drive(new ReActAgent(createContext(llm, { selfReportConfidence: true, maxIterations: 6 })));

    for (const request of requests) expect(reminders(request).length).toBeLessThanOrEqual(1);
  });

  it('adds nothing when self-report is off', async () => {
    const { llm, requests } = createToolThenAnswerLlm(2);
    await drive(new ReActAgent(createContext(llm)));

    for (const request of requests) expect(reminders(request)).toHaveLength(0);
  });
});

describe('self-report reminder with a workflow reminder', () => {
  it('shares the single trailing reminder message with the workflow state', async () => {
    const { llm, requests } = createToolThenAnswerLlm(2);
    await new ReActAgent(createContext(llm, { selfReportConfidence: true })).run('probe it', {
      workflowReminder: () => 'Open todos: 1',
    });

    expect(reminders(requests[0])).toHaveLength(1);
    expect(lastContent(requests[0])).toContain('Open todos: 1');
    expect(lastContent(requests[0])).not.toContain('<confidence score=');
    for (const request of requests.slice(1)) {
      expect(reminders(request)).toHaveLength(1);
      expect(lastContent(request)).toContain('Open todos: 1');
      expect(lastContent(request)).toContain('<confidence score=');
    }
  });
});
