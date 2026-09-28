/**
 * Regression test for #3253 on BaseBedrockBackend - see anthropicBackend.artifactDedupe.test.ts
 * for the full mechanism. Bedrock pushes the raw tool result string into history exactly like
 * Anthropic, so it's vulnerable to the same model-echo duplicate card.
 */
import { describe, it, expect } from 'vitest';
import type { ChatModels, IMessage, ModelInfo, CompletionInfo } from '@bike4mind/common';
import { BaseBedrockBackend } from './base';
import {
  ChoiceEndReason,
  ChoiceStatus,
  type IChoiceEndToolUse,
  type ICompletionOptionTools,
  type ICompletionOptions,
  type ICompletionResponseChunk,
} from '../backend';

const MERMAID_ARTIFACT =
  '<artifact identifier="mermaid-1" type="application/vnd.ant.mermaid" title="Flow">graph TD;A-->B</artifact>';

class TestBedrockBackend extends BaseBedrockBackend {
  protected override updateClientForModel(_model: string): void {}

  async getModelInfo(): Promise<ModelInfo[]> {
    return [];
  }

  formatMessages(messages: IMessage[]): IMessage[] {
    return messages;
  }

  getPayload(): { modelId: string; contentType: string; accept: string; body: string } {
    return { modelId: 'test', contentType: 'application/json', accept: 'application/json', body: '{}' };
  }

  translateStreamChunk(_model: string, json: unknown): { done: boolean; chunk?: ICompletionResponseChunk } {
    return { done: false, chunk: json as ICompletionResponseChunk };
  }

  translateChunk(_model: string, json: unknown): { done: boolean; chunk?: ICompletionResponseChunk } {
    return { done: true, chunk: json as ICompletionResponseChunk };
  }

  pushToolMessages(messages: IMessage[], tool: IChoiceEndToolUse['tool'], result: string): void {
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: tool.id, name: tool.name, input: JSON.parse(tool.parameters || '{}') }],
    } as IMessage);
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: tool.id, content: result }],
    } as IMessage);
  }
}

function asBedrockInvokeBody(chunk: unknown) {
  return new TextEncoder().encode(JSON.stringify(chunk));
}

function asBedrockStreamBody(chunks: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) {
        yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(c)) } };
      }
    },
  };
}

interface CapturedCb {
  text: (string | null | undefined)[];
  info?: CompletionInfo;
}

function captureCb() {
  const calls: CapturedCb[] = [];
  return {
    calls,
    cb: async (text: (string | null | undefined)[], info?: CompletionInfo) => {
      calls.push({ text, info });
    },
  };
}

const TEST_MODEL = 'test-model' as ChatModels;
const TOOL_CALL_ID = 'tool_mermaid_01';

const mermaidTool: ICompletionOptionTools = {
  toolSchema: {
    name: 'mermaid_chart',
    description: 'Generate a Mermaid chart',
    parameters: { type: 'object', properties: { definition: { type: 'string' } }, required: ['definition'] },
  },
  toolFn: async () => MERMAID_ARTIFACT,
};

const RECHARTS_ARTIFACT =
  '<artifact identifier="chart-1" type="application/vnd.ant.recharts" title="Bar">{"data":[]}</artifact>';

const rechartsTool: ICompletionOptionTools = {
  toolSchema: {
    name: 'recharts',
    description: 'Generate a chart',
    parameters: { type: 'object', properties: { definition: { type: 'string' } }, required: ['definition'] },
  },
  toolFn: async () => RECHARTS_ARTIFACT,
};

