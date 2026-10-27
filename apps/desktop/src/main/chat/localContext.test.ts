import { describe, expect, it } from 'vitest';
import type { HardwareProfile, ModelArch } from '@bike4mind/common';
import { AUTO_LOCAL_CONTEXT } from '@shared/localContextSetting';
import {
  chatContextTokens,
  estimateTokens,
  fitsInMemory,
  fitToContext,
  grownContext,
  LOCAL_CONTEXT_TARGET_TOKENS,
  loadsInMemory,
  localTranscriptChars,
  overflowTokens,
  shrunkTranscriptChars,
  type LocalModelFootprint,
  type OllamaMessage,
} from './localContext';

const UNMEASURED: LocalModelFootprint = { arch: null, weightsBytes: null, hardware: null };

describe('chatContextTokens without a measurement', () => {
  it.each([
    { limit: undefined, configured: undefined, expected: LOCAL_CONTEXT_TARGET_TOKENS },
    { limit: 32768, configured: undefined, expected: 16384 },
    { limit: 262144, configured: undefined, expected: 16384 },
    { limit: 8192, configured: undefined, expected: 8192 },
    { limit: 32768, configured: 2048, expected: 16384 },
    // A Modelfile num_ctx is honoured only once it is known to stay resident.
    { limit: 131072, configured: 65536, expected: 16384 },
    { limit: 32768, configured: 65536, expected: 16384 },
  ])('sizes $limit / $configured to $expected', ({ limit, configured, expected }) => {
    expect(
      chatContextTokens({ setting: AUTO_LOCAL_CONTEXT, footprint: UNMEASURED, modelLimit: limit, configured })
    ).toBe(expected);
  });
});

describe('estimateTokens', () => {
  it('counts text, tool calls, images and tool schemas', () => {
    expect(estimateTokens([{ role: 'user', content: 'x'.repeat(400) }])).toBe(104);
    expect(estimateTokens([{ role: 'user', content: '', images: ['a', 'b'] }])).toBe(2 * 768 + 4);
    const call = { function: { name: 'f', arguments: {} } };
    expect(estimateTokens([{ role: 'assistant', content: '', tool_calls: [call] }])).toBe(
      Math.ceil(JSON.stringify([call]).length / 4) + 4
    );
    const tools = [{ type: 'function', function: { name: 'x'.repeat(1000) } }];
    expect(estimateTokens([], tools)).toBe(Math.ceil(JSON.stringify(tools).length / 4));
  });
});

