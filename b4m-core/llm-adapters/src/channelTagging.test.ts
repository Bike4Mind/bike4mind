/**
 * The adapter half of the public-stream contract: non-reply frames must be TAGGED at the
 * emit site.
 *
 * buildPublicSSEEvent drops a frame's text on CompletionInfo.channel alone - it never scans
 * the text - so the guarantee is only as good as the tags adapters actually attach. Route
 * tests feed it tagged frames directly and so cannot catch an adapter that stopped tagging;
 * these drive the real backends against canned provider streams and read the tags off the
 * completion callback.
 *
 * Each case ends by replaying its captured frames through buildPublicSSEEvent, which is the
 * property that matters: a public stream carries the prose and nothing else.
 */

import { describe, it, expect } from 'vitest';
import {
  ModelBackend,
  buildPublicSSEEvent,
  type CompletionInfo,
  type IMessage,
  type ModelInfo,
} from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import AnthropicBedrockBackend from './bedrockBackend/anthropic';
import { handleToolResultStreaming } from './toolStreamingHelper';
import type { ICompletionOptions } from './backend';

interface CapturedFrame {
  text: (string | null | undefined)[];
  info?: CompletionInfo;
}

function captureCb(): {
  frames: CapturedFrame[];
  cb: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>;
} {
  const frames: CapturedFrame[] = [];
  return {
    frames,
    cb: async (text, info) => {
      // The adapter reuses its array across events, so snapshot it.
      frames.push({ text: [...text], info });
    },
  };
}

/** Everything a frame put on the wire, regardless of index. */
function frameText(frame: CapturedFrame): string {
  return frame.text.filter((t): t is string => typeof t === 'string').join('');
}

/** What a public embed viewer would end up seeing, given these frames. */
function publicStreamText(frames: CapturedFrame[]): string {
  return frames.map(f => buildPublicSSEEvent(f.text, f.info).text).join('');
}

const THINKING_TEXT = 'The user asked about Paris, so I will answer plainly.';
const PROSE = 'It is sunny in Paris.';

/** A turn that reasons and then answers - one thinking block, then one text block. */
function thinkingThenTextEvents(): unknown[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 40 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINKING_TEXT } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-payload' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: PROSE } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 90 } },
    { type: 'message_stop' },
  ];
}

describe('AnthropicBackend tags reasoning frames', () => {
  function build(events: unknown[]) {
    const backend = new AnthropicBackend('test-key');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK client has no exported mock shape
    (backend as unknown as { _api: any })._api = {
      messages: {
        create: async () => ({
          [Symbol.asyncIterator]: async function* () {
            for (const e of events) yield e;
          },
          controller: { abort: () => {} },
        }),
      },
    };
    return backend;
  }

  it('tags every frame of a thinking block and leaves the prose untagged', async () => {
    const backend = build(thinkingThenTextEvents());
    const { frames, cb } = captureCb();

    await backend.complete(
      'claude-sonnet-4-5-20250929',
      [{ role: 'user', content: 'weather in Paris?' }],
      { stream: true, tools: [] },
      cb
    );

    // The block opens, streams and closes as three separate frames; all three carry the tag.
    const tagged = frames.filter(f => f.info?.channel === 'reasoning');
    expect(tagged.map(frameText)).toEqual(['<think>', THINKING_TEXT, '</think>']);

    // Anything untagged must be free of reasoning - that is what the public surface forwards.
    for (const frame of frames.filter(f => !f.info?.channel)) {
      expect(frameText(frame)).not.toContain(THINKING_TEXT);
      expect(frameText(frame)).not.toContain('<think>');
    }

    expect(publicStreamText(frames)).toBe(PROSE);
  });
});

describe('AnthropicBedrockBackend tags reasoning frames', () => {
  const MODEL = 'us.anthropic.claude-opus-5';

  const modelRecord: ModelInfo = {
    id: MODEL,
    type: 'text',
    name: 'Claude Opus 5 (Bedrock)',
    backend: ModelBackend.Bedrock,
    contextWindow: 200000,
    supportsImageVariation: false,
    max_tokens: 64000,
    can_stream: true,
    can_think: true,
    thinkingStyle: 'adaptive',
    pricing: { 200000: { input: 0.000005, output: 0.000025 } },
  } as ModelInfo;

  /** Serves one canned raw-Bedrock stream; no client or credential lookup is built. */
  class StubbedBedrockBackend extends AnthropicBedrockBackend {
    constructor(private readonly events: unknown[]) {
      super();
    }

    protected override updateClientForModel(_model: string): void {
      // intentionally empty - no real client is needed
    }

    protected override async invokeModelStream(): Promise<{
      body?: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }>;
    }> {
      const events = this.events;
      return {
        body: {
          [Symbol.asyncIterator]: async function* () {
            for (const chunk of events) {
              yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(chunk)) } };
            }
          },
        },
      };
    }
  }

  it('tags every frame of a thinking block and leaves the prose untagged', async () => {
    const backend = new StubbedBedrockBackend(thinkingThenTextEvents());
    backend.setDispatchModel(modelRecord);
    const { frames, cb } = captureCb();
    const messages: IMessage[] = [{ role: 'user', content: 'weather in Paris?' }];

    await backend.complete(MODEL, messages, { stream: true, maxTokens: 64000 } as Partial<ICompletionOptions>, cb);

    const tagged = frames.filter(f => f.info?.channel === 'reasoning');
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.map(frameText).join('')).toContain(THINKING_TEXT);
    expect(tagged.map(frameText).join('')).toContain('</think>');

    for (const frame of frames.filter(f => !f.info?.channel)) {
      expect(frameText(frame)).not.toContain(THINKING_TEXT);
      expect(frameText(frame)).not.toContain('<think>');
    }

    expect(publicStreamText(frames)).toBe(PROSE);
  });
});

describe('handleToolResultStreaming tags raw tool results', () => {
  const ARTIFACT = '<artifact type="application/vnd.ant.react">export default () => null;</artifact>';

  it('tags the artifact frame so a public stream drops it', async () => {
    const { frames, cb } = captureCb();

    await handleToolResultStreaming('web_fetch', ARTIFACT, cb);

    expect(frames).toHaveLength(1);
    expect(frames[0].info?.channel).toBe('tool-artifact');
    expect(publicStreamText(frames)).toBe('');
  });

  it('tags a recharts result, which streams on the tool name alone', async () => {
    const { frames, cb } = captureCb();

    await handleToolResultStreaming('recharts', '{"data":[]}', cb);

    expect(frames).toHaveLength(1);
    expect(frames[0].info?.channel).toBe('tool-artifact');
  });

  it('streams nothing for an ordinary tool result', async () => {
    const { frames, cb } = captureCb();

    await handleToolResultStreaming('get_weather', 'sunny, 24C', cb);

    expect(frames).toHaveLength(0);
  });
});
