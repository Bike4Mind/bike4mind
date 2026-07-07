import { describe, it, expect } from 'vitest';
import type { AgentResult, AgentStep } from '@bike4mind/agents';
import type { MessageContentObject } from '@bike4mind/common';
import { ConversationContext, DEFAULT_TOOL_TRACE_REPLAY_TOKENS } from './ConversationContext.js';
import { getTokenCounter } from '../utils/tokenCounter.js';
import type { Message, Session } from '../storage/types.js';

const counter = getTokenCounter();

function session(messages: Message[]): Session {
  return {
    id: 'test-session',
    name: 'Test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    model: 'claude-sonnet',
    messages,
    metadata: { totalTokens: 0, totalCost: 0, toolCallCount: 0 },
  };
}

function msg(role: Message['role'], content: string, i: number, richContent?: MessageContentObject[]): Message {
  return {
    id: `m-${i}`,
    role,
    content,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...(richContent ? { richContent } : {}),
  };
}

/** Build an AgentResult whose steps encode the given tool calls plus a final answer. */
function result(finalAnswer: string, tools: Array<{ name: string; input: unknown; result: string }> = []): AgentResult {
  const steps: AgentStep[] = [];
  for (const t of tools) {
    steps.push({ type: 'action', content: t.name, metadata: { toolName: t.name, toolInput: t.input, timestamp: 0 } });
    steps.push({ type: 'observation', content: t.result, metadata: { timestamp: 0 } });
  }
  steps.push({ type: 'final_answer', content: finalAnswer, metadata: { timestamp: 0 } });
  return {
    finalAnswer,
    steps,
    completionInfo: {
      totalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      iterations: 1,
      toolCalls: tools.length,
      reachedMaxIterations: false,
    },
  };
}

/** Sum the token cost of every message in a built turn. */
function totalTokens(messages: { content: unknown }[]): number {
  return messages.reduce((sum, m) => sum + counter.countMessageContent(m.content as never), 0);
}

const OPTS = { model: 'claude-sonnet', contextWindow: 200_000 };

