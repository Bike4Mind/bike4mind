/**
 * E2E smoke tests for the agent loop.
 *
 * The minimal proof-of-life suite for the harness. If any of these fail,
 * the harness itself is broken - keep them small, deterministic, and fast.
 *
 * Once the harness is proven, more golden-path tests land in sibling
 * files (tool-call.test.ts, fallback.test.ts, etc.).
 */

import { describe, it, expect } from 'vitest';
import { runAgent, runAgentText } from './harness.js';

describe('e2e harness — smoke', () => {
  it('runs a single-turn text completion', async () => {
    const answer = await runAgentText('Say hello', 'Hello, world.');
    expect(answer).toBe('Hello, world.');
  });

  it('exposes faux backend state for assertions', async () => {
    const result = await runAgent({
      prompt: 'Anything',
      script: { turns: [{ text: 'OK' }] },
    });

    expect(result.finalAnswer).toBe('OK');
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(result.faux.callCount).toBe(1);
    expect(result.faux.callLog).toHaveLength(1);
    expect(result.faux.turnsRemaining).toBe(0);
  });

  it('passes the prompt and system prompt through to the LLM', async () => {
    const result = await runAgent({
      prompt: 'Hello there',
      systemPrompt: 'You are a friendly tester.',
      script: { turns: [{ text: 'General Kenobi' }] },
    });

    const messages = result.faux.callLog[0].messages;
    const userMessage = messages.find(m => m.role === 'user');
    expect(userMessage?.content).toContain('Hello there');
  });

  it('captures emitted events in order', async () => {
    const result = await runAgent({
      prompt: 'do nothing',
      script: { turns: [{ text: 'done' }] },
    });

    const types = result.events.map(e => e.type);
    expect(types).toContain('complete');
    // Events must be strictly ordered by .order field.
    for (let i = 1; i < result.events.length; i++) {
      expect(result.events[i].order).toBeGreaterThan(result.events[i - 1].order);
    }
  });

  it('throws when script is exhausted (default behavior catches over-runs)', async () => {
    // Two-turn agent flow but only one scripted turn - should surface as a clear error,
    // not a silent hang or weird agent behavior.
    await expect(
      runAgent({
        prompt: 'go',
        script: {
          turns: [{ toolsUsed: [{ name: 'nonexistent_tool', arguments: '{}' }] }],
          // onExhausted defaults to 'throw'
        },
        // Tool isn't registered, so the agent will get back a tool error and try
        // a second LLM call - which will hit the exhausted script.
        maxIterations: 3,
      })
    ).rejects.toThrow(/Script exhausted/);
  });

  it('settles cleanly when onExhausted is "echo-final"', async () => {
    const result = await runAgent({
      prompt: 'go',
      script: {
        turns: [{ text: 'final answer' }],
        onExhausted: 'echo-final',
      },
    });

    expect(result.finalAnswer).toBe('final answer');
  });
});
