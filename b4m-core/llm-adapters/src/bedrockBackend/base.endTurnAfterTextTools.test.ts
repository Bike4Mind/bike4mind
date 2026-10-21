/**
 * Bedrock leg of endTurnAfterTextTools.test.ts: a streamed answer followed only by
 * `endsTurnAfterText` tool calls ends the turn without a follow-up model call.
 */
import { describe, it, expect } from 'vitest';
import type { ChatModels, IMessage, ModelInfo, CompletionInfo } from '@bike4mind/common';
import { BaseBedrockBackend } from './base';
import {
  ChoiceEndReason,
  ChoiceStatus,
  type ICompletionOptionTools,
  type ICompletionOptions,
  type ICompletionResponseChunk,
} from '../backend';

const TEST_MODEL = 'test-model' as ChatModels;
const ANSWER = 'Here is the full answer.';
const PARAMS = JSON.stringify({ target: 'x' });

class TestBedrockBackend extends BaseBedrockBackend {
  protected override updateClientForModel(): void {}
  async getModelInfo(): Promise<ModelInfo[]> {
    return [];
  }
  formatMessages(messages: IMessage[]): IMessage[] {
    return messages;
  }
  getPayload() {
    return { modelId: 'test', contentType: 'application/json', accept: 'application/json', body: '{}' };
  }
  translateStreamChunk(_model: string, json: unknown): { done: boolean; chunk?: ICompletionResponseChunk } {
    return { done: false, chunk: json as ICompletionResponseChunk };
  }
  translateChunk(_model: string, json: unknown): { done: boolean; chunk?: ICompletionResponseChunk } {
    return { done: true, chunk: json as ICompletionResponseChunk };
  }
  pushToolMessages(): void {}
}

const makeTool = (name: string, endsTurnAfterText: boolean): ICompletionOptionTools => ({
  toolSchema: {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: { target: { type: 'string', description: 'target' } } },
  },
  toolFn: async () => 'Buttons shown.',
  ...(endsTurnAfterText ? { endsTurnAfterText: true } : {}),
});

const end = (statusEndReason: ChoiceEndReason, input: number, output: number) => ({
  choices: [
    { index: 0, status: ChoiceStatus.END, statusEndReason, usage: { input_tokens: input, output_tokens: output } },
  ],
});

const encode = (chunk: unknown) => new TextEncoder().encode(JSON.stringify(chunk));

const streamBody = (chunks: unknown[]) => ({
  body: {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield { chunk: { bytes: encode(c) } };
    },
  },
});

const textChunk = (text: string) => ({ choices: [{ index: 0, status: ChoiceStatus.STREAM, chunkText: text }] });

const roundWithTool = (text: string, toolName: string) =>
  streamBody([
    ...(text ? [textChunk(text)] : []),
    { choices: [{ index: 1, status: ChoiceStatus.STREAM, tool: { name: toolName, id: 'call_1' } }] },
    { choices: [{ index: 1, status: ChoiceStatus.STREAM, chunkText: PARAMS }] },
    end(ChoiceEndReason.STOP, 10, 5),
  ]);

const textRound = (text: string) => streamBody([textChunk(text), end(ChoiceEndReason.STOP, 20, 7)]);

async function run(bodies: unknown[], tools: ICompletionOptionTools[]) {
  const backend = new TestBedrockBackend();
  let sendCount = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial SDK client mock
  (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = { send: async () => bodies[sendCount++] };
  const texts: string[] = [];
  const infos: CompletionInfo[] = [];
  await backend.complete(
    TEST_MODEL,
    [{ role: 'user', content: 'question' }],
    { stream: true, tools, executeTools: true } as Partial<ICompletionOptions>,
    async (text, info) => {
      if (info?.channel !== 'reasoning') texts.push(...text.filter((t): t is string => typeof t === 'string'));
      if (info) infos.push(info);
    }
  );
  return { sendCount, text: texts.join(''), infos };
}

describe('BaseBedrockBackend end-of-turn tools', () => {
  it('ends the turn after a streamed answer plus a lone flagged tool call', async () => {
    const { sendCount, text, infos } = await run(
      [roundWithTool(ANSWER, 'suggest_links'), textRound('The answer again.')],
      [makeTool('suggest_links', true)]
    );

    expect(sendCount).toBe(1);
    expect(text).toBe(ANSWER);
    const terminal = infos[infos.length - 1];
    expect(terminal.inputTokens).toBe(10);
    expect(terminal.outputTokens).toBe(5);
    expect(terminal.toolsUsed?.map(tool => tool.name)).toEqual(['suggest_links']);
  });

  it('still recurses for an unflagged tool', async () => {
    const { sendCount, text } = await run(
      [roundWithTool(ANSWER, 'lookup'), textRound(' Follow-up.')],
      [makeTool('lookup', false)]
    );

    expect(sendCount).toBe(2);
    expect(text).toContain('Follow-up.');
  });

  it('still recurses when the flagged tool was called without answer text', async () => {
    const { sendCount, text } = await run(
      [roundWithTool('', 'suggest_links'), textRound(ANSWER)],
      [makeTool('suggest_links', true)]
    );

    expect(sendCount).toBe(2);
    expect(text).toContain(ANSWER);
  });
});
