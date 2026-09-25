/**
 * Regression test for #3253: mermaid_chart (and any TOOL_ARTIFACT_EMITTERS tool) replies
 * rendered the artifact card twice on Anthropic. handleToolResultStreaming streams the tool's
 * raw markup to the client as one card; unlike openaiBackend, AnthropicBackend never stripped
 * that markup from the tool_result pushed into history, so a model that echoed the tag back in
 * its synthesized reply produced a second (empty) card. The fix mirrors openaiBackend's two
 * layers: strip the tool_result before it re-enters history, and strip any echo from the
 * recursive completion's buffered text before it reaches the client.
 *
 * A first pass at the recursive-buffer layer indiscriminately stripped every <artifact> tag from
 * the buffered text, which is wrong for a backend (unlike OpenAI) that keeps tools available on
 * the recursive call to enable chaining: a genuinely NEW artifact from a second, chained tool call
 * would land in the same buffer and get deleted along with the echo. The three tests below pin
 * the corrected behavior: chained artifacts survive, the terminal token/usage metadata is never
 * silently dropped even when the buffered text ends up empty, and a stray "<artifact" the model's
 * own prose merely mentions doesn't truncate the rest of a legitimate reply.
 */
import { describe, it, expect } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import type { ICompletionOptions, ICompletionOptionTools } from './backend';

const MERMAID_ARTIFACT =
  '<artifact identifier="mermaid-1" type="application/vnd.ant.mermaid" title="Flow">graph TD;A-->B</artifact>';
const RECHARTS_ARTIFACT =
  '<artifact identifier="chart-1" type="application/vnd.ant.recharts" title="Bar">{"data":[]}</artifact>';

type CapturedParams = Record<string, unknown>;

function asyncIterable(events: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    controller: { abort: () => {} },
  };
}

/** Non-streaming mock: each call to messages.create returns the next entry in `turns`. */
function buildNonStreamingBackend(turns: unknown[]) {
  const backend = new AnthropicBackend('test-key');
  const captured: CapturedParams[] = [];
  (backend as unknown as { _api: unknown })._api = {
    messages: {
      create: async (apiParams: Record<string, unknown>) => {
        captured.push(apiParams);
        const turn = turns[captured.length - 1];
        if (!turn) throw new Error(`No mock for call ${captured.length}`);
        return turn;
      },
    },
  };
  return { backend, getCaptured: () => captured };
}

/** Streaming mock: each call to messages.create returns the next SSE-event sequence in `turns`. */
function buildStreamingBackend(turns: unknown[][]) {
  const backend = new AnthropicBackend('test-key');
  const captured: CapturedParams[] = [];
  (backend as unknown as { _api: unknown })._api = {
    messages: {
      create: async (apiParams: Record<string, unknown>) => {
        captured.push(apiParams);
        const turn = turns[captured.length - 1];
        if (!turn) throw new Error(`No mock for call ${captured.length}`);
        return asyncIterable(turn);
      },
    },
  };
  return { backend, getCaptured: () => captured };
}

function toolUseTurn(id: string, name: string, input: Record<string, unknown>) {
  return { content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 10, output_tokens: 5 } };
}

function textTurn(text: string, usage: { input: number; output: number } = { input: 10, output: 5 }) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: usage.input, output_tokens: usage.output },
    stop_reason: 'end_turn',
  };
}

