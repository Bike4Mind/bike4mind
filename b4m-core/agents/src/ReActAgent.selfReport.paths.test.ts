/**
 * Self-reported confidence through the paths the basic tests do not reach: parallel tool execution,
 * the confidence gate, checkpoint/continuation, the approval-replay accessor, and the wire schema.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentStepSchema } from '@bike4mind/common';
import { ReActAgent } from './ReActAgent';
import type { AgentContext, AgentStep, ConfidenceGateDecision } from './types';
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';

const TAG = (score: number, reason = 'because') => `<confidence score="${score}">${reason}</confidence>`;

function createTool(name: string, result = 'a real result'): ICompletionOptionTools {
  return {
    toolFn: vi.fn(async () => result),
    toolSchema: { name, description: name, parameters: { type: 'object', properties: {}, required: [] } },
  };
}

type Turn = { text: string; tools?: Array<{ name: string; arguments?: string; id?: string }> };

/** One scripted completion per turn; a turn without tools is a final answer. */
function scriptedLlm(turns: Turn[]): ICompletionBackend {
  let call = 0;
  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (_m, _msgs, _o, callback) => {
      const turn = turns[Math.min(call, turns.length - 1)];
      call++;
      await callback([turn.text], {
        inputTokens: 1,
        outputTokens: 1,
        toolsUsed: (turn.tools ?? []).map((t, i) => ({ arguments: '{}', id: `toolu_${call}_${i}`, ...t })),
      });
    },
    pushToolMessages: vi.fn(),
  };
}

function createAgent(tools: ICompletionOptionTools[], llm: ICompletionBackend, extra: Partial<AgentContext> = {}) {
  const context = {
    userId: 'test-user',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    llm,
    model: 'test-model',
    tools,
    maxIterations: 5,
    selfReportConfidence: true,
    ...extra,
  } as unknown as AgentContext;
  const agent = new ReActAgent(context);
  const steps: AgentStep[] = [];
  for (const kind of ['thought', 'action', 'observation', 'final_answer'] as const) {
    agent.on(kind, (s: AgentStep) => steps.push(s));
  }
  return { agent, steps };
}

const logOf = (agent: ReActAgent) =>
  agent.toCheckpoint().confidenceLog.map(({ toolName, confidence, source, reason }) => ({
    toolName,
    confidence,
    source,
    reason,
  }));

describe('parallel tool execution', () => {
  const parallel = { parallelExecution: true, isReadOnlyTool: () => true };
  const turns: Turn[] = [
    {
      text: `${TAG(0.35, 'two sources disagree')}\nChecking both`,
      tools: [{ name: 'probe_a' }, { name: 'probe_b' }],
    },
    { text: 'Done' },
  ];

  it.each([
    ['run()', (agent: ReActAgent) => agent.run('go', parallel)],
    ['runIteration()', (agent: ReActAgent) => agent.runIteration('go', parallel)],
  ])('gives every call in the batch the turn report via %s', async (_name, drive) => {
    const { agent, steps } = createAgent([createTool('probe_a'), createTool('probe_b')], scriptedLlm(turns));
    await drive(agent);

    expect(logOf(agent)).toEqual([
      { toolName: 'probe_a', confidence: 0.35, source: 'llm_self_report', reason: 'two sources disagree' },
      { toolName: 'probe_b', confidence: 0.35, source: 'llm_self_report', reason: 'two sources disagree' },
    ]);
    expect(steps.find(s => s.type === 'thought')?.content).toBe('Checking both');
  });

  it('still protects an erroring call inside the batch', async () => {
    const { agent } = createAgent(
      [createTool('probe_a'), createTool('probe_b', 'Error: provider failed')],
      scriptedLlm(turns)
    );
    await agent.run('go', parallel);

    expect(logOf(agent).map(l => [l.toolName, l.confidence, l.source])).toEqual([
      ['probe_a', 0.35, 'llm_self_report'],
      ['probe_b', 0.1, 'deterministic'],
    ]);
  });
});