function nonStreamingToolCallChunk() {
  return {
    choices: [
      {
        index: 0,
        status: ChoiceStatus.END,
        statusEndReason: ChoiceEndReason.TOOL_USE,
        tool: { name: 'mermaid_chart', id: TOOL_CALL_ID, parameters: JSON.stringify({ definition: 'graph TD;A-->B' }) },
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    ],
  };
}

function nonStreamingTextChunk(text: string) {
  return {
    choices: [
      {
        index: 0,
        status: ChoiceStatus.END,
        statusEndReason: ChoiceEndReason.STOP,
        chunkText: text,
        usage: { input_tokens: 5, output_tokens: 3 },
      },
    ],
  };
}

function streamingToolCallTurn(): unknown[] {
  return [
    {
      choices: [{ index: 0, status: ChoiceStatus.STREAM, tool: { name: 'mermaid_chart', id: TOOL_CALL_ID } }],
    },
    {
      choices: [{ index: 0, status: ChoiceStatus.STREAM, chunkText: JSON.stringify({ definition: 'graph TD;A-->B' }) }],
    },
    {
      choices: [
        {
          index: 0,
          status: ChoiceStatus.END,
          statusEndReason: ChoiceEndReason.STOP,
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      ],
    },
  ];
}

/**
 * Intro text streamed as its OWN chunks before the tool name appears, followed by a second
 * tool call - unlike streamingToolCallTurn, this is the "chained tool call" shape: the text
 * chunks arrive while `func.some(f => f.name)` is still false (see base.ts's streaming loop),
 * so they reach the client normally; only once the tool name lands does base.ts start treating
 * further chunkText as that tool's own parameters and skip the text callback.
 */
function streamingTextThenToolCallTurn(
  text: string,
  name: string,
  id: string,
  params: Record<string, unknown>
): unknown[] {
  return [
    { choices: [{ index: 0, status: ChoiceStatus.STREAM, chunkText: text }] },
    { choices: [{ index: 0, status: ChoiceStatus.STREAM, tool: { name, id } }] },
    { choices: [{ index: 0, status: ChoiceStatus.STREAM, chunkText: JSON.stringify(params) }] },
    {
      choices: [
        {
          index: 0,
          status: ChoiceStatus.END,
          statusEndReason: ChoiceEndReason.STOP,
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      ],
    },
  ];
}

function streamingTextTurn(text: string): unknown[] {
  return [
    { choices: [{ index: 0, status: ChoiceStatus.STREAM, chunkText: text }] },
    {
      choices: [
        {
          index: 0,
          status: ChoiceStatus.END,
          statusEndReason: ChoiceEndReason.STOP,
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      ],
    },
  ];
}

describe('BaseBedrockBackend does not duplicate an echoed tool artifact card (#3253)', () => {
  it('strips the artifact tag from history and from an echoed recursive reply', async () => {
    const backend = new TestBedrockBackend();
    let callIndex = 0;
    const bodies = [
      asBedrockInvokeBody(nonStreamingToolCallChunk()),
      // Turn 2: the model echoes the same artifact tag it saw in the tool result.
      asBedrockInvokeBody(nonStreamingTextChunk(`Here is your diagram:\n\n${MERMAID_ARTIFACT}`)),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async () => ({ body: bodies[callIndex++] }),
    };

    const messages: IMessage[] = [{ role: 'user', content: 'a simple process flow diagram' }];
    const { calls, cb } = captureCb();

    await backend.complete(
      TEST_MODEL,
      messages,
      { stream: false, tools: [mermaidTool], executeTools: true } as Partial<ICompletionOptions>,
      cb
    );

    const clientText = calls
      .flatMap(c => c.text)
      .filter((r): r is string => typeof r === 'string')
      .join('');
    const artifactTagCount = (clientText.match(/<artifact\b/g) || []).length;
    expect(artifactTagCount).toBe(1);

    const toolResultMsg = messages.find(
      m =>
        Array.isArray(m.content) &&
        m.content.some(
          (c: unknown) => typeof c === 'object' && c !== null && (c as { type?: string }).type === 'tool_result'
        )
    );
    const toolResultBlock = (toolResultMsg!.content as Array<{ type: string; content: string }>).find(
      c => c.type === 'tool_result'
    );
    expect(toolResultBlock?.content).not.toContain('<artifact');
    expect(toolResultBlock?.content).toContain('[Artifact rendered and delivered to user]');
  });

  it('strips the artifact tag from history and from an echoed recursive reply (streaming)', async () => {
    const backend = new TestBedrockBackend();
    const turns = [streamingToolCallTurn(), streamingTextTurn(`Here is your diagram:\n\n${MERMAID_ARTIFACT}`)];
    let callIndex = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async () => {
        const turn = turns[callIndex++];
        if (!turn) throw new Error('no more mocked turns');
        return { body: asBedrockStreamBody(turn) };
      },
    };

    const messages: IMessage[] = [{ role: 'user', content: 'a simple process flow diagram' }];
    const { calls, cb } = captureCb();

    await backend.complete(
      TEST_MODEL,
      messages,
      { stream: true, tools: [mermaidTool], executeTools: true } as Partial<ICompletionOptions>,
      cb
    );

    const clientText = calls
      .flatMap(c => c.text)
      .filter((r): r is string => typeof r === 'string')
      .join('');
    const artifactTagCount = (clientText.match(/<artifact\b/g) || []).length;
    expect(artifactTagCount).toBe(1);

    const toolResultMsg = messages.find(
      m =>
        Array.isArray(m.content) &&
        m.content.some(
          (c: unknown) => typeof c === 'object' && c !== null && (c as { type?: string }).type === 'tool_result'
        )
    );
    const toolResultBlock = (toolResultMsg!.content as Array<{ type: string; content: string }>).find(
      c => c.type === 'tool_result'
    );
    expect(toolResultBlock?.content).not.toContain('<artifact');
    expect(toolResultBlock?.content).toContain('[Artifact rendered and delivered to user]');
  });

  it('pin: a chained tool call turn delivers its own intro text, ahead of the artifact it introduces', async () => {
    // Regression: the non-streaming path only sent a turn's text after its tool-call branch,
    // which returns early, so an intro sharing a chunk with a chained tool call was dropped.
    const RECHARTS_ARTIFACT =
      '<artifact identifier="chart-1" type="application/vnd.ant.recharts" title="Bar">{"data":[]}</artifact>';
    const rechartsTool: ICompletionOptionTools = {
      toolSchema: {
        name: 'recharts',
        description: 'Generate a chart',
        parameters: { type: 'object', properties: { definition: { type: 'string' } }, required: ['definition'] },
      },
      toolFn: async () => RECHARTS_ARTIFACT,
    };
    const backend = new TestBedrockBackend();
    let callIndex = 0;
    const bodies = [
      asBedrockInvokeBody(nonStreamingToolCallChunk()),
      asBedrockInvokeBody({
        choices: [
          {
            index: 0,
            status: ChoiceStatus.END,
            statusEndReason: ChoiceEndReason.TOOL_USE,
            chunkText: "Here's the second chart:",
            tool: { name: 'recharts', id: 'tool_recharts_01', parameters: JSON.stringify({ definition: '{}' }) },
            usage: { input_tokens: 12, output_tokens: 4 },
          },
        ],
      }),
      asBedrockInvokeBody(nonStreamingTextChunk('Done.')),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async () => ({ body: bodies[callIndex++] }),
    };

    const messages: IMessage[] = [{ role: 'user', content: 'two charts please' }];
    const { calls, cb } = captureCb();

    await backend.complete(
      TEST_MODEL,
      messages,
      { stream: false, tools: [mermaidTool, rechartsTool], executeTools: true } as Partial<ICompletionOptions>,
      cb
    );

    const clientText = calls
      .flatMap(c => c.text)
      .filter((r): r is string => typeof r === 'string')
      .join('');
    const firstChartIndex = clientText.indexOf('identifier="mermaid-1"');
    const introIndex = clientText.indexOf("Here's the second chart:");
    const secondChartIndex = clientText.indexOf('identifier="chart-1"');
    expect(firstChartIndex).toBeGreaterThanOrEqual(0);
    expect(introIndex).toBeGreaterThan(firstChartIndex);
    expect(secondChartIndex).toBeGreaterThan(introIndex);
    expect(clientText.indexOf('Done.')).toBeGreaterThan(secondChartIndex);
  });

  it('pin: a genuinely NEW artifact the model composes in its own reply text is not mistaken for an echo', async () => {
    // Regression: the echo backstop used to strip EVERY complete <artifact> block from the
    // buffered reply, not just ones matching an artifact already delivered this turn - so a
    // model-authored artifact with a different identifier was silently deleted.
    const NEW_ARTIFACT =
      '<artifact identifier="mermaid-2" type="application/vnd.ant.mermaid" title="Second">graph TD;C-->D</artifact>';
    const backend = new TestBedrockBackend();
    let callIndex = 0;
    const bodies = [
      asBedrockInvokeBody(nonStreamingToolCallChunk()),
      asBedrockInvokeBody(nonStreamingTextChunk(`Here's another one I drew myself:\n\n${NEW_ARTIFACT}`)),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async () => ({ body: bodies[callIndex++] }),
    };

    const messages: IMessage[] = [{ role: 'user', content: 'a simple process flow diagram' }];
    const { calls, cb } = captureCb();

    await backend.complete(
      TEST_MODEL,
      messages,
      { stream: false, tools: [mermaidTool], executeTools: true } as Partial<ICompletionOptions>,
      cb
    );

    const clientText = calls
      .flatMap(c => c.text)
      .filter((r): r is string => typeof r === 'string')
      .join('');
    expect(clientText).toContain('identifier="mermaid-1"');
    expect(clientText).toContain('identifier="mermaid-2"');
  });

  it('pin: a chained tool call artifact reaches the client AFTER the text that introduces it, not before (streaming)', async () => {
    // Mirrors anthropicBackend.artifactDedupe.test.ts / geminiBackend.artifactDedupe.test.ts's
    // identical pin. The streaming path (unlike non-streaming, see base.ts's own "Skip callback
    // when there is a tool being streamed" comment) can only buffer/order text that arrives
    // BEFORE the tool name appears in the stream - constructed here as its own chunks ahead of
    // the second tool call's announcement, which is how a real chained turn streams.
    const backend = new TestBedrockBackend();
    const turns = [
      streamingToolCallTurn(),
      streamingTextThenToolCallTurn("Here's the second chart:", 'recharts', 'call_2', { definition: '{}' }),
      streamingTextTurn('Done.'),
    ];
    let callIndex = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async () => {
        const turn = turns[callIndex++];
        if (!turn) throw new Error('no more mocked turns');
        return { body: asBedrockStreamBody(turn) };
      },
    };

    const messages: IMessage[] = [{ role: 'user', content: 'a simple process flow diagram' }];
    const { calls, cb } = captureCb();

    await backend.complete(
      TEST_MODEL,
      messages,
      { stream: true, tools: [mermaidTool, rechartsTool], executeTools: true } as Partial<ICompletionOptions>,
      cb
    );

    const clientText = calls
      .flatMap(c => c.text)
      .filter((r): r is string => typeof r === 'string')
      .join('');
    const introIndex = clientText.indexOf("Here's the second chart:");
    const chartIndex = clientText.indexOf('identifier="chart-1"');
    expect(introIndex).toBeGreaterThanOrEqual(0);
    expect(chartIndex).toBeGreaterThan(introIndex);
  });
});
