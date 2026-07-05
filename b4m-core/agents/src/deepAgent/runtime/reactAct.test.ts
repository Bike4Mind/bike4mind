import { describe, it, expect } from 'vitest';
import type { AgentResult } from '../../types';
import { agentResultToActResult } from './reactAct';
import { resolveToolbeltProfile, DEFAULT_TOOLBELT_ROLE } from './toolbelts';

function agentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    finalAnswer: 'done',
    steps: [],
    completionInfo: {
      totalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      iterations: 1,
      toolCalls: 0,
      reachedMaxIterations: false,
    },
    ...overrides,
  };
}

describe('agentResultToActResult', () => {
  it('maps action steps to actionsTaken with tool name + input', () => {
    const result = agentResult({
      steps: [
        {
          type: 'action',
          content: 'calling bash_execute',
          metadata: { toolName: 'bash_execute', toolInput: { cmd: 'ls' }, timestamp: 1 },
        },
      ],
    });
    const act = agentResultToActResult(result);
    expect(act.actionsTaken).toEqual([{ tool: 'bash_execute', input: { cmd: 'ls' }, succeeded: true }]);
  });

  it('maps observation steps and appends the final answer as an observation', () => {
    const result = agentResult({
      finalAnswer: 'reproduced the figure',
      steps: [{ type: 'observation', content: 'exit 0', metadata: { timestamp: 1 } }],
    });
    const act = agentResultToActResult(result);
    expect(act.observations).toEqual([
      { kind: 'tool_result', summary: 'exit 0' },
      { kind: 'final_answer', summary: 'reproduced the figure' },
    ]);
  });

  it('carries token spend from completionInfo', () => {
    const act = agentResultToActResult(
      agentResult({ completionInfo: { ...agentResult().completionInfo, totalTokens: 4096 } })
    );
    expect(act.tokensSpent).toBe(4096);
  });

  it('falls back to "unknown" when an action step lacks a tool name', () => {
    const result = agentResult({ steps: [{ type: 'action', content: '?', metadata: { timestamp: 1 } }] });
    expect(agentResultToActResult(result).actionsTaken[0].tool).toBe('unknown');
  });

  it('omits the final-answer observation when there is no final answer', () => {
    const act = agentResultToActResult(agentResult({ finalAnswer: '' }));
    expect(act.observations).toEqual([]);
  });
});

describe('resolveToolbeltProfile', () => {
  it('returns the paper-repro profile for that role', () => {
    const profile = resolveToolbeltProfile('paper-repro');
    expect(profile.role).toBe('paper-repro');
    expect(profile.maxIterations).toBeGreaterThan(0);
    expect(profile.enabledToolNames.length).toBeGreaterThan(0);
  });

  it('falls back to the default profile for an unknown role', () => {
    const profile = resolveToolbeltProfile('astronaut-poet');
    expect(profile.role).toBe(DEFAULT_TOOLBELT_ROLE);
    // Default is a capable general web toolbelt (web-safe tools only).
    expect(profile.enabledToolNames).toContain('web_search');
    expect(profile.enabledToolNames).not.toContain('bash_execute');
  });
});