describe('confidence gate', () => {
  const lowTurn: Turn[] = [{ text: `${TAG(0.2, 'guessing')}Working`, tools: [{ name: 'probe_a' }] }, { text: 'Done' }];
  const pauseBelowHalf = vi.fn((confidence: number): ConfidenceGateDecision =>
    confidence < 0.5
      ? { action: 'wait_for_human', confidence, reason: 'low' }
      : { action: 'proceed', confidence, reason: 'ok' }
  );

  it('pauses on a low self-report that the tool score alone would have let through', async () => {
    const { agent } = createAgent([createTool('probe_a')], scriptedLlm(lowTurn));
    const result = await agent.runIteration('go', { confidenceGate: pauseBelowHalf });

    expect(pauseBelowHalf).toHaveBeenLastCalledWith(0.2, expect.any(Number));
    expect(result.isComplete).toBe(true);
    expect(result.step.content).toMatch(/^\[Paused for review.*20%/);
  });

  it('does not pause the same turn when self-report is off (tool score 0.7, tag left in text)', async () => {
    const gate = vi.fn((c: number): ConfidenceGateDecision => ({ action: 'proceed', confidence: c, reason: 'ok' }));
    const { agent } = createAgent([createTool('probe_a')], scriptedLlm(lowTurn), { selfReportConfidence: false });
    const result = await agent.runIteration('go', { confidenceGate: gate });

    expect(gate).toHaveBeenLastCalledWith(0.7, expect.any(Number));
    expect(result.isComplete).toBe(false);
  });

  it('scores a replayed approval-gated call by its own tool result, never the earlier turn report', async () => {
    const llm = { ...scriptedLlm(lowTurn), replaceLastToolResultObservation: vi.fn() } as ICompletionBackend;
    const { agent } = createAgent([createTool('probe_a')], llm);
    const result = await agent.runIteration('go', { toolGate: () => true });
    await agent.executeGatedToolCall(result.gatedToolCalls![0]);

    expect(agent.takeIterationConfidence()).toBe(0.7);
    expect(logOf(agent)).toEqual([{ toolName: 'probe_a', confidence: 0.7, source: 'default', reason: undefined }]);
  });
});

describe('checkpoint and continuation', () => {
  const turns: Turn[] = [{ text: `${TAG(0.6, 'on track')}Step`, tools: [{ name: 'probe_a' }] }, { text: 'Done' }];

  it('keeps the reason through a JSON round trip into a fresh agent', async () => {
    const first = createAgent([createTool('probe_a')], scriptedLlm(turns));
    await first.agent.runIteration('go');
    const saved = JSON.parse(JSON.stringify(first.agent.toCheckpoint()));

    const second = createAgent([createTool('probe_a')], scriptedLlm([{ text: 'Done' }]));
    second.agent.fromCheckpoint(saved);

    expect(logOf(second.agent)).toEqual([
      { toolName: 'probe_a', confidence: 0.6, source: 'llm_self_report', reason: 'on track' },
    ]);
  });

  it('continues a restored run and records the next turn report, not the previous one', async () => {
    const first = createAgent([createTool('probe_a')], scriptedLlm(turns));
    await first.agent.runIteration('go');
    const saved = JSON.parse(JSON.stringify(first.agent.toCheckpoint()));

    const next: Turn[] = [{ text: `${TAG(0.9, 'confirmed')}More`, tools: [{ name: 'probe_a', arguments: '{"n":2}' }] }];
    const second = createAgent([createTool('probe_a')], scriptedLlm(next));
    second.agent.fromCheckpoint(saved);
    await second.agent.runIteration();

    expect(logOf(second.agent).map(l => [l.confidence, l.reason])).toEqual([
      [0.6, 'on track'],
      [0.9, 'confirmed'],
    ]);
  });

  it('loads a checkpoint written before reasons existed and keeps working', async () => {
    const old = createAgent([createTool('probe_a')], scriptedLlm([{ text: 'x', tools: [{ name: 'probe_a' }] }]), {
      selfReportConfidence: false,
    });
    await old.agent.runIteration('go');
    const saved = JSON.parse(JSON.stringify(old.agent.toCheckpoint()));
    for (const entry of saved.confidenceLog) delete entry.reason;

    const resumed = createAgent([createTool('probe_a')], scriptedLlm(turns));
    resumed.agent.fromCheckpoint(saved);
    await resumed.agent.runIteration();

    expect(logOf(resumed.agent).map(l => [l.source, l.reason])).toEqual([
      ['default', undefined],
      ['llm_self_report', 'on track'],
    ]);
  });
});

describe('wire schema', () => {
  it('parses every emitted step and keeps the self-reported source and reason', async () => {
    const { agent, steps } = createAgent(
      [createTool('probe_a')],
      scriptedLlm([{ text: `${TAG(0.4, 'thin results')}Looking`, tools: [{ name: 'probe_a' }] }, { text: 'Done' }])
    );
    await agent.run('go');

    const parsed = steps.map(s => AgentStepSchema.parse(s));
    const observation = parsed.find(s => s.type === 'observation');
    expect(observation?.metadata).toMatchObject({
      confidence: 0.4,
      confidenceSource: 'llm_self_report',
      confidenceReason: 'thin results',
    });
    expect(parsed.map(s => JSON.stringify(s)).join('')).not.toContain('<confidence');
  });
});
