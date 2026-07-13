import { describe, it, expect, vi } from 'vitest';
import type { AgentStep, ServerAgentDefinition } from '@bike4mind/agents';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import { ServerSubagentOrchestrator, type ServerSubagentTracker } from './ServerSubagentOrchestrator';

/**
 * Regression coverage for issue #35: a long streamed no-tool subagent reply
 * must surface as exactly ONE `final_answer` step through `tracker.onStep`,
 * not one step per streamed text delta (each holding the accumulated text so
 * far). The client store appends one StepRow per `subagent_iteration_step`
 * event, so every extra emission here renders as a duplicate "Final Answer"
 * row in `SubagentStepNest`.
 *
 * The fake backend mimics the real streaming adapters' callback contract
 * (anthropicBackend/bedrockBackend): the callback fires once per text delta
 * with only the new chunk and a `{ toolsUsed }` completionInfo on every
 * frame, then once more at stream end with the usage totals.
 */

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    updateMetadata: vi.fn(),
  } as unknown as Logger;
}

// A ~2KB markdown reply split into many small deltas, like a real stream.
const FINAL_MARKDOWN =
  '### Summary\n\nThree well-documented findings about the topic under investigation.\n\n' +
  '### Findings\n\n' +
  Array.from({ length: 20 }, (_, i) => `- Finding ${i + 1}: a reasonably long line of streamed markdown content.`).join(
    '\n'
  );

function splitIntoDeltas(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

function makeStreamingLlm(model = 'claude-sonnet-4-6'): ICompletionBackend {
  return {
    currentModel: model,
    complete: vi.fn(
      async (
        _model: string,
        _messages: unknown,
        _options: unknown,
        cb: (texts: (string | null | undefined)[], info?: Record<string, unknown>) => Promise<void>
      ) => {
        const toolsUsed: unknown[] = [];
        for (const delta of splitIntoDeltas(FINAL_MARKDOWN, 32)) {
          // Real adapters pass `{ toolsUsed }` on every delta frame.
          await cb([delta], { toolsUsed });
        }
        // Terminal frame with usage, mirroring anthropicBackend's message_stop.
        await cb([], { toolsUsed, inputTokens: 100, outputTokens: 500 });
      }
    ),
    pushToolMessages: vi.fn(),
    getModelInfo: vi.fn().mockResolvedValue([]),
  } as unknown as ICompletionBackend;
}

function makeAgentDef(overrides: Partial<ServerAgentDefinition> = {}): ServerAgentDefinition {
  return {
    name: 'child-writer',
    description: 'Writes long markdown replies',
    model: 'claude-sonnet-4-6',
    systemPrompt: 'Respond with markdown. Task: $TASK',
    maxIterations: { quick: 3, medium: 6, very_thorough: 12 },
    defaultThoroughness: 'medium',
    ...overrides,
  };
}

describe('ServerSubagentOrchestrator step streaming (issue #35)', () => {
  it('forwards exactly one final_answer step for a streamed no-tool reply', async () => {
    const forwardedSteps: Array<{ step: AgentStep; iteration: number }> = [];
    const textDeltas: string[] = [];

    const tracker: ServerSubagentTracker = {
      onStart: vi.fn().mockResolvedValue('child-exec-id'),
      onStep: vi.fn(async ({ step, iteration }) => {
        forwardedSteps.push({ step, iteration });
      }),
      onTextDelta: vi.fn(async ({ delta }) => {
        textDeltas.push(delta);
      }),
      onComplete: vi.fn().mockResolvedValue(undefined),
      onFailure: vi.fn().mockResolvedValue(undefined),
    };

    const orchestrator = new ServerSubagentOrchestrator({
      userId: 'u1',
      llm: makeStreamingLlm(),
      logger: makeLogger(),
      parentTools: [],
      tracker,
    });

    const result = await orchestrator.delegateToAgent({
      task: 'Write a summary with findings',
      agentDef: makeAgentDef(),
    });

    // The full reply must round-trip intact.
    expect(result.finalAnswer).toBe(FINAL_MARKDOWN);

    // Deltas stream live (one per chunk) for the in-iteration preview...
    expect(textDeltas.join('')).toBe(FINAL_MARKDOWN);
    expect(textDeltas.length).toBeGreaterThan(10);

    // ...but the persisted step stream must collapse to ONE final_answer row.
    const finalAnswerSteps = forwardedSteps.filter(({ step }) => step.type === 'final_answer');
    expect(finalAnswerSteps).toHaveLength(1);
    expect(finalAnswerSteps[0].step.content).toBe(FINAL_MARKDOWN);
    expect(finalAnswerSteps[0].iteration).toBe(0);
  });
});