describe('ConversationContext', () => {
  describe('recordTurn + tool-result survival (the "forgetting" regression)', () => {
    it('replays a turn-1 tool result into the messages built for turn 2', () => {
      const ctx = ConversationContext.fromSession(session([]));

      // Turn 1: the agent read a file; the useful fact lives only in the tool
      // result, NOT in the prose final answer.
      ctx.recordTurn({
        userInput: 'what is in config.json?',
        result: result('I checked the file for you.', [
          { name: 'file_read', input: { path: 'config.json' }, result: 'PORT=BEACON_4242' },
        ]),
      });

      const built = ctx.buildTurnMessages('and the port?', OPTS);
      const blob = built.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

      // The tool result survived even though the prose never mentioned it.
      expect(blob).toContain('PORT=BEACON_4242');
      expect(blob).toContain('file_read');
    });

    it('persists tool_use / tool_result blocks with paired ids on the assistant message', () => {
      const ctx = ConversationContext.fromSession(session([]));
      ctx.recordTurn({
        userInput: 'do it',
        result: result('done', [{ name: 'grep_search', input: { q: 'foo' }, result: 'Found 3 files' }]),
      });

      const assistant = ctx.toSession().messages.find(m => m.role === 'assistant')!;
      expect(assistant.content).toBe('done'); // display string preserved
      const blocks = assistant.richContent!;
      const use = blocks.find(b => b.type === 'tool_use')!;
      const res = blocks.find(b => b.type === 'tool_result')!;
      expect(use.type).toBe('tool_use');
      expect(use.name).toBe('grep_search');
      expect(res.type === 'tool_result' && res.tool_use_id).toBe(use.type === 'tool_use' && use.id);
      expect(blocks.some(b => b.type === 'text' && b.text === 'done')).toBe(true);
    });

    it('leaves a no-tool turn string-only (no richContent)', () => {
      const ctx = ConversationContext.fromSession(session([]));
      ctx.recordTurn({ userInput: 'hi', result: result('hello there') });
      const assistant = ctx.toSession().messages.find(m => m.role === 'assistant')!;
      expect(assistant.richContent).toBeUndefined();
      expect(assistant.content).toBe('hello there');
    });
  });

  describe('legacy back-compat round-trip', () => {
    it('reads a legacy string-only session and round-trips through toSession', () => {
      const legacy = session([
        msg('user', 'first', 0),
        msg('assistant', 'first reply', 1),
        msg('user', 'second', 2),
        msg('assistant', 'second reply', 3),
      ]);

      const out = ConversationContext.fromSession(legacy).toSession();

      // Messages preserved verbatim (updatedAt is refreshed, so compare messages only).
      expect(out.messages).toEqual(legacy.messages);
      expect(out.id).toBe(legacy.id);
    });

    it('maps legacy messages to plain string IMessages when building a turn', () => {
      const ctx = ConversationContext.fromSession(
        session([msg('user', 'first', 0), msg('assistant', 'first reply', 1)])
      );
      const built = ctx.buildTurnMessages('next', OPTS);
      expect(built).toEqual([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'first reply' },
        { role: 'user', content: 'next' },
      ]);
    });

    it('only replays user and assistant roles (drops system messages)', () => {
      const ctx = ConversationContext.fromSession(
        session([msg('system', 'sys note', 0), msg('user', 'hi', 1), msg('assistant', 'yo', 2)])
      );
      const built = ctx.buildTurnMessages('again', OPTS);
      expect(built.some(m => typeof m.content === 'string' && m.content.includes('sys note'))).toBe(false);
      expect(built).toHaveLength(3); // user + assistant + current input
    });
  });

  describe('token-aware windowing', () => {
    // Ten exchanges, each tagged so we can tell which survived windowing.
    function tenTurns(): Session {
      const messages: Message[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push(msg('user', `question number ${i} with some padding words here`, i * 2));
        messages.push(msg('assistant', `answer number ${i} with some padding words here`, i * 2 + 1));
      }
      return session(messages);
    }

    it('never exceeds the token budget for the given contextWindow', () => {
      const ctx = ConversationContext.fromSession(tenTurns());
      const contextWindow = 50;
      const reservedTokens = 0;
      const built = ctx.buildTurnMessages('current question', { model: 'm', contextWindow, reservedTokens });
      expect(totalTokens(built)).toBeLessThanOrEqual(contextWindow);
      // The budget is tight enough that windowing actually dropped something.
      expect(built.length).toBeLessThan(21);
    });

    it('drops the oldest turns first, keeping the most recent', () => {
      const ctx = ConversationContext.fromSession(tenTurns());
      const built = ctx.buildTurnMessages('current', { model: 'm', contextWindow: 50, reservedTokens: 0 });
      const blob = built.map(m => m.content as string).join('\n');
      // Newest kept, oldest dropped.
      expect(blob).toContain('number 9');
      expect(blob).not.toContain('number 0');
      // Whatever survived is a contiguous most-recent window.
      expect(blob).toContain('current');
    });

    it('never drops the current input, even when the budget is exhausted', () => {
      const ctx = ConversationContext.fromSession(tenTurns());
      // Reserve more than the whole window so no history can fit.
      const built = ctx.buildTurnMessages('the only thing that must survive', {
        model: 'm',
        contextWindow: 100,
        reservedTokens: 100_000,
      });
      expect(built).toHaveLength(1);
      expect(built[0]).toEqual({ role: 'user', content: 'the only thing that must survive' });
    });

    it('includes all history when the window is large', () => {
      const ctx = ConversationContext.fromSession(tenTurns());
      const built = ctx.buildTurnMessages('current', OPTS);
      expect(built).toHaveLength(21); // 20 history + current
    });
  });

  describe('bounded tool-trace replay', () => {
    it('caps the replayed tool trace at the configured budget', () => {
      const ctx = ConversationContext.fromSession(session([]));
      const bigResult = 'x'.repeat(5_000);
      ctx.recordTurn({
        userInput: 'run many tools',
        result: result('all done', [
          { name: 'a', input: {}, result: bigResult },
          { name: 'b', input: {}, result: bigResult },
          { name: 'c', input: {}, result: bigResult },
          { name: 'd', input: {}, result: bigResult },
        ]),
      });

      const toolTraceReplayTokens = 60;
      const built = ctx.buildTurnMessages('next', { model: 'm', contextWindow: 200_000, toolTraceReplayTokens });
      const assistant = built.find(m => m.role === 'assistant')!;
      const content = assistant.content as string;

      // The final answer always survives...
      expect(content).toContain('all done');
      // ...but the trace is bounded and says so.
      expect(content).toContain('omitted');

      // The trace section itself stays within budget (plus the single line that
      // tripped the cap and the "omitted" note).
      const traceSection = content.split('<tool-trace>')[1] ?? '';
      expect(counter.countTokens(traceSection)).toBeLessThan(toolTraceReplayTokens * 3);
    });

    it('uses a sane default replay budget', () => {
      expect(DEFAULT_TOOL_TRACE_REPLAY_TOKENS).toBeGreaterThan(0);
    });
  });

  describe('multimodal user input', () => {
    it('preserves image blocks losslessly and replays them as-is', () => {
      const ctx = ConversationContext.fromSession(session([]));
      const blocks: MessageContentObject[] = [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ];
      ctx.recordTurn({ userInput: blocks, result: result('nice image') });

      const userMessage = ctx.toSession().messages.find(m => m.role === 'user')!;
      expect(userMessage.content).toBe('look at this'); // display text derived
      expect(userMessage.richContent).toEqual(blocks); // blocks preserved

      const built = ctx.buildTurnMessages('follow up', OPTS);
      const replayedUser = built.find(m => Array.isArray(m.content))!;
      expect(replayedUser.content).toEqual(blocks);
    });
  });
});
