/**
 * Model self-reported iteration confidence: a `<confidence>` tag in a tool-calling turn becomes that
 * iteration's `llm_self_report` score, and anything missing or malformed falls back to the
 * tool-based score.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReActAgent } from './ReActAgent';
import type { AgentContext, AgentStep } from './types';
import type { ICompletionBackend, ICompletionOptionTools, ToolResultValidator } from '@bike4mind/llm-adapters';

const GOOD_TAG = '<confidence score="0.4">search came back thin</confidence>';

function createTool(result: string, validateResult?: ToolResultValidator): ICompletionOptionTools {
  return {
    toolFn: vi.fn(async () => result),
    validateResult,
    toolSchema: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {}, required: [] } },
  };
}

/** One tool-calling turn whose text is `turnText`, then a final answer of `finalText`. */
function createLlm(turnText: string, finalText = 'Done', seenSystemPrompts: string[] = []): ICompletionBackend {
  let callCount = 0;
  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (_model, messages, _options, callback) => {
      callCount++;
      const system = messages.find(m => m.role === 'system');
      if (system) seenSystemPrompts.push(String(system.content));
      const probing = callCount === 1;
      await callback([probing ? turnText : finalText], {
        inputTokens: 10,
        outputTokens: 5,
        toolsUsed: probing ? [{ name: 'probe', arguments: '{}' }] : [],
      });
    },
    pushToolMessages: vi.fn(),
  };
}

function createAgent(
  tool: ICompletionOptionTools,
  llm: ICompletionBackend,
  extra: Partial<AgentContext> = { selfReportConfidence: true }
) {
  const context = {
    userId: 'test-user',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    llm,
    model: 'test-model',
    tools: [tool],
    maxIterations: 4,
    ...extra,
  } as unknown as AgentContext;
  const agent = new ReActAgent(context);
  const steps: AgentStep[] = [];
  agent.on('thought', (s: AgentStep) => steps.push(s));
  agent.on('observation', (s: AgentStep) => steps.push(s));
  agent.on('final_answer', (s: AgentStep) => steps.push(s));
  return { agent, steps };
}

const logOf = (agent: ReActAgent) =>
  agent.toCheckpoint().confidenceLog.map(({ confidence, source, reason }) => ({ confidence, source, reason }));

