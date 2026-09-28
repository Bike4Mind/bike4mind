import { describe, it, expect, vi } from 'vitest';
import { ARTIFACT_DELIVERED_PLACEHOLDER, ARTIFACT_REMOVED_PLACEHOLDER } from '@bike4mind/common';
import {
  handleToolResultStreaming,
  createRecursiveArtifactGuard,
  stripUnstreamedToolResult,
} from './toolStreamingHelper';

const CHESS_ARTIFACT =
  '<artifact identifier="game-1" type="application/vnd.ant.chess" title="Chess Game">{"fen":"8/8/8/8/8/8/8/8 w - - 0 1"}</artifact>';
const MERMAID_ARTIFACT =
  '<artifact identifier="flow" type="application/vnd.ant.mermaid" title="Flow">graph TD; A-->B</artifact>';

const streamed = async (toolName: string, result: unknown) => {
  const callback = vi.fn(async (_results: string[]) => {});
  await handleToolResultStreaming(toolName, result, callback);
  return callback.mock.calls.map(([results]) => results);
};

describe('handleToolResultStreaming: only emitting tools stream, and only their own artifact type', () => {
  it.each([
    ['a non-emitting native tool', 'dice_roll'],
    ['an MCP tool', 'files__read'],
  ])('does not stream artifact markup returned by %s', async (_label, toolName) => {
    expect(await streamed(toolName, `Page says: ${CHESS_ARTIFACT}`)).toEqual([]);
  });

  it('pin: streams an emitting tool result carrying its own artifact type', async () => {
    const result = `Here's the diagram:\n${MERMAID_ARTIFACT}`;

    expect(await streamed('mermaid_chart', result)).toEqual([[result]]);
  });

  it('strips tags of any other type from an emitting tool result, including a repeated type attribute', async () => {
    const result = [
      CHESS_ARTIFACT,
      '<artifact identifier="dup" type="application/vnd.ant.mermaid" type="text/html" title="Dup"><p>x</p></artifact>',
      MERMAID_ARTIFACT,
    ].join('\n');

    expect(await streamed('mermaid_chart', result)).toEqual([[`\n\n${MERMAID_ARTIFACT}`]]);
  });

  it('does not stream an emitting tool result holding an unclosed artifact opener', async () => {
    const result = `${MERMAID_ARTIFACT}\n<artifact identifier="x" type="text/html" title="Open"><p>x</p>`;

    expect(await streamed('mermaid_chart', result)).toEqual([]);
  });

  it('pin: does not stream an emitting tool result with no artifact tag', async () => {
    expect(await streamed('chess_engine', 'No moves left.')).toEqual([]);
  });

  it('reads a tag with the reply parser grammar, so a quoted ">" cannot hide a later type attribute', async () => {
    const result =
      '<artifact identifier="q" type="application/vnd.ant.mermaid" title="a>b" type="text/html"><p>x</p></artifact>';

    expect(await streamed('mermaid_chart', result)).toEqual([]);
  });

  it('does not stream a kept tag with another artifact opener nested in its body', async () => {
    const result = MERMAID_ARTIFACT.replace('graph TD', '<ARTIFACT type="text/html">graph TD');

    expect(await streamed('mermaid_chart', result)).toEqual([]);
  });

  it('pin: streams an upper-case tag of the pinned type', async () => {
    const result = MERMAID_ARTIFACT.replace('<artifact', '<ARTIFACT').replace('</artifact>', '</ARTIFACT>');

    expect(await streamed('mermaid_chart', result)).toEqual([[result]]);
  });

  it('scans pathological tool output in linear time', async () => {
    const inputs = [
      `<artifact ${' '.repeat(200_000)}`,
      '<artifact a>'.repeat(50_000),
      `${MERMAID_ARTIFACT}\n`.repeat(20_000),
    ];
    const started = Date.now();
    for (const input of inputs) await streamed('mermaid_chart', input);

    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

// stripToolArtifactMarkup and stripDeliveredArtifactBlocks are tested with their own
// module, co-located at @bike4mind/common's toolArtifactEmitters.test.ts.

describe('stripUnstreamedToolResult: delivered vs removed must agree with what extraction actually delivers', () => {
  it('reports DELIVERED for a result holding only its own pinned type', () => {
    const result = stripUnstreamedToolResult('mermaid_chart', MERMAID_ARTIFACT);

    expect(result).not.toContain('<artifact');
    expect(result).toBe(ARTIFACT_DELIVERED_PLACEHOLDER);
  });

  it('reports REMOVED when extraction skips an upper-case opener', () => {
    const upperCaseArtifact = MERMAID_ARTIFACT.replace('<artifact', '<ARTIFACT');
    expect(stripUnstreamedToolResult('mermaid_chart', upperCaseArtifact)).toBe(ARTIFACT_REMOVED_PLACEHOLDER);
  });

  it('still reports DELIVERED when a valid pinned block is followed by a later malformed opener', () => {
    // filterToolArtifactMarkup would bail to null on the trailing malformed opener and read this
    // as REMOVED, even though sharedToolBuilder's scanArtifactTags already delivered the first block.
    const result = `${MERMAID_ARTIFACT}\n<artifact identifier="x" type="text/html" title="Open"><p>x</p>`;
    const stripped = stripUnstreamedToolResult('mermaid_chart', result);

    expect(stripped).toBe(`${ARTIFACT_DELIVERED_PLACEHOLDER}\n${ARTIFACT_DELIVERED_PLACEHOLDER}`);
    expect(stripped).not.toContain(ARTIFACT_REMOVED_PLACEHOLDER);
  });

  it('reports REMOVED for a result holding only a different type than the tool is pinned to', () => {
    const result = stripUnstreamedToolResult('mermaid_chart', CHESS_ARTIFACT);

    expect(result).not.toContain('<artifact');
    expect(result).toBe(ARTIFACT_REMOVED_PLACEHOLDER);
  });

  it('leaves a result with no artifact markup unchanged', () => {
    expect(stripUnstreamedToolResult('mermaid_chart', 'No diagram needed.')).toBe('No diagram needed.');
  });
});

describe('createRecursiveArtifactGuard: one shared buffer/flush pipe for a whole recursive chain', () => {
  it('buffers text across multiple calls and strips an echo of an already-delivered artifact on flush', async () => {
    const received: Array<{ text: (string | null | undefined)[]; info: unknown }> = [];
    const cb = async (text: (string | null | undefined)[], info: unknown) => {
      received.push({ text, info });
    };
    const guard = createRecursiveArtifactGuard(cb);

    // Simulate the original tool call delivering the diagram before the model echoes it back.
    await guard.emitArtifact([MERMAID_ARTIFACT], { inputTokens: 1, outputTokens: 1 });
    received.length = 0;

    await guard.callback(['Here is your diagram:\n\n'], { inputTokens: 10, outputTokens: 5 });
    await guard.callback([MERMAID_ARTIFACT], { inputTokens: 10, outputTokens: 5 });
    await guard.callback([null], { inputTokens: 20, outputTokens: 12 });
    await guard.flush();

    expect(received).toHaveLength(1);
    expect(received[0].text).toEqual(['Here is your diagram:']);
    // Last-write-wins: the terminal call's accumulated totals are what gets flushed, not the
    // first partial one.
    expect(received[0].info).toEqual({ inputTokens: 20, outputTokens: 12 });
  });

  it('pin: keeps a genuinely NEW artifact the model composes in its own reply text, even complete and well-formed', async () => {
    const received: Array<{ text: (string | null | undefined)[]; info: unknown }> = [];
    const cb = async (text: (string | null | undefined)[], info: unknown) => {
      received.push({ text, info });
    };
    const guard = createRecursiveArtifactGuard(cb);

    await guard.emitArtifact([CHESS_ARTIFACT], { inputTokens: 1, outputTokens: 1 });
    received.length = 0;

    // A DIFFERENT artifact (a different identifier) the model composes itself must survive -
    // it is not an echo of the one already delivered.
    await guard.callback([`Here's a second one:\n\n${MERMAID_ARTIFACT}`], { inputTokens: 5, outputTokens: 5 });
    await guard.flush();

    expect(received).toHaveLength(1);
    expect(received[0].text).toEqual([`Here's a second one:\n\n${MERMAID_ARTIFACT}`]);
  });

  it('still flushes the terminal metadata even when the buffered text ends up empty', async () => {
    const received: Array<{ text: (string | null | undefined)[]; info: unknown }> = [];
    const cb = async (text: (string | null | undefined)[], info: unknown) => {
      received.push({ text, info });
    };
    const guard = createRecursiveArtifactGuard(cb);

    await guard.emitArtifact([MERMAID_ARTIFACT], { inputTokens: 1, outputTokens: 1 });
    received.length = 0;

    // The model's entire follow-up reply was just the echoed tag - buffer strips down to nothing.
    await guard.callback([MERMAID_ARTIFACT], { inputTokens: 37, outputTokens: 11, toolsUsed: [] });
    await guard.flush();

    expect(received).toHaveLength(1);
    expect(received[0].text).toEqual([]);
    expect(received[0].info).toMatchObject({ inputTokens: 37, outputTokens: 11 });
  });

  it('never calls the real callback for buffered text before flush or emitArtifact', async () => {
    const cb = vi.fn(async () => {});
    const guard = createRecursiveArtifactGuard(cb);

    await guard.callback(['partial'], { inputTokens: 1, outputTokens: 1 });
    expect(cb).not.toHaveBeenCalled();

    await guard.flush();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('emitArtifact sends the artifact straight through, unbuffered and unscrubbed', async () => {
    const cb = vi.fn(async () => {});
    const guard = createRecursiveArtifactGuard(cb);

    await guard.emitArtifact([MERMAID_ARTIFACT], { inputTokens: 1, outputTokens: 1 });

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith([MERMAID_ARTIFACT], { inputTokens: 1, outputTokens: 1 });
  });

  it('pin: emitArtifact flushes buffered text BEFORE the artifact, so a chained tool call keeps generation order', async () => {
    const received: Array<{ text: (string | null | undefined)[]; info: unknown }> = [];
    const cb = async (text: (string | null | undefined)[], info: unknown) => {
      received.push({ text, info });
    };
    const guard = createRecursiveArtifactGuard(cb);

    await guard.emitArtifact([MERMAID_ARTIFACT], { inputTokens: 1, outputTokens: 1 });
    received.length = 0;

    // The model narrates a second chart, THEN calls the tool that produces it - without the
    // guard flushing first, the chart would reach the client before its own introduction.
    await guard.callback(["Here's the second chart."], { inputTokens: 2, outputTokens: 2 });
    await guard.emitArtifact([CHESS_ARTIFACT], { inputTokens: 3, outputTokens: 3 });

    expect(received).toHaveLength(2);
    expect(received[0].text).toEqual(["Here's the second chart."]);
    expect(received[1].text).toEqual([CHESS_ARTIFACT]);
  });

  it('pin: a second flush() call is a no-op, so a future double-call cannot resend the buffered reply and its terminal metadata a second time', async () => {
    const received: Array<{ text: (string | null | undefined)[]; info: unknown }> = [];
    const cb = async (text: (string | null | undefined)[], info: unknown) => {
      received.push({ text, info });
    };
    const guard = createRecursiveArtifactGuard(cb);

    await guard.callback(['Hello.'], { inputTokens: 1, outputTokens: 1 });
    await guard.flush();
    await guard.flush();

    expect(received).toHaveLength(1);
    expect(received[0].text).toEqual(['Hello.']);
  });

  it('a later echo of a chained artifact is also stripped on the final flush', async () => {
    const received: Array<{ text: (string | null | undefined)[]; info: unknown }> = [];
    const cb = async (text: (string | null | undefined)[], info: unknown) => {
      received.push({ text, info });
    };
    const guard = createRecursiveArtifactGuard(cb);

    await guard.emitArtifact([MERMAID_ARTIFACT], { inputTokens: 1, outputTokens: 1 });
    await guard.callback(["Here's the second chart."], { inputTokens: 2, outputTokens: 2 });
    await guard.emitArtifact([CHESS_ARTIFACT], { inputTokens: 3, outputTokens: 3 });
    received.length = 0;

    // The model echoes the chess artifact it just saw delivered.
    await guard.callback([`Thanks for watching. ${CHESS_ARTIFACT}`], { inputTokens: 4, outputTokens: 4 });
    await guard.flush();

    expect(received).toHaveLength(1);
    expect(received[0].text).toEqual(['Thanks for watching.']);
  });
});
