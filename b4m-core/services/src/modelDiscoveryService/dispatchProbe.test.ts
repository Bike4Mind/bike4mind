import { describe, expect, it } from 'vitest';
import { predictMaxTokensParam, probeOpenAiDispatch } from './dispatchProbe';
import type { DispatchProbeDeps } from './types';

interface Call {
  url: string;
  body: Record<string, unknown>;
  signal?: AbortSignal | null;
}

interface Reply {
  status: number;
  body?: unknown;
  /** Stands in for a transport error or the per-call timeout firing. */
  throws?: boolean;
}

/** Replies in order, one per call, and records what was sent. */
function stubFetch(replies: Reply[]): { deps: DispatchProbeDeps; calls: Call[] } {
  const calls: Call[] = [];
  const deps: DispatchProbeDeps = {
    apiKey: 'sk-test',
    timeoutMs: 15_000,
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown>, signal: init.signal });
      const reply = replies[calls.length - 1] ?? { status: 500 };
      if (reply.throws) throw new Error('socket hang up');
      return { status: reply.status, text: async () => JSON.stringify(reply.body ?? {}) };
    },
  };
  return { deps, calls };
}

const TOOL_CALL_200 = {
  status: 200,
  body: { choices: [{ message: { tool_calls: [{ id: 'call_1', function: { name: 'ping', arguments: '{}' } }] } }] },
};
const PROSE_200 = {
  status: 200,
  body: { choices: [{ finish_reason: 'stop', message: { content: 'Calling the tool now...' } }] },
};
/** What a reasoning model returns when the cap ran out inside its own reasoning. */
const TRUNCATED_200 = { status: 200, body: { choices: [{ finish_reason: 'length', message: { content: '' } }] } };
const INCOMPLETE_200 = {
  status: 200,
  body: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning' }] },
};
const FUNCTION_CALL_200 = { status: 200, body: { output: [{ type: 'function_call', name: 'ping' }] } };
const TEXT_ONLY_200 = { status: 200, body: { output: [{ type: 'message', content: [] }] } };

/** What a model that calls functions on chat only with reasoning disabled returns to the forced call. */
const TOOLS_REFUSED_400 = {
  status: 400,
  body: {
    error: {
      param: 'tools',
      message: 'Function tools with reasoning_effort are not supported for this model in /v1/chat/completions.',
    },
  },
};
const PLAIN_200 = { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] } };

const unsupportedParam = (param: string) => ({
  status: 400,
  body: { error: { param, message: `Unsupported parameter: '${param}' is not supported with this model.` } },
});

describe('predictMaxTokensParam', () => {
  it('predicts the modern parameter for a namespace it has never seen', () => {
    expect(predictMaxTokensParam('gpt-6-astra')).toBe('max_completion_tokens');
    expect(predictMaxTokensParam('o5-mini')).toBe('max_completion_tokens');
  });

  it('predicts the legacy parameter for the generations that still take it', () => {
    expect(predictMaxTokensParam('gpt-4.1-turbo')).toBe('max_tokens');
    expect(predictMaxTokensParam('chatgpt-4o-latest')).toBe('max_tokens');
  });
});

