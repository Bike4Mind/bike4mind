/**
 * Regression test for OllamaBackend: an emitter's artifact reaches the client through the
 * services-layer tool_result extraction, so the raw tag must not also re-enter history, where the
 * model could echo it into a second card. See anthropicBackend.artifactDedupe.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { ARTIFACT_DELIVERED_PLACEHOLDER, ARTIFACT_REMOVED_PLACEHOLDER, type IMessage } from '@bike4mind/common';
import { OllamaBackend } from './ollamaBackend';
import type { CompletionInfo, ICompletionOptionTools } from './backend';

const MERMAID_ARTIFACT =
  '<artifact identifier="mermaid-1" type="application/vnd.ant.mermaid" title="Flow">graph TD;A-->B</artifact>';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function runToolTurn(toolName: string, toolFn: ICompletionOptionTools['toolFn']) {
  const backend = new OllamaBackend('http://localhost:11434', silentLogger as never);
  const requests: string[] = [];
  const replies = [
    { message: { content: '', tool_calls: [{ function: { name: toolName, arguments: {} } }] } },
    { message: { content: 'Here is your diagram.', tool_calls: [] } },
  ];
  const chat = vi.fn().mockImplementation(async (params: unknown) => {
    // Serialized now: the backend keeps mutating the same messages array across rounds.
    requests.push(JSON.stringify(params));
    return { prompt_eval_count: 5, eval_count: 2, ...replies[Math.min(requests.length - 1, replies.length - 1)] };
  });
  (backend as unknown as { _api: unknown })._api = { chat };

  let toolsUsed: CompletionInfo['toolsUsed'];
  const frames: { texts: (string | null | undefined)[]; info?: CompletionInfo }[] = [];
  await backend.complete(
    'qwen2.5-coder:3b',
    [{ role: 'user', content: 'a simple process flow diagram' } as IMessage],
    {
      stream: false,
      tools: [{ toolSchema: { name: toolName, description: toolName, parameters: { type: 'object' } }, toolFn }],
    },
    async (texts, info) => {
      frames.push({ texts: [...texts], info });
      if (info?.toolsUsed) toolsUsed = info.toolsUsed;
    }
  );
  return { requests, toolsUsed, frames };
}

describe('OllamaBackend does not feed tool artifact markup back to the model', () => {
  it("replaces an emitter's artifact with the delivered placeholder in history", async () => {
    const { requests, toolsUsed } = await runToolTurn('mermaid_chart', async () => MERMAID_ARTIFACT);

    expect(requests).toHaveLength(2);
    expect(requests[1]).not.toContain('<artifact');
    expect(requests[1]).toContain(ARTIFACT_DELIVERED_PLACEHOLDER);
    expect(toolsUsed?.[0]?.returnValue).toBe(ARTIFACT_DELIVERED_PLACEHOLDER);
  });

  it("streams an emitter's artifact live on the tool-artifact channel", async () => {
    const { frames } = await runToolTurn('mermaid_chart', async () => MERMAID_ARTIFACT);

    // Without this, stripping the tag from history (above) is the only thing that happens - Ollama
    // never echoes the tag, and had no other delivery path, so the client never rendered a card.
    const artifactFrames = frames.filter(f => f.info?.channel === 'tool-artifact');
    expect(artifactFrames).toHaveLength(1);
    expect(artifactFrames[0].texts.join('')).toBe(MERMAID_ARTIFACT);
  });

  it("replaces a non-emitter's artifact markup with the removed placeholder", async () => {
    const { requests } = await runToolTurn('web_fetch', async () => `page text ${MERMAID_ARTIFACT} more text`);

    expect(requests[1]).not.toContain('<artifact');
    expect(requests[1]).toContain(`page text ${ARTIFACT_REMOVED_PLACEHOLDER} more text`);
  });

  it('strips artifact markup from a tool error message', async () => {
    const { requests } = await runToolTurn('web_fetch', async () => {
      throw new Error(`bad page ${MERMAID_ARTIFACT}`);
    });

    expect(requests[1]).not.toContain('<artifact');
    expect(requests[1]).toContain(ARTIFACT_REMOVED_PLACEHOLDER);
  });

  it("strips an emitter's own artifact markup from its error message too", async () => {
    const { requests } = await runToolTurn('mermaid_chart', async () => {
      throw new Error(`bad diagram ${MERMAID_ARTIFACT}`);
    });

    expect(requests[1]).not.toContain('<artifact');
    expect(requests[1]).toContain(ARTIFACT_REMOVED_PLACEHOLDER);
  });
});
