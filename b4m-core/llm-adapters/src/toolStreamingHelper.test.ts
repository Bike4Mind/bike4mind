import { describe, it, expect, vi } from 'vitest';
import { handleToolResultStreaming } from './toolStreamingHelper';

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
});