describe('fitToContext', () => {
  const text = (role: string, chars: number, tag = role): OllamaMessage => ({
    role,
    content: tag + 'x'.repeat(Math.max(0, chars - tag.length)),
  });
  const tags = (messages: OllamaMessage[]) => messages.map(message => message.content.replace(/x+$/, ''));

  it('sends everything that fits', () => {
    const messages = [text('system', 4000), text('user', 400), text('assistant', 400), text('user', 400)];
    expect(fitToContext(messages, [], 4096)).toEqual({ messages, dropped: 0, visible: 0 });
  });

  it('drops the oldest whole turns, never the system prompt or the latest turn', () => {
    const messages = [
      text('system', 4000, 'sys'),
      text('user', 4000, 'u1'),
      text('assistant', 4000, 'a1'),
      text('user', 4000, 'u2'),
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'f', arguments: {} } }] },
      text('tool', 2000, 't2'),
      text('assistant', 400, 'a2'),
      text('user', 400, 'u3'),
    ];
    // 4096 minus the 1024 reserve leaves 3072 tokens: the system prompt and the last two turns.
    const fit = fitToContext(messages, [], 4096);
    expect(tags(fit.messages)).toEqual(['sys', 'u2', '', 't2', 'a2', 'u3']);
    expect(fit.dropped).toBe(2);
  });

  it('keeps the latest turn even when it alone overflows', () => {
    const messages = [text('system', 400, 'sys'), text('user', 400, 'u1'), text('user', 40_000, 'u2')];
    expect(tags(fitToContext(messages, [], 4096).messages)).toEqual(['sys', 'u2']);
  });

  it('counts tool schemas and leaves room for the reply', () => {
    const messages = [text('system', 400, 'sys'), text('user', 2400, 'u1'), text('user', 400, 'u2')];
    const tools = [{ type: 'function', function: { description: 'x'.repeat(10_000) } }];
    expect(tags(fitToContext(messages, [], 4096).messages)).toEqual(['sys', 'u1', 'u2']);
    expect(tags(fitToContext(messages, tools, 4096).messages)).toEqual(['sys', 'u2']);
    expect(tags(fitToContext(messages, [], 1024, 64).messages)).toEqual(['sys', 'u1', 'u2']);
    expect(tags(fitToContext(messages, [], 1024).messages)).toEqual(['sys', 'u2']);
  });

  it('drops more when the estimate is scaled up', () => {
    const messages = [text('system', 400, 'sys'), text('user', 4000, 'u1'), text('user', 400, 'u2')];
    expect(fitToContext(messages, [], 4096).dropped).toBe(0);
    expect(tags(fitToContext(messages, [], 4096, undefined, 3).messages)).toEqual(['sys', 'u2']);
  });

  it('drops assistant messages that precede the first user message with the first turn', () => {
    const messages = [text('system', 400, 'sys'), text('assistant', 8000, 'a0'), text('user', 400, 'u1')];
    expect(tags(fitToContext(messages, [], 2048).messages)).toEqual(['sys', 'u1']);
  });

  it('leaves a conversation with no user message alone', () => {
    const messages = [text('system', 40_000, 'sys')];
    expect(fitToContext(messages, [], 2048)).toEqual({ messages, dropped: 0, visible: 0 });
  });

  const call = (name: string, content = ''): OllamaMessage => ({
    role: 'assistant',
    content,
    tool_calls: [{ function: { name, arguments: {} } }],
  });

  it('keeps the request of a turn whose tool screenshots arrive as user messages', () => {
    const messages: OllamaMessage[] = [
      text('system', 40_000, 'sys'),
      text('user', 400, 'u-old'),
      text('assistant', 400, 'a-old'),
      text('user', 60, 'u-request'),
      call('read_file'),
      text('tool', 12_000, 't-file'),
      call('browser_screenshot'),
      text('tool', 20, 't-shot'),
      { role: 'user', content: 'u-images', images: ['AAAA'], continuesTurn: true },
      call('browser_click'),
      text('tool', 2000, 't-click'),
    ];
    const fit = fitToContext(messages, [], LOCAL_CONTEXT_TARGET_TOKENS);
    expect(tags(fit.messages)).toEqual(['sys', 'u-request', '', 't-file', '', 't-shot', 'u-images', '', 't-click']);
    expect(fit.dropped).toBe(2);
  });

  it('drops a screenshot message together with the turn it belongs to, counting what the user sees', () => {
    const messages = [
      text('system', 400, 'sys'),
      text('user', 8000, 'u1'),
      call('f'),
      text('tool', 400, 't1'),
      { ...text('user', 400, 'u1-images'), continuesTurn: true },
      call('g', 'a1-progress'),
      text('tool', 400, 't1b'),
      text('assistant', 400, 'a1'),
      text('user', 400, 'u2'),
    ];
    const fit = fitToContext(messages, [], 2048);
    expect(tags(fit.messages)).toEqual(['sys', 'u2']);
    expect(fit.dropped).toBe(7);
    // The prompt and its one reply, however many tool rounds and screenshots it took.
    expect(fit.visible).toBe(2);
  });

  it('starts a turn at every prompt of a replayed history whose replies used tools', () => {
    // ChatService replays a stored tool turn as assistant(tool_use) + its results, so each later
    // prompt follows a tool message.
    const messages: OllamaMessage[] = [text('system', 400, 'sys')];
    for (let turn = 0; turn < 4; turn++)
      messages.push(text('user', 40, `u${turn}`), call('read_file', `a${turn}`), text('tool', 3200, `t${turn}`));
    messages.push(text('user', 40, 'latest'));
    const fit = fitToContext(messages, [], 2048);
    expect(tags(fit.messages)).toEqual(['sys', 'u3', 'a3', 't3', 'latest']);
    expect(fit.visible).toBe(6);
  });
});

describe('shrunkTranscriptChars', () => {
  it('scales the transcript by what Ollama measured, with a margin, leaving room for the reply', () => {
    expect(shrunkTranscriptChars(41_472, 24_584, 16_384, 1536)).toBe(
      Math.floor((41_472 * (16_384 - 1536) * 0.9) / 24_584)
    );
  });
});

describe('localTranscriptChars', () => {
  it('leaves room for the reply and the instruction, at three characters a token', () => {
    expect(localTranscriptChars(16_384, 1536)).toBe((16_384 - 1536 - 1024) * 3);
  });

  it('never goes below a quarter of the window', () => {
    expect(localTranscriptChars(2048, 1536)).toBe(512 * 3);
  });
});

