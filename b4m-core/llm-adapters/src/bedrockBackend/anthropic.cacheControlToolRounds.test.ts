/**
 * Regression: a Bedrock Claude tool turn must not grow its `cache_control` markers (or its system
 * text) round over round.
 *
 * `BaseBedrockBackend.complete()` re-enters itself with the SAME `messages` array on every tool
 * round and re-runs `formatMessages` over it. That method used to mutate the caller's messages
 * (stamping `cache = true` and folding content onto them), so each round revealed and marked one
 * more system message: the request's system breakpoints climbed 1 -> 2 -> 3 ... and once upstream
 * markers alone passed Anthropic's hard ceiling of 4 the whole request failed with
 * `ValidationException: A maximum of 4 blocks with cache_control may be provided. Found 5`.
 * The same mutation re-appended already-merged text, so the system prompt duplicated and bloated
 * on every round too.
 *
 * Asserted against the real request bodies the backend sends across a five-round tool turn.
 */

import { describe, expect, it } from 'vitest';
import { ChatModels, type ICacheStrategy, type IMessage } from '@bike4mind/common';
import AnthropicBedrockBackend from './anthropic';
import type { ICompletionOptions, ICompletionOptionTools } from '../backend';

const MODEL = ChatModels.CLAUDE_4_6_SONNET_BEDROCK;

const cacheStrategy: ICacheStrategy = {
  enableCaching: true,
  cacheSystemPrompt: true,
  cacheTools: true,
  cacheConversationHistory: true,
  cacheTTL: '5m',
};

/**
 * Serves one canned non-streaming Bedrock response per round and records each request body, which
 * is what the assertions read. `updateClientForModel` is neutered so no BedrockRuntimeClient (or
 * credential lookup) is built.
 */
class RecordingBedrockBackend extends AnthropicBedrockBackend {
  sentBodies: string[] = [];

  constructor(private readonly rounds: unknown[]) {
    super();
  }

  protected override updateClientForModel(_model: string): void {
    // intentionally empty - no real client is needed
  }

  protected override async invokeModel(input: {
    modelId: string;
    contentType: string;
    accept: string;
    body: string;
  }): Promise<{ body?: Uint8Array }> {
    const round = this.rounds[this.sentBodies.length];
    this.sentBodies.push(input.body);
    if (!round) throw new Error(`no canned round ${this.sentBodies.length - 1}`);
    return { body: new TextEncoder().encode(JSON.stringify(round)) };
  }
}

function toolUseResponse(round: number): unknown {
  return {
    id: `msg_round${round}`,
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'tool_use', id: `toolu_${round}`, name: 'get_weather', input: { location: 'Paris' } }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 1000, output_tokens: 20 },
  };
}

function endTurnResponse(): unknown {
  return {
    id: 'msg_final',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'text', text: 'It is sunny in Paris.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1200, output_tokens: 30 },
  };
}

const weatherTool: ICompletionOptionTools = {
  toolFn: async () => 'ok',
  toolSchema: {
    name: 'get_weather',
    description: 'Get the current weather',
    parameters: { type: 'object', properties: { location: { type: 'string', description: 'City' } } },
  },
};

/**
 * Six system messages - a realistic prompt stack - with the shareable-prefix breakpoint declared on
 * the fifth. The boundary sits far enough down that, under the mutation, inbound markers alone
 * reach 5 by the fifth round, which is the request the provider rejects.
 */
function systemStack(): IMessage[] {
  return [
    { role: 'system', content: 'Current date: Tuesday, September 29, 2026' },
    { role: 'system', content: 'ARTIFACT OUTPUT guidance.' },
    { role: 'system', content: 'HELP CENTER excerpt.' },
    { role: 'system', content: 'Tool guidance.' },
    { role: 'system', content: 'Session prompt shared across callers.', cache: true },
    { role: 'system', content: 'Session prompt only this caller has.' },
  ];
}

type MarkedBlock = { cache_control?: unknown };
type SystemBlock = { type: 'text'; text: string } & MarkedBlock;
interface RequestBody {
  system?: SystemBlock[] | string;
  tools?: MarkedBlock[];
  messages: Array<{ content: unknown }>;
}

function parse(body: string): RequestBody {
  return JSON.parse(body) as RequestBody;
}

function markedCount(blocks: unknown): number {
  return Array.isArray(blocks) ? blocks.filter((b: MarkedBlock) => b.cache_control).length : 0;
}

function systemMarkers(body: string): number {
  return markedCount(parse(body).system);
}

function totalMarkers(body: string): number {
  const { system, tools, messages } = parse(body);
  const messageCount = messages.reduce((sum, message) => sum + markedCount(message.content), 0);
  return markedCount(system) + markedCount(tools) + messageCount;
}

function systemBlocks(body: string): SystemBlock[] {
  const { system } = parse(body);
  return Array.isArray(system) ? system : [];
}

function systemText(body: string): string {
  const { system } = parse(body);
  return Array.isArray(system) ? system.map(block => block.text).join('\n') : String(system);
}

async function runToolTurn(): Promise<RecordingBedrockBackend> {
  const backend = new RecordingBedrockBackend([
    toolUseResponse(1),
    toolUseResponse(2),
    toolUseResponse(3),
    toolUseResponse(4),
    endTurnResponse(),
  ]);
  const messages = [...systemStack(), { role: 'user', content: 'What is the weather in Paris?' } as IMessage];

  await backend.complete(
    MODEL,
    messages,
    { tools: [weatherTool], maxTokens: 1024, stream: false, cacheStrategy } as Partial<ICompletionOptions>,
    async () => {}
  );

  // Every assertion below reads the round bodies, so a loop that stopped early would leave the
  // ceiling and text tests passing vacuously. Pin the round count here, once.
  expect(backend.sentBodies).toHaveLength(5);

  return backend;
}

describe('Bedrock Claude cache_control across a multi-round tool turn', () => {
  it('sends the same number of system breakpoints, in the same places, on every round', async () => {
    const backend = await runToolTurn();

    const counts = backend.sentBodies.map(systemMarkers);
    // Every round must describe the same breakpoint layout. Under the mutation this climbs 2 -> 3
    // -> 4 -> 4 -> 5 as each round marks one more system message.
    expect(counts).toEqual(Array(counts.length).fill(counts[0]));

    // Counting alone would stay green if a regression moved the shared-prefix breakpoint the same
    // way on every round, so pin the round-1 layout: the merged prefix block ends at the declared
    // boundary and carries the breakpoint; the per-caller tail is its own unmarked block; the
    // adapter's own breakpoint lands on the closing model-identity block.
    const blocks = systemBlocks(backend.sentBodies[0]);
    expect(blocks.map(block => !!block.cache_control)).toEqual([true, false, true]);
    expect(blocks[0].text.endsWith('Session prompt shared across callers.')).toBe(true);
    expect(blocks[1].text).toBe('Session prompt only this caller has.');
  });

  it('never exceeds the 4-block cache_control ceiling on any round', async () => {
    const backend = await runToolTurn();

    const totals = backend.sentBodies.map(totalMarkers);
    // The exact failure the issue reports: `Found 5`. The caching adapter can only drop its own
    // markers, so markers attached upstream have to stay finite on their own.
    expect(Math.max(...totals)).toBeLessThanOrEqual(4);
  });

  it('sends identical system text on every round', async () => {
    const backend = await runToolTurn();

    const texts = backend.sentBodies.map(systemText);
    // The second symptom of the same mutation: the merge re-appended already-merged text, so the
    // system prompt grew on every round.
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).toContain('Session prompt only this caller has.');
  });
});
