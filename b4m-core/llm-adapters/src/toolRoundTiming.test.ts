import { describe, expect, it, vi } from 'vitest';
import { logToolRound, summarizeToolOutcomes, TOOL_ROUND_LOG_PREFIX, type ToolRoundEntry } from './toolRoundTiming';

const entry: ToolRoundEntry = {
  model: 'test-model',
  round: 0,
  msToFirstChunk: 120,
  modelMs: 300,
  roundMs: 900,
  sinceRequestMs: 900,
  stopReason: 'tool_use',
  tools: [{ name: 'web_search', resultChars: 42 }],
};

const createLogger = () => ({ info: vi.fn(), warn: vi.fn() });

describe('logToolRound', () => {
  it('emits exactly one prefixed line carrying the entry as structured metadata', () => {
    const logger = createLogger();

    logToolRound(logger, entry);

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(TOOL_ROUND_LOG_PREFIX, entry);
  });

  it('logs only names and sizes, never tool arguments or result content', () => {
    const logger = createLogger();
    const secret = 'sk-live-SECRET-VALUE';
    const tools = summarizeToolOutcomes([
      { ok: true, name: 'lookup', result: `token=${secret}` },
      { ok: false, name: 'broken' },
    ]);

    logToolRound(logger, { ...entry, tools });

    const logged = JSON.stringify(logger.info.mock.calls[0]);
    expect(logged).not.toContain(secret);
    expect(tools).toEqual([
      { name: 'lookup', resultChars: `token=${secret}`.length },
      { name: 'broken', resultChars: 0 },
    ]);
  });

  it('measures a result by its toString length, as the backend injects it', () => {
    const result = { toString: () => 'twelve chars' };

    expect(summarizeToolOutcomes([{ ok: true, name: 'obj', result }])[0].resultChars).toBe(12);
  });

  it('does not throw when measuring a result throws', () => {
    const result = {
      toString: () => {
        throw new Error('no string form');
      },
    };

    expect(summarizeToolOutcomes([{ ok: true, name: 'bad', result }])).toEqual([{ name: 'bad', resultChars: 0 }]);
  });

  it('does not throw when the logger throws, and warns once', () => {
    const logger = {
      info: vi.fn(() => {
        throw new Error('sink down');
      }),
      warn: vi.fn(),
    };

    expect(() => logToolRound(logger, entry)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not throw when both logger methods throw', () => {
    const boom = vi.fn(() => {
      throw new Error('sink down');
    });

    expect(() => logToolRound({ info: boom, warn: boom }, entry)).not.toThrow();
  });
});