const GIB = 1024 ** 3;
// Shaped like an 8B GQA model (32 layers, 8 KV heads of 128) at Q4, and qwen2.5:0.5b as Ollama reports it.
const eightB: ModelArch = {
  contextMax: 131072,
  blockCount: 32,
  headCount: 32,
  full: { layers: 32, kvHeads: 8, keyLength: 128, valueLength: 128 },
  mtpLayers: 0,
};
const qwenHalfB: ModelArch = {
  contextMax: 32768,
  blockCount: 24,
  headCount: 14,
  full: { layers: 24, kvHeads: 2, keyLength: 64, valueLength: 64 },
  mtpLayers: 0,
};
const cpuMachine = (gib: number): HardwareProfile => ({
  platform: 'linux',
  arch: 'x64',
  memoryKind: 'cpu',
  totalMemoryBytes: gib * GIB,
  gpuMemoryBytes: null,
  gpuName: null,
  gpuCount: 0,
  chip: null,
  diskFreeBytes: null,
  confidence: 'high',
});
// Qwen3-4B-Instruct-2507 Q4_K_M as Ollama reports it.
const fourB: ModelArch = {
  contextMax: 262144,
  blockCount: 36,
  headCount: 32,
  full: { layers: 36, kvHeads: 8, keyLength: 128, valueLength: 128 },
  mtpLayers: 0,
};
const FOUR_B_BYTES = 2_497_283_341;
const lowConfidence = (gib: number): HardwareProfile => ({ ...cpuMachine(gib), confidence: 'low' });
const discrete = (vramGib: number, ramGib: number): HardwareProfile => ({
  ...cpuMachine(ramGib),
  memoryKind: 'discrete',
  gpuMemoryBytes: vramGib * GIB,
  gpuName: 'GPU',
  gpuCount: 1,
});
const unified = (gib: number): HardwareProfile => ({
  ...cpuMachine(gib),
  platform: 'darwin',
  arch: 'arm64',
  memoryKind: 'unified',
  gpuCount: 1,
});
const eightBOn = (hardware: HardwareProfile | number): LocalModelFootprint => ({
  arch: eightB,
  weightsBytes: 4.9 * GIB,
  hardware: typeof hardware === 'number' ? cpuMachine(hardware) : hardware,
});
const fourBOn = (hardware: HardwareProfile): LocalModelFootprint => ({
  arch: fourB,
  weightsBytes: FOUR_B_BYTES,
  hardware,
});
const auto = (footprint: LocalModelFootprint, configured?: number) =>
  chatContextTokens({ setting: AUTO_LOCAL_CONTEXT, footprint, configured });

describe('chatContextTokens', () => {
  it.each([
    { machine: 'CPU 12 GiB', footprint: eightBOn(12), expected: 16384 },
    { machine: 'CPU 20 GiB', footprint: eightBOn(20), expected: 32768 },
    // The estimator's chat target caps it below the model's trained 128K.
    { machine: 'CPU 32 GiB', footprint: eightBOn(32), expected: 65536 },
    { machine: 'CPU 4 GiB, nothing resident', footprint: eightBOn(4), expected: 16384 },
    // 16K fits on the GPU; 32K would move most of the weights to system RAM.
    { machine: 'GPU 8 GiB / RAM 32 GiB', footprint: fourBOn(discrete(8, 32)), expected: 16384 },
    { machine: 'GPU 12 GiB / RAM 32 GiB', footprint: fourBOn(discrete(12, 32)), expected: 32768 },
    { machine: 'GPU 24 GiB / RAM 64 GiB', footprint: fourBOn(discrete(24, 64)), expected: 65536 },
    { machine: 'GPU 8 GiB, nothing resident', footprint: eightBOn(discrete(4, 32)), expected: 16384 },
    { machine: 'unified 8 GiB', footprint: eightBOn(unified(8)), expected: 16384 },
    { machine: 'unified 16 GiB', footprint: fourBOn(unified(16)), expected: 32768 },
    { machine: 'unified 32 GiB', footprint: fourBOn(unified(32)), expected: 65536 },
    // A GPU the probe cannot measure may be there; nothing larger is picked up front.
    { machine: 'low-confidence probe, 62 GiB', footprint: fourBOn(lowConfidence(62)), expected: 16384 },
  ])('Auto on $machine: $expected', ({ footprint, expected }) => {
    expect(auto(footprint)).toBe(expected);
  });

  it("stops at the model's trained length", () => {
    expect(auto({ arch: qwenHalfB, weightsBytes: 397_821_000, hardware: cpuMachine(64) })).toBe(32768);
    expect(
      chatContextTokens({ setting: { mode: 'fixed', tokens: 262144 }, footprint: eightBOn(64), modelLimit: 32768 })
    ).toBe(32768);
  });

  it.each([
    { arch: null, weightsBytes: 4.9 * GIB, hardware: cpuMachine(32) },
    { arch: eightB, weightsBytes: null, hardware: cpuMachine(32) },
    { arch: eightB, weightsBytes: 4.9 * GIB, hardware: null },
    { arch: eightB, weightsBytes: 4.9 * GIB, hardware: cpuMachine(0) },
  ])('stays at 16K without the model shape, its size and the machine', footprint => {
    expect(auto(footprint)).toBe(16384);
    expect(fitsInMemory(footprint, 16384)).toBeUndefined();
  });

  it('honours a larger Modelfile num_ctx only when it stays resident within the trained length', () => {
    expect(auto(eightBOn(16), 4096)).toBe(32768);
    expect(auto(fourBOn(cpuMachine(32)), 98304)).toBe(98304);
    expect(auto(fourBOn(cpuMachine(32)), 262144)).toBe(65536);
    expect(auto(fourBOn(discrete(8, 32)), 32768)).toBe(16384);
    expect(auto(fourBOn(lowConfidence(62)), 40960)).toBe(16384);
    expect(auto({ arch: qwenHalfB, weightsBytes: 397_821_000, hardware: cpuMachine(64) }, 65536)).toBe(32768);
  });
});