describe('ReActAgent self-reported confidence', () => {
  describe.each([
    ['run()', (agent: ReActAgent) => agent.run('probe it')],
    ['runIteration()', (agent: ReActAgent) => agent.runIteration('probe it')],
  ])('via %s', (_name, drive) => {
    it('records the model score and reason as llm_self_report', async () => {
      const { agent, steps } = createAgent(createTool('a real result'), createLlm(`${GOOD_TAG}\nChecking`));
      await drive(agent);

      expect(logOf(agent)).toEqual([{ confidence: 0.4, source: 'llm_self_report', reason: 'search came back thin' }]);
      const observation = steps.find(s => s.type === 'observation');
      expect(observation?.metadata).toMatchObject({
        confidence: 0.4,
        confidenceSource: 'llm_self_report',
        confidenceReason: 'search came back thin',
      });
    });

    it('keeps the tag out of the emitted thought', async () => {
      const { agent, steps } = createAgent(createTool('a real result'), createLlm(`${GOOD_TAG}\nChecking`));
      await drive(agent);

      expect(steps.find(s => s.type === 'thought')?.content).toBe('Checking');
    });

    it.each([
      ['an out-of-range score', '<confidence score="7">sure</confidence>Checking'],
      ['a non-numeric score', '<confidence score="high">sure</confidence>Checking'],
      ['no tag', 'Checking'],
    ])('falls back to the tool-based score for %s', async (_label, turnText) => {
      const { agent, steps } = createAgent(createTool('a real result'), createLlm(turnText));
      await drive(agent);

      expect(logOf(agent)).toEqual([{ confidence: 0.7, source: 'default', reason: undefined }]);
      expect(steps.find(s => s.type === 'thought')?.content).toBe('Checking');
    });

    it('never overrides a thrown-tool error score', async () => {
      const { agent } = createAgent(createTool('Error: provider failed'), createLlm(`${GOOD_TAG}Checking`));
      await drive(agent);

      expect(logOf(agent)).toEqual([{ confidence: 0.1, source: 'deterministic', reason: undefined }]);
    });

    it('never overrides a tool validator verdict', async () => {
      const tool = createTool('unavailable', () => ({ confidence: 0.2, source: 'deterministic' }));
      const { agent } = createAgent(tool, createLlm(`<confidence score="0.9">fine</confidence>Checking`));
      await drive(agent);

      expect(logOf(agent)).toEqual([{ confidence: 0.2, source: 'deterministic', reason: undefined }]);
    });

    it('is a no-op when the flag is off: the tag stays in the text and the score is the default', async () => {
      const { agent, steps } = createAgent(createTool('a real result'), createLlm(`${GOOD_TAG}Checking`), {});
      await drive(agent);

      expect(logOf(agent)).toEqual([{ confidence: 0.7, source: 'default', reason: undefined }]);
      expect(steps.find(s => s.type === 'thought')?.content).toContain('<confidence');
    });
  });

  describe.each([
    ['run()', (agent: ReActAgent) => agent.run('probe it')],
    ['runIteration()', (agent: ReActAgent) => agent.runIteration('probe it')],
  ])('live text stream via %s', (_name, drive) => {
    const chunkedLlm = (chunks: string[]): ICompletionBackend => {
      let call = 0;
      return {
        currentModel: 'test-model',
        getModelInfo: async () => [],
        complete: async (_m, _msgs, _o, callback) => {
          call++;
          if (call > 1) {
            await callback(['Done'], { inputTokens: 1, outputTokens: 1, toolsUsed: [] });
            return;
          }
          for (const chunk of chunks) await callback([chunk], { inputTokens: 1, outputTokens: 1, toolsUsed: [] });
          await callback([], { inputTokens: 1, outputTokens: 1, toolsUsed: [{ name: 'probe', arguments: '{}' }] });
        },
        pushToolMessages: vi.fn(),
      };
    };

    const deltasOf = async (chunks: string[], extra?: Partial<AgentContext>) => {
      const { agent, steps } = createAgent(createTool('a real result'), chunkedLlm(chunks), extra);
      const deltas: string[] = [];
      agent.on('text_delta', (e: { delta: string; iteration: number }) => {
        if (e.iteration === 0) deltas.push(e.delta);
      });
      await drive(agent);
      return { deltas: deltas.join(''), agent, steps };
    };

    it('never shows the tag, but still records the report', async () => {
      const { deltas, agent } = await deltasOf(['<confid', 'ence score="0.4">thin</confid', 'ence>\nChecking']);

      expect(deltas).toBe('Checking');
      expect(logOf(agent)).toEqual([{ confidence: 0.4, source: 'llm_self_report', reason: 'thin' }]);
    });

    it('hides a tag that follows an empty think block and emits no placeholder thought', async () => {
      const { deltas, agent, steps } = await deltasOf([
        '<think>',
        '</think>',
        '<confid',
        'ence score="0.4">thin</confid',
        'ence>\nChecking',
      ]);

      expect(deltas).toBe('Checking');
      expect(logOf(agent)).toEqual([{ confidence: 0.4, source: 'llm_self_report', reason: 'thin' }]);
      expect(steps.find(s => s.type === 'thought')?.content).toBe('Checking');
    });

    it('emits no thought at all when the turn is only an empty think block and a tag', async () => {
      const { deltas, agent, steps } = await deltasOf(['<think></think><confidence score="0.4">thin</confidence>']);

      expect(deltas).toBe('');
      expect(steps.some(s => s.type === 'thought')).toBe(false);
      expect(logOf(agent)).toEqual([{ confidence: 0.4, source: 'llm_self_report', reason: 'thin' }]);
    });

    it('emits no placeholder thought when the model sends the empty block but no tag', async () => {
      const { deltas, agent, steps } = await deltasOf(['<think></think>']);

      expect(deltas).toBe('');
      expect(steps.some(s => s.type === 'thought')).toBe(false);
      expect(logOf(agent)).toEqual([{ confidence: 0.7, source: 'default', reason: undefined }]);
    });

    it('leaves the stream untouched when the flag is off', async () => {
      const { deltas } = await deltasOf(['<confid', 'ence score="0.4">thin</confidence>Checking'], {});

      expect(deltas).toBe('<confidence score="0.4">thin</confidence>Checking');
    });
  });

  it('strips a stray tag from the final answer', async () => {
    const { agent, steps } = createAgent(
      createTool('a real result'),
      createLlm('Checking', `<confidence score="0.9">done</confidence>The answer is 42.`)
    );
    await agent.run('probe it');

    expect(steps.find(s => s.type === 'final_answer')?.content).toBe('The answer is 42.');
  });

  it('asks for the report in the system prompt only when enabled', async () => {
    const on: string[] = [];
    await createAgent(createTool('r'), createLlm('Checking', 'Done', on)).agent.run('probe it');
    const off: string[] = [];
    await createAgent(createTool('r'), createLlm('Checking', 'Done', off), {}).agent.run('probe it');

    expect(on.length).toBeGreaterThan(0);
    expect(on.every(p => p.includes('<confidence score='))).toBe(true);
    expect(on.every(p => /every turn that calls a tool/i.test(p) && /follows a tool result/i.test(p))).toBe(true);
    expect(off.some(p => p.includes('<confidence'))).toBe(false);
  });

  it('does not carry a report into the next turn', async () => {
    let call = 0;
    const llm: ICompletionBackend = {
      currentModel: 'test-model',
      getModelInfo: async () => [],
      complete: async (_m, _msgs, _o, callback) => {
        call++;
        const text = call === 1 ? `${GOOD_TAG}Checking` : call === 2 ? 'Checking again' : 'Done';
        await callback([text], {
          inputTokens: 1,
          outputTokens: 1,
          toolsUsed: call <= 2 ? [{ name: 'probe', arguments: `{"n":${call}}` }] : [],
        });
      },
      pushToolMessages: vi.fn(),
    };
    const { agent } = createAgent(createTool('a real result'), llm);
    await agent.run('probe it');

    expect(logOf(agent).map(l => l.source)).toEqual(['llm_self_report', 'default']);
  });
});
