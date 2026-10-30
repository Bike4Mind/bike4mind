import { afterEach, describe, expect, it } from 'vitest';
import { startFakeVllm, type FakeVllm } from '../__test__/fakeVllm';
import {
  contextTooSmallHint,
  isToolRefusal,
  probeToolSupport,
  serverContextTokens,
  toolsOffHint,
  type HintApp,
} from './tools';

const fetchLike = (input: string, init?: RequestInit) => fetch(input, init);
const CLI: HintApp = { name: 'the CLI', recheck: 'and the CLI turns them back on at its next check.' };

let vllm: FakeVllm | undefined;
afterEach(async () => {
  await vllm?.close();
  vllm = undefined;
});

describe('isToolRefusal', () => {
  it('matches the vLLM refusal text', () => {
    const body = '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set';
    expect(isToolRefusal(400, body)).toBe(true);
  });

  it("matches llama-server's 500 about tools", () => {
    expect(isToolRefusal(500, 'tools param requires --jinja flag')).toBe(true);
  });

  it('ignores a 400 that does not mention tools, and other statuses', () => {
    expect(isToolRefusal(400, 'max_tokens must be positive')).toBe(false);
    expect(isToolRefusal(404, 'no tools here')).toBe(false);
  });
});

describe('probeToolSupport', () => {
  it('accepts a vLLM started with the tool flags and refuses one without', async () => {
    vllm = await startFakeVllm();
    expect(await probeToolSupport(fetchLike, vllm.baseUrl, 'qwen-small')).toBe('accepted');
    vllm.toolFlags = false;
    expect(await probeToolSupport(fetchLike, vllm.baseUrl, 'qwen-small')).toBe('refused');
  });

  it('says nothing when the server cannot be reached or the model is unknown', async () => {
    vllm = await startFakeVllm();
    expect(await probeToolSupport(fetchLike, vllm.baseUrl, 'missing')).toBeNull();
    const closed = vllm.baseUrl;
    await vllm.close();
    vllm = undefined;
    expect(await probeToolSupport(fetchLike, closed, 'qwen-small', 500)).toBeNull();
  });
});

describe('serverContextTokens', () => {
  it('reads llama-server n_ctx and skips other products', async () => {
    const seen: string[] = [];
    const fake = (input: string) => {
      seen.push(input);
      return Promise.resolve(Response.json({ default_generation_settings: { n_ctx: 8192 } }));
    };
    expect(await serverContextTokens(fake, 'http://h', 'llama-server')).toBe(8192);
    expect(await serverContextTokens(fake, 'http://h', 'vllm')).toBeUndefined();
    expect(seen).toEqual(['http://h/props']);
  });
});

describe('hints', () => {
  it('words the recheck for the app', () => {
    expect(toolsOffHint('gpu', 'vllm', CLI)).toMatch(/--enable-auto-tool-choice.*, and the CLI turns them back on/);
    const small = contextTooSmallHint('gpu', 'vllm', [{ name: 'm', context: 4096 }], 11_500, CLI);
    expect(small).toMatch(/too small for the CLI's instructions/);
    expect(small).toMatch(/--max-model-len 16384, and the CLI turns/);
  });
});