describe('fitsInMemory', () => {
  it('counts only a resident plan, while loadsInMemory also counts layers moved to RAM', () => {
    expect(fitsInMemory(eightBOn(16), 20480)).toBe(true);
    expect(fitsInMemory(eightBOn(16), 40960)).toBe(false);
    expect(fitsInMemory(eightBOn(64), 262144)).toBe(false);
    expect(fitsInMemory(fourBOn(discrete(8, 32)), 16384)).toBe(true);
    expect(fitsInMemory(fourBOn(discrete(8, 32)), 32768)).toBe(false);
    expect(loadsInMemory(fourBOn(discrete(8, 32)), 32768)).toBe(true);
    expect(loadsInMemory(eightBOn(16), 40960)).toBe(false);
  });
});

describe('grownContext', () => {
  it('jumps once to the largest resident context, not to the next 4K step', () => {
    expect(grownContext(eightBOn(20), 33_000, undefined, undefined, 32768)).toEqual({ tokens: 57344, slower: false });
    expect(grownContext(fourBOn(discrete(12, 32)), 33_000, undefined, undefined, 32768)).toEqual({
      tokens: 45056,
      slower: false,
    });
  });

  it('grows to the next Settings size anyway when no resident size holds the prompt, and says it is slower', () => {
    expect(grownContext(fourBOn(discrete(8, 32)), 17_000, undefined, undefined, 16384)).toEqual({
      tokens: 32768,
      slower: true,
    });
  });

  it('grows by Settings sizes on a probe that could not measure the GPU', () => {
    expect(grownContext(fourBOn(lowConfidence(62)), 17_000, undefined, undefined, 16384)).toEqual({
      tokens: 32768,
      slower: false,
    });
    expect(grownContext(fourBOn(lowConfidence(62)), 40_000, undefined, undefined, 32768)).toEqual({
      tokens: 65536,
      slower: false,
    });
  });

  it.each([
    {
      why: 'model-limit',
      footprint: { arch: qwenHalfB, weightsBytes: 397_821_000, hardware: cpuMachine(64) },
      measured: 31_000,
    },
    { why: 'unmeasured', footprint: UNMEASURED, measured: 20_000 },
    { why: 'memory', footprint: eightBOn(unified(8)), measured: 17_000 },
    { why: 'memory', footprint: eightBOn(20), measured: 70_000 },
  ])('says why it cannot grow: $why', ({ why, footprint, measured }) => {
    expect(grownContext(footprint, measured, undefined, undefined, 16384)).toEqual({ reason: why });
  });

  it('leaves the reply the room fitToContext reserves', () => {
    for (const measured of [5_000, 17_000, 40_000, 70_001]) {
      const growth = grownContext(fourBOn(lowConfidence(62)), measured, undefined, undefined, 4096);
      const grown = growth.tokens ?? 0;
      expect(grown - Math.min(2048, Math.floor(grown / 4))).toBeGreaterThanOrEqual(measured);
    }
  });
});

describe('overflowTokens', () => {
  it('reads the prompt size from the refusal Ollama sends with truncate off', () => {
    expect(
      overflowTokens('request (10569 tokens) exceeds the available context size (4096 tokens), try increasing it')
    ).toBe(10569);
    expect(overflowTokens('model is busy')).toBeUndefined();
  });
});
