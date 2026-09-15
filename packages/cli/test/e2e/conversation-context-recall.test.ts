/**
 * E2E regression: cross-turn recall of tool results.
 *
 * Reproduces the "CLI forgets its history after ~3 prompts" report end-to-end,
 * against the REAL agent loop (not a hand-built AgentResult). It drives a live
 * two-turn flow through the faux LLM + a real tool, persists turn 1 exactly the
 * way the CLI call sites do (content = final answer, richContent = the tool
 * trace via reconstructTurnBlocks), then builds turn 2's context through
 * ConversationContext.buildPreviousMessages and asserts the turn-1 tool result
 * actually reaches the LLM on turn 2.
 *
 * This closes the gap the unit tests leave: those feed the module a synthetic
 * result, whereas this proves the module works on the step shape the live agent
 * emits, and that the persist -> replay wiring recalls it.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { IMessage } from '@bike4mind/common';
import { runAgent } from './harness.js';
import { ConversationContext, reconstructTurnBlocks } from '../../src/context/ConversationContext.js';
import type { Message, Session } from '../../src/storage/types.js';

/** A tool whose result carries a fact that never appears in the prose answer. */
function createLookupTool(fact: string): ICompletionOptionTools {
  return {
    toolFn: vi.fn(async () => fact),
    toolSchema: {
      name: 'lookup_setting',
      description: 'Look up a configuration setting and return its value.',
      parameters: { type: 'object' as const, properties: {}, required: [] },
    },
  };
}

function emptySession(): Session {
  return {
    id: 'e2e-recall-session',
    name: 'recall',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    model: 'faux-model',
    messages: [],
    metadata: { totalTokens: 0, totalCost: 0, toolCallCount: 0 },
  };
}

const BUILD_OPTS = { model: 'faux-model', contextWindow: 200_000 };

/** Stringify the messages a faux LLM call received, for substring assertions. */
function messagesBlob(messages: IMessage[]): string {
  return messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
}

describe('e2e - cross-turn tool-result recall (ConversationContext)', () => {
  it('replays a turn-1 tool result into the LLM messages on turn 2', async () => {
    const fact = 'max_retries=1337';
    const tool = createLookupTool(fact);

    // Turn 1: the model calls the tool, then answers WITHOUT restating the fact.
    const turn1 = await runAgent({
      prompt: 'What is the max_retries setting?',
      tools: [tool],
      script: {
        turns: [
          { text: 'Let me look that up.', toolsUsed: [{ name: 'lookup_setting', arguments: '{}', id: 'call_1' }] },
          { text: 'I have checked the configuration for you.' },
        ],
      },
      maxIterations: 5,
    });

    expect(tool.toolFn).toHaveBeenCalledTimes(1);
    // Precondition: the fact lives ONLY in the tool result, not the prose answer.
    expect(turn1.finalAnswer).not.toContain('1337');

    // Persist turn 1 exactly as the CLI call sites do.
    const session = emptySession();
    const userMessage: Message = {
      id: 'u1',
      role: 'user',
      content: 'What is the max_retries setting?',
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const richContent = reconstructTurnBlocks(turn1.steps, turn1.finalAnswer);
    expect(richContent).toBeDefined(); // the live run produced a tool trace
    const assistantMessage: Message = {
      id: 'a1',
      role: 'assistant',
      content: turn1.finalAnswer,
      ...(richContent ? { richContent } : {}),
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    session.messages.push(userMessage, assistantMessage);

    // Turn 2: build history through the module, run against it.
    const previousMessages = ConversationContext.fromSession(session).buildPreviousMessages(
      'And what did you find?',
      BUILD_OPTS
    );

    const turn2 = await runAgent({
      prompt: 'And what did you find?',
      tools: [tool],
      script: { turns: [{ text: `The max_retries setting is ${fact}.` }] },
      runOptions: { parallelExecution: false, previousMessages },
      maxIterations: 5,
    });

    // The turn-1 tool result reached the LLM on turn 2's first (and only) call.
    expect(turn2.faux.callCount).toBe(1);
    expect(messagesBlob(turn2.faux.callLog[0].messages)).toContain('1337');
  });

  it('does NOT recall the fact when the turn is persisted string-only (the pre-fix behavior)', async () => {
    const fact = 'max_retries=1337';
    const tool = createLookupTool(fact);

    const turn1 = await runAgent({
      prompt: 'What is the max_retries setting?',
      tools: [tool],
      script: {
        turns: [
          { text: 'Let me look that up.', toolsUsed: [{ name: 'lookup_setting', arguments: '{}', id: 'call_1' }] },
          { text: 'I have checked the configuration for you.' },
        ],
      },
      maxIterations: 5,
    });

    // Persist WITHOUT richContent - the old lossy shape (final answer only).
    const session = emptySession();
    session.messages.push(
      { id: 'u1', role: 'user', content: 'What is the max_retries setting?', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'a1', role: 'assistant', content: turn1.finalAnswer, timestamp: '2026-01-01T00:00:00.000Z' }
    );

    const previousMessages = ConversationContext.fromSession(session).buildPreviousMessages(
      'And what did you find?',
      BUILD_OPTS
    );

    const turn2 = await runAgent({
      prompt: 'And what did you find?',
      tools: [tool],
      script: { turns: [{ text: 'answer' }] },
      runOptions: { parallelExecution: false, previousMessages },
      maxIterations: 5,
    });

    // Without the persisted tool trace, the fact is gone by turn 2 - which is
    // exactly the bug richContent fixes.
    expect(messagesBlob(turn2.faux.callLog[0].messages)).not.toContain('1337');
  });
});
