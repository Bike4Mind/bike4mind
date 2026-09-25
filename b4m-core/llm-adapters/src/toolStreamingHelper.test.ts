import { describe, it, expect, vi } from 'vitest';
import { stripToolArtifactMarkup, stripDeliveredArtifactBlocks } from '@bike4mind/common';
import { handleToolResultStreaming, createRecursiveArtifactGuard } from './toolStreamingHelper';

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

describe('stripToolArtifactMarkup: the model never sees tool artifact markup it could echo', () => {
  const P = '[removed]';

  it('replaces every block, keeps surrounding text, and leaves markup-free text untouched', () => {
    expect(stripToolArtifactMarkup(`a ${CHESS_ARTIFACT} b ${MERMAID_ARTIFACT} c`, P)).toBe(`a ${P} b ${P} c`);
    expect(stripToolArtifactMarkup('plain <artifacts> text', P)).toBe('plain <artifacts> text');
    expect(stripToolArtifactMarkup('', P)).toBe('');
  });

  it('removes a block whose quoted attribute holds ">" and a case-varied tag', () => {
    const tricky = '<ARTIFACT title="a>b" type="text/html"><script>x</script></Artifact>';
    expect(stripToolArtifactMarkup(`x${tricky}y`, P)).toBe(`x${P}y`);
  });

  it('breaks an unclosed opener and a nested opener so no tag survives', () => {
    const out = stripToolArtifactMarkup('<artifact type="text/html">open <artifact type="x">in</artifact> tail', P);
    expect(out).not.toMatch(/<artifact/i);
    expect(stripToolArtifactMarkup('ok <artifact type="text/html"><!DOCTYPE html><html></html>', P)).toBe(`ok ${P}`);
    expect(stripToolArtifactMarkup('<artifact>bare</artifact> tail', P)).toBe(P);
  });

  it('does not let a quoted closer inside the open tag end the block early', () => {
    const quoted = '<artifact title="</artifact>" type="text/html"><html><script>x</script></html></artifact>';
    expect(stripToolArtifactMarkup(`a ${quoted} b`, P)).toBe(`a ${P} b`);
  });

  it('strips pathological output in linear time', () => {
    const started = Date.now();
    stripToolArtifactMarkup('<artifact '.repeat(100_000), P);
    stripToolArtifactMarkup(`${'<artifact>'.repeat(50_000)}</artifact>`, P);
    stripToolArtifactMarkup(CHESS_ARTIFACT.repeat(20_000), P);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('stripDeliveredArtifactBlocks: the recursive-reply guard only removes an echo of an already-delivered artifact', () => {
  it('removes a block whose identifier was already delivered, keeps everything else', () => {
    expect(stripDeliveredArtifactBlocks(`a ${CHESS_ARTIFACT} b ${MERMAID_ARTIFACT} c`, CHESS_ARTIFACT)).toBe(
      `a  b ${MERMAID_ARTIFACT} c`
    );
    expect(stripDeliveredArtifactBlocks('plain <artifacts> text', CHESS_ARTIFACT)).toBe('plain <artifacts> text');
    expect(stripDeliveredArtifactBlocks('', CHESS_ARTIFACT)).toBe('');
  });

  it('pin: keeps a genuinely NEW artifact the model composes in its own reply - a different identifier is not an echo', () => {
    expect(stripDeliveredArtifactBlocks(MERMAID_ARTIFACT, CHESS_ARTIFACT)).toBe(MERMAID_ARTIFACT);
  });

  it('is a no-op when nothing has been delivered yet this turn', () => {
    expect(stripDeliveredArtifactBlocks(`a ${CHESS_ARTIFACT} b`, '')).toBe(`a ${CHESS_ARTIFACT} b`);
  });

  it('keeps a stray, malformed opener literally instead of dropping the rest of the reply', () => {
    // Unlike stripToolArtifactMarkup (built for adversarial tool output), a model's own prose
    // mentioning "<artifact" with no real attributes must not cost the rest of its reply.
    const reply = "I won't repeat the <artifact tag - here's a summary instead.";
    expect(stripDeliveredArtifactBlocks(reply, MERMAID_ARTIFACT)).toBe(reply);
  });

  it('keeps an unclosed (e.g. truncated) block literally instead of dropping the rest of the reply', () => {
    const reply = `Before. ${MERMAID_ARTIFACT.slice(0, -'</artifact>'.length)} After.`;
    expect(stripDeliveredArtifactBlocks(reply, MERMAID_ARTIFACT)).toBe(reply);
  });

  it('removes a real echoed block even when an unrelated stray opener appears earlier in the same text', () => {
    // "<artifact-like" has no whitespace right after "artifact" (a hyphen), so it's rejected in
    // the same O(1) step as a plain word-boundary mismatch - it can never reach into the real
    // tag's own attributes the way "<artifact " (with a space) legitimately can, by the shared
    // grammar ARTIFACT_ATTRS_PATTERN also uses (see the "greedy consumption" test below).
    const reply = `See the <artifact-like syntax. ${MERMAID_ARTIFACT} Done.`;
    expect(stripDeliveredArtifactBlocks(reply, MERMAID_ARTIFACT)).toBe('See the <artifact-like syntax.  Done.');
  });

  it('a stray opener WITH trailing whitespace can swallow a later real tag - same grammar as filterToolArtifactMarkup', () => {
    // ARTIFACT_ATTRS_PATTERN matches any run of non->/quote characters, so "<artifact " (with a
    // space) greedily reaches for the next unquoted ">" - including one that belongs to a
    // different, later tag. This mirrors filterToolArtifactMarkup's own documented behavior, not
    // a defect introduced here.
    const reply = `Note the <artifact tag. ${MERMAID_ARTIFACT} Done.`;
    expect(stripDeliveredArtifactBlocks(reply, MERMAID_ARTIFACT)).not.toContain('Flow');
  });

  it('scans pathological input in linear time', () => {
    const started = Date.now();
    stripDeliveredArtifactBlocks('<artifact '.repeat(100_000), MERMAID_ARTIFACT);
    stripDeliveredArtifactBlocks(`${'<artifact>'.repeat(50_000)}</artifact>`, MERMAID_ARTIFACT);
    stripDeliveredArtifactBlocks(MERMAID_ARTIFACT.repeat(20_000), MERMAID_ARTIFACT);
    expect(Date.now() - started).toBeLessThan(2_000);
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