function textAndToolUseTurn(text: string, id: string, name: string, input: Record<string, unknown>) {
  return {
    content: [
      { type: 'text', text },
      { type: 'tool_use', id, name, input },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function streamingToolUseTurn(id: string, name: string, input: Record<string, unknown>) {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
}

function streamingTextTurn(text: string) {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
}

function makeTool(name: string, artifact: string): ICompletionOptionTools {
  return {
    toolSchema: {
      name,
      description: `Generate a ${name} artifact`,
      parameters: { type: 'object', properties: { definition: { type: 'string' } }, required: ['definition'] },
    },
    // Mirrors the real artifact tools: returns raw artifact markup directly so
    // handleToolResultStreaming can stream it immediately.
    toolFn: async () => artifact,
  };
}

const mermaidTool = makeTool('mermaid_chart', MERMAID_ARTIFACT);
const rechartsTool = makeTool('recharts', RECHARTS_ARTIFACT);

interface CapturedCb {
  text: (string | null | undefined)[];
  info?: { inputTokens?: number; outputTokens?: number };
}

function captureCb() {
  const calls: CapturedCb[] = [];
  return {
    calls,
    cb: async (text: (string | null | undefined)[], info?: CapturedCb['info']) => {
      calls.push({ text, info });
    },
  };
}

function clientText(calls: CapturedCb[]): string {
  return calls
    .flatMap(c => c.text)
    .filter((r): r is string => typeof r === 'string')
    .join('');
}

async function runComplete(
  backend: AnthropicBackend,
  options: Partial<ICompletionOptions>,
  cb: (text: (string | null | undefined)[], info?: CapturedCb['info']) => Promise<void>
): Promise<void> {
  await backend.complete(
    ChatModels.CLAUDE_4_8_OPUS,
    [{ role: 'user', content: 'a simple process flow diagram' }],
    options,
    cb
  );
}

describe('AnthropicBackend does not duplicate an echoed tool artifact card (#3253)', () => {
  it('non-streaming: strips the artifact tag from history and from an echoed recursive reply', async () => {
    const { backend, getCaptured } = buildNonStreamingBackend([
      toolUseTurn('call_1', 'mermaid_chart', { definition: 'graph TD;A-->B' }),
      textTurn(`Here is your diagram:\n\n${MERMAID_ARTIFACT}`),
    ]);
    const { calls, cb } = captureCb();

    await runComplete(backend, { stream: false, tools: [mermaidTool] }, cb);

    const artifactTagCount = (clientText(calls).match(/<artifact\b/g) || []).length;
    // Exactly one card should ever reach the client - the one handleToolResultStreaming
    // streamed from the tool result itself, not a second one from the model's echo.
    expect(artifactTagCount).toBe(1);

    // The recursive (turn 2) request must never see the raw tag in its own history -
    // otherwise a real model could keep re-echoing it turn after turn.
    const turn2Serialized = JSON.stringify(getCaptured()[1]);
    expect(turn2Serialized).not.toContain('<artifact');
    expect(turn2Serialized).toContain('[Artifact rendered and delivered to user]');
  });

  it('streaming: strips the artifact tag from history and from an echoed recursive reply', async () => {
    const { backend, getCaptured } = buildStreamingBackend([
      streamingToolUseTurn('call_1', 'mermaid_chart', { definition: 'graph TD;A-->B' }),
      streamingTextTurn(`Here is your diagram:\n\n${MERMAID_ARTIFACT}`),
    ]);
    const { calls, cb } = captureCb();

    await runComplete(backend, { stream: true, tools: [mermaidTool] }, cb);

    const artifactTagCount = (clientText(calls).match(/<artifact\b/g) || []).length;
    expect(artifactTagCount).toBe(1);

    const turn2Serialized = JSON.stringify(getCaptured()[1]);
    expect(turn2Serialized).not.toContain('<artifact');
    expect(turn2Serialized).toContain('[Artifact rendered and delivered to user]');
  });

  it('a chained SECOND artifact tool call in the same turn is not swallowed by the echo backstop', async () => {
    // Anthropic keeps tools available on the recursive call to enable chaining - unlike OpenAI,
    // which drops built-in tools after any tool call. So a model can legitimately call a second
    // artifact tool in its "recursive" turn; that card must survive even though the echo
    // backstop is buffering that same turn's text.
    const { backend } = buildNonStreamingBackend([
      toolUseTurn('call_1', 'mermaid_chart', { definition: 'graph TD;A-->B' }),
      toolUseTurn('call_2', 'recharts', { definition: '{}' }),
      textTurn('Here are both visualizations.'),
    ]);
    const { calls, cb } = captureCb();

    await runComplete(backend, { stream: false, tools: [mermaidTool, rechartsTool] }, cb);

    const text = clientText(calls);
    expect((text.match(/<artifact\b/g) || []).length).toBe(2);
    expect(text).toContain('identifier="mermaid-1"');
    expect(text).toContain('identifier="chart-1"');
  });

  it('still emits the terminal token/usage metadata when the post-artifact reply is only the echo', async () => {
    // This is the literal #3253 scenario: the model's entire final-turn text is nothing but the
    // echoed tag. The buffered+stripped text is empty, so no empty message should reach the
    // client - but the terminal call's accumulated token totals must still arrive, or credit
    // attribution for this turn silently falls back to zero.
    const { backend } = buildNonStreamingBackend([
      toolUseTurn('call_1', 'mermaid_chart', { definition: 'graph TD;A-->B' }),
      textTurn(MERMAID_ARTIFACT, { input: 37, output: 11 }),
    ]);
    const { calls, cb } = captureCb();

    await runComplete(backend, { stream: false, tools: [mermaidTool] }, cb);

    // The echoed tag itself never reached the client as reply text (only as the one card
    // already streamed from the tool result).
    expect((clientText(calls).match(/<artifact\b/g) || []).length).toBe(1);

    // The terminal call still carries this turn's accumulated token totals - it must not be
    // silently dropped just because the buffered, stripped reply text ended up empty.
    const last = calls[calls.length - 1];
    expect(last.info?.inputTokens).toBeGreaterThanOrEqual(37);
    expect(last.info?.outputTokens).toBeGreaterThanOrEqual(11);
  });

  it('pin: a chained tool call artifact reaches the client AFTER the text that introduces it, not before', async () => {
    // Regression: the chained artifact used to escape straight to the client via a root-pinned
    // callback while the guard was still buffering the sentence meant to introduce it, reversing
    // the order the model actually generated them in.
    const { backend } = buildNonStreamingBackend([
      toolUseTurn('call_1', 'mermaid_chart', { definition: 'graph TD;A-->B' }),
      textAndToolUseTurn("Here's the second chart:", 'call_2', 'recharts', { definition: '{}' }),
      textTurn('Done.'),
    ]);
    const { calls, cb } = captureCb();

    await runComplete(backend, { stream: false, tools: [mermaidTool, rechartsTool] }, cb);

    const text = clientText(calls);
    const introIndex = text.indexOf("Here's the second chart:");
    const chartIndex = text.indexOf('identifier="chart-1"');
    expect(introIndex).toBeGreaterThanOrEqual(0);
    expect(chartIndex).toBeGreaterThan(introIndex);
  });

  it('pin: a genuinely NEW artifact the model composes in its own reply text is not mistaken for an echo', async () => {
    // Regression: the echo backstop used to strip EVERY complete <artifact> block from the
    // buffered reply, not just ones matching an artifact already delivered this turn - so a
    // model-authored artifact with a different identifier was silently deleted.
    const NEW_ARTIFACT =
      '<artifact identifier="mermaid-2" type="application/vnd.ant.mermaid" title="Second">graph TD;C-->D</artifact>';
    const { backend } = buildNonStreamingBackend([
      toolUseTurn('call_1', 'mermaid_chart', { definition: 'graph TD;A-->B' }),
      textTurn(`Here's another one I drew myself:\n\n${NEW_ARTIFACT}`),
    ]);
    const { calls, cb } = captureCb();

    await runComplete(backend, { stream: false, tools: [mermaidTool] }, cb);

    const text = clientText(calls);
    expect(text).toContain('identifier="mermaid-1"');
    expect(text).toContain('identifier="mermaid-2"');
  });

  it('does not truncate the rest of a legitimate reply that merely mentions a stray "<artifact"', async () => {
    // The model's own prose (e.g. reasoning about not repeating the tag) can contain a bare,
    // unclosed "<artifact" that never forms a real tag. The echo backstop must only remove
    // COMPLETE, well-formed blocks and leave everything else - including text after the stray
    // opener - untouched, unlike the tool-output-facing stripToolArtifactMarkup.
    const reply =
      "I won't repeat the <artifact tag since it was already delivered. Here's a summary of the flow instead.";
    const { backend } = buildNonStreamingBackend([
      toolUseTurn('call_1', 'mermaid_chart', { definition: 'graph TD;A-->B' }),
      textTurn(reply),
    ]);
    const { calls, cb } = captureCb();

    await runComplete(backend, { stream: false, tools: [mermaidTool] }, cb);

    expect(clientText(calls)).toContain("Here's a summary of the flow instead.");
  });
});