describe('probeOpenAiDispatch', () => {
  it('confirms the chat transport from a forced tool call', async () => {
    const { deps, calls } = stubFetch([TOOL_CALL_200]);

    const result = await probeOpenAiDispatch('gpt-6-astra', deps);

    expect(result).toEqual({
      answer: {
        adapterFamily: 'openai-chat',
        dispatchProfile: { maxTokensParam: 'max_completion_tokens', toolTransport: 'chat' },
        maxTokensParamVerified: true,
      },
      retryable: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    // Forcing the function is what makes the answer decisive: a compliant model
    // has no way to reply with prose instead.
    expect(calls[0].body.tool_choice).toEqual({ type: 'function', function: { name: 'ping' } });
    expect(calls[0].body.max_completion_tokens).toBeTypeOf('number');
  });

  it('flips the token parameter once on a 400 that names it', async () => {
    const { deps, calls } = stubFetch([unsupportedParam('max_completion_tokens'), TOOL_CALL_200]);

    const result = await probeOpenAiDispatch('gpt-6-astra', deps);

    expect(result.answer?.dispatchProfile).toEqual({ maxTokensParam: 'max_tokens', toolTransport: 'chat' });
    expect(calls).toHaveLength(2);
    expect(calls[1].body.max_tokens).toBeTypeOf('number');
    expect(calls[1].body).not.toHaveProperty('max_completion_tokens');
  });

  it('gives up on a second 400 about the token parameter', async () => {
    const { deps, calls } = stubFetch([unsupportedParam('max_completion_tokens'), unsupportedParam('max_tokens')]);

    expect(await probeOpenAiDispatch('gpt-6-astra', deps)).toEqual({ retryable: false });
    expect(calls).toHaveLength(2);
  });

  it('treats prose as a definitive negative and asks the responses endpoint', async () => {
    const { deps, calls } = stubFetch([PROSE_200, FUNCTION_CALL_200]);

    const result = await probeOpenAiDispatch('gpt-6-astra', deps);

    expect(result).toEqual({
      answer: {
        adapterFamily: 'openai-responses',
        dispatchProfile: { maxTokensParam: 'max_completion_tokens', toolTransport: 'responses' },
        // The chat call was a 200, so it did validate the parameter it sent.
        maxTokensParamVerified: true,
      },
      retryable: false,
    });
    expect(calls[1].url).toBe('https://api.openai.com/v1/responses');
    // The Responses API takes the flattened tool shape, not the chat nesting.
    expect(calls[1].body.tools).toEqual([expect.objectContaining({ type: 'function', name: 'ping' })]);
    expect(calls[1].body.tool_choice).toEqual({ type: 'function', name: 'ping' });
  });

  it('verifies the token parameter without tools when the chat endpoint refuses them', async () => {
    const { deps, calls } = stubFetch([TOOLS_REFUSED_400, FUNCTION_CALL_200, PLAIN_200]);

    const result = await probeOpenAiDispatch('gpt-6-sol', deps);

    expect(result).toEqual({
      answer: {
        adapterFamily: 'openai-responses',
        dispatchProfile: { maxTokensParam: 'max_completion_tokens', toolTransport: 'responses' },
        maxTokensParamVerified: true,
      },
      retryable: false,
    });
    expect(calls.map(call => call.url)).toEqual([
      'https://api.openai.com/v1/chat/completions',
      'https://api.openai.com/v1/responses',
      'https://api.openai.com/v1/chat/completions',
    ]);
    expect(calls[2].body).not.toHaveProperty('tools');
    expect(calls[2].body).not.toHaveProperty('tool_choice');
    expect(calls[2].body.max_completion_tokens).toBeTypeOf('number');
  });

  it('counts a truncated tool-free reply as proof of the parameter', async () => {
    const { deps } = stubFetch([TOOLS_REFUSED_400, FUNCTION_CALL_200, TRUNCATED_200]);

    expect((await probeOpenAiDispatch('gpt-6-sol', deps)).answer?.maxTokensParamVerified).toBe(true);
  });

  it('flips the parameter once when the tool-free call names it', async () => {
    const { deps, calls } = stubFetch([
      TOOLS_REFUSED_400,
      FUNCTION_CALL_200,
      unsupportedParam('max_completion_tokens'),
      PLAIN_200,
    ]);

    const result = await probeOpenAiDispatch('gpt-6-sol', deps);

    expect(result.answer).toEqual({
      adapterFamily: 'openai-responses',
      dispatchProfile: { maxTokensParam: 'max_tokens', toolTransport: 'responses' },
      maxTokensParamVerified: true,
    });
    expect(calls).toHaveLength(4);
    expect(calls[3].body.max_tokens).toBeTypeOf('number');
    expect(calls[3].body).not.toHaveProperty('max_completion_tokens');
  });

  it('does not undo a flip the forced call already made', async () => {
    const { deps, calls } = stubFetch([
      unsupportedParam('max_completion_tokens'),
      TOOLS_REFUSED_400,
      FUNCTION_CALL_200,
      unsupportedParam('max_tokens'),
    ]);

    const result = await probeOpenAiDispatch('gpt-6-sol', deps);

    expect(result.answer?.dispatchProfile.maxTokensParam).toBe('max_tokens');
    expect(result.answer?.maxTokensParamVerified).toBe(false);
    expect(calls).toHaveLength(4);
  });

  it('leaves the parameter unverified when the tool-free call is refused', async () => {
    // A 200 is the only proof, so the write path must not promote the guess.
    const { deps, calls } = stubFetch([
      TOOLS_REFUSED_400,
      FUNCTION_CALL_200,
      { status: 400, body: { error: { message: 'something else entirely' } } },
    ]);

    const result = await probeOpenAiDispatch('gpt-6-sol', deps);

    expect(result.answer?.dispatchProfile).toEqual({
      maxTokensParam: 'max_completion_tokens',
      toolTransport: 'responses',
    });
    expect(result.answer?.maxTokensParamVerified).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it('flips once and stays unverified when the tool-free call refuses both parameters', async () => {
    const { deps, calls } = stubFetch([
      TOOLS_REFUSED_400,
      FUNCTION_CALL_200,
      unsupportedParam('max_completion_tokens'),
      unsupportedParam('max_tokens'),
    ]);

    const result = await probeOpenAiDispatch('gpt-6-sol', deps);

    expect(result.answer?.dispatchProfile.maxTokensParam).toBe('max_tokens');
    expect(result.answer?.maxTokensParamVerified).toBe(false);
    expect(calls).toHaveLength(4);
  });

  it('reads a 422 on the tool-free call as a verdict, not as retryable', async () => {
    const { deps } = stubFetch([TOOLS_REFUSED_400, FUNCTION_CALL_200, { status: 422 }]);

    const result = await probeOpenAiDispatch('gpt-6-sol', deps);

    expect(result.retryable).toBe(false);
    expect(result.answer?.maxTokensParamVerified).toBe(false);
  });

  it('reports a transport failure on the tool-free call as retryable', async () => {
    const { deps } = stubFetch([TOOLS_REFUSED_400, FUNCTION_CALL_200, { status: 0, throws: true }]);

    expect(await probeOpenAiDispatch('gpt-6-sol', deps)).toEqual({ retryable: true });
  });

  it('reports a retryable tool-free call as retryable rather than as an unverified verdict', async () => {
    const { deps } = stubFetch([TOOLS_REFUSED_400, FUNCTION_CALL_200, { status: 429 }]);

    expect(await probeOpenAiDispatch('gpt-6-sol', deps)).toEqual({ retryable: true });
  });

  it('authors no profile when neither endpoint emits a call', async () => {
    const { deps, calls } = stubFetch([PROSE_200, TEXT_ONLY_200]);

    expect(await probeOpenAiDispatch('gpt-6-astra', deps)).toEqual({ retryable: false });
    expect(calls).toHaveLength(2);
  });

  it('stops at a model the account cannot reach', async () => {
    const { deps, calls } = stubFetch([{ status: 404, body: { error: { code: 'model_not_found' } } }]);

    expect(await probeOpenAiDispatch('gpt-6-astra', deps)).toEqual({ retryable: false });
    expect(calls).toHaveLength(1);
  });

  it('treats a truncated chat reply as retryable, not as a definitive negative', async () => {
    // Reasoning tokens count against the cap, so a reasoning model can run out
    // before it emits the call it was forced to make. Reading that as "answered
    // with prose" abandons exactly the model class the probe exists for.
    const { deps, calls } = stubFetch([TRUNCATED_200]);

    expect(await probeOpenAiDispatch('gpt-6-astra', deps)).toEqual({ retryable: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.max_completion_tokens).toBeGreaterThan(4_000);
  });

  it('treats an incomplete responses reply as retryable', async () => {
    const { deps } = stubFetch([PROSE_200, INCOMPLETE_200]);

    expect(await probeOpenAiDispatch('gpt-6-astra', deps)).toEqual({ retryable: true });
  });

  it.each([408, 422])('reports a %i request timeout as retryable rather than as a verdict', async status => {
    const { deps, calls } = stubFetch([{ status, body: { error: { message: 'request timed out' } } }]);

    expect(await probeOpenAiDispatch('gpt-6-astra', deps)).toEqual({ retryable: true });
    expect(calls).toHaveLength(1);
  });

  it('reports a rate limit as retryable rather than as a verdict', async () => {
    const { deps, calls } = stubFetch([{ status: 429, body: { error: { message: 'rate limit' } } }]);

    expect(await probeOpenAiDispatch('gpt-6-astra', deps)).toEqual({ retryable: true });
    expect(calls).toHaveLength(1);
  });

  it('carries the run deadline into the call, alongside the per-call timeout', async () => {
    const { deps, calls } = stubFetch([TOOL_CALL_200]);
    const run = new AbortController();

    await probeOpenAiDispatch('gpt-6-astra', { ...deps, signal: run.signal });
    expect(calls[0].signal?.aborted).toBe(false);

    run.abort();
    expect(calls[0].signal?.aborted).toBe(true);
  });

  it('reports a transport failure as retryable', async () => {
    const { deps } = stubFetch([{ status: 0, throws: true }]);

    expect(await probeOpenAiDispatch('gpt-6-astra', deps)).toEqual({ retryable: true });
  });
});
