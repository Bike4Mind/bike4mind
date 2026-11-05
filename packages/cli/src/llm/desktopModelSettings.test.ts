import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMessage } from '@bike4mind/common';
import { OllamaBackend, type OllamaModelFacts } from '@bike4mind/llm-adapters';
import {
  DesktopModelSettingsError,
  desktopModelSettingsFiles,
  desktopRequestSettings,
  desktopRuntimeIdForHost,
  ollamaRequestSettings,
  readDesktopModelSettings,
} from './desktopModelSettings.js';

const QWEN = 'local:ollama:qwen3:8b';
const silent = { debug() {}, info() {}, warn() {}, error() {} } as never;

const facts = (over: Partial<OllamaModelFacts> = {}): OllamaModelFacts => ({
  capabilities: ['completion', 'tools'],
  modelInfo: {},
  trainedContext: 40960,
  defaultNumCtx: 32768,
  ...over,
});

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'b4m-model-settings-'));
  file = path.join(dir, 'model-settings.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const writeSettings = (models: unknown) => writeFile(file, JSON.stringify({ models }));

describe('desktopModelSettingsFiles', () => {
  it("reads model-settings.json in each of Desktop's userData folders", () => {
    expect(desktopModelSettingsFiles({ platform: 'linux', env: {}, home: '/home/u' })).toEqual([
      '/home/u/.config/@bike4mind/desktop/model-settings.json',
      '/home/u/.config/Bike4Mind/model-settings.json',
    ]);
    expect(desktopModelSettingsFiles({ platform: 'darwin', env: {}, home: '/Users/u' })?.[0]).toBe(
      '/Users/u/Library/Application Support/@bike4mind/desktop/model-settings.json'
    );
    expect(
      desktopModelSettingsFiles({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } })?.[0]
    ).toBe('C:\\Users\\u\\AppData\\Roaming\\@bike4mind\\desktop\\model-settings.json');
    expect(desktopModelSettingsFiles({ platform: 'linux', env: { B4M_DESKTOP_USER_DATA: '/data' } })).toEqual([
      '/data/model-settings.json',
    ]);
  });

  it('takes a file from B4M_DESKTOP_MODEL_SETTINGS, or none when it is off', () => {
    expect(desktopModelSettingsFiles({ env: { B4M_DESKTOP_MODEL_SETTINGS: ' /tmp/mine.json ' } })).toEqual([
      '/tmp/mine.json',
    ]);
    for (const off of ['off', 'OFF', '0', 'false', 'none']) {
      expect(desktopModelSettingsFiles({ env: { B4M_DESKTOP_MODEL_SETTINGS: off } })).toBeNull();
      expect(desktopRequestSettings('ollama', { env: { B4M_DESKTOP_MODEL_SETTINGS: off } })).toBeUndefined();
    }
  });
});

describe('readDesktopModelSettings', () => {
  it('reads no settings when no file exists', async () => {
    expect(await readDesktopModelSettings([file, path.join(file, 'below')], QWEN)).toEqual({});
  });

  it('uses the first file that exists', async () => {
    const second = path.join(dir, 'second.json');
    await writeFile(second, JSON.stringify({ models: { [QWEN]: { keepAlive: 300 } } }));
    expect(await readDesktopModelSettings([path.join(dir, 'missing.json'), second], QWEN)).toEqual({ keepAlive: 300 });
  });

  it('reads one model and leaves values this version does not support unset', async () => {
    await writeSettings({
      [QWEN]: { keepAlive: 3600, effort: 'ultra', generation: { temperature: 0.6, topK: 1.5 }, futureField: 1 },
    });
    expect(await readDesktopModelSettings([file], QWEN)).toEqual({ keepAlive: 3600, generation: { temperature: 0.6 } });
  });

  it('fails only the model whose entry is broken, naming the file, the model and the field', async () => {
    await writeSettings({ [QWEN]: { generation: { temperature: 'hot' } }, 'local:ollama:other': { keepAlive: -1 } });
    const failure = readDesktopModelSettings([file], QWEN);
    await expect(failure).rejects.toBeInstanceOf(DesktopModelSettingsError);
    await expect(failure).rejects.toThrow(
      `Desktop's model settings file ${file} has an invalid "generation.temperature" for "${QWEN}".`
    );
    expect(await readDesktopModelSettings([file], 'local:ollama:other')).toEqual({ keepAlive: -1 });
  });

  it('names an entry that is not a set of settings', async () => {
    await writeSettings({ [QWEN]: 7 });
    await expect(readDesktopModelSettings([file], QWEN)).rejects.toThrow(
      `has an entry for "${QWEN}" that is not a set of settings`
    );
  });

  it.each([
    ['{"models": ', 'is not valid JSON'],
    ['[]', 'does not hold model settings'],
    ['{"models": []}', 'does not hold model settings'],
  ])('rejects a file holding %s for every model', async (text, problem) => {
    await writeFile(file, text);
    await expect(readDesktopModelSettings([file], QWEN)).rejects.toThrow(`${file} ${problem}`);
    await expect(readDesktopModelSettings([file], 'local:ollama:other')).rejects.toThrow(problem);
  });

  it('rejects a path it cannot read rather than reading no settings', async () => {
    await mkdir(file);
    await expect(readDesktopModelSettings([file], QWEN)).rejects.toThrow(`${file} could not be read (EISDIR)`);
  });

  it('never takes a model id from the object prototype', async () => {
    await writeFile(file, '{"models": {"__proto__": {"keepAlive": -1}}}');
    expect(await readDesktopModelSettings([file], '__proto__')).toEqual({});
    expect(await readDesktopModelSettings([file], 'toString')).toEqual({});
  });
});

describe('desktopRuntimeIdForHost', () => {
  it.each([
    ['http://127.0.0.1:11434', 'ollama'],
    ['http://localhost:11434/', 'ollama'],
    ['http://[::1]:11434', 'ollama'],
    ['http://127.0.0.1:11500', null],
    ['https://127.0.0.1:11434', null],
    ['http://gpu-box:11434', null],
    ['not a url', null],
  ])('%s is %s', (host, id) => {
    expect(desktopRuntimeIdForHost(host)).toBe(id);
  });
});

describe('ollamaRequestSettings', () => {
  it('sends a fixed context, at most the trained length', () => {
    expect(ollamaRequestSettings({ context: { mode: 'fixed', tokens: 16384 } }, facts()).numCtx).toBe(16384);
    expect(ollamaRequestSettings({ context: { mode: 'fixed', tokens: 65536 } }, facts()).numCtx).toBe(40960);
    expect(
      ollamaRequestSettings({ context: { mode: 'fixed', tokens: 65536 } }, facts({ trainedContext: undefined })).numCtx
    ).toBe(65536);
  });

  it("keeps the CLI's own size under Auto, lowered to the model's cap", () => {
    expect(ollamaRequestSettings({ context: { mode: 'auto' } }, facts()).numCtx).toBeUndefined();
    expect(ollamaRequestSettings({ context: { mode: 'auto', maxTokens: 16384 } }, facts()).numCtx).toBe(16384);
    expect(ollamaRequestSettings({ context: { mode: 'auto', maxTokens: 131072 } }, facts()).numCtx).toBe(32768);
  });

  it('sends keep_alive, sampling and max output as Ollama names them', () => {
    expect(
      ollamaRequestSettings(
        {
          keepAlive: -1,
          generation: {
            temperature: 0.6,
            topP: 0.95,
            topK: 20,
            minP: 0,
            repeatPenalty: 1.05,
            presencePenalty: 1.5,
            maxOutputTokens: 8192,
            thinkingBudgetTokens: 4096,
          },
        },
        facts()
      )
    ).toEqual({
      keepAlive: -1,
      options: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, repeat_penalty: 1.05, presence_penalty: 1.5 },
      maxOutputTokens: 8192,
    });
  });

  it('sends draft tokens only to a model that can speculate', () => {
    const draft = { draftTokens: 0 };
    expect(ollamaRequestSettings(draft, facts()).options).toBeUndefined();
    expect(ollamaRequestSettings(draft, facts({ modelInfo: { 'qwen35.nextn_predict_layers': 1 } })).options).toEqual({
      draft_num_predict: 0,
    });
    const modelfile = `FROM /s/blobs/sha256-${'a'.repeat(64)}\nDRAFT /s/blobs/sha256-${'b'.repeat(64)}\n`;
    expect(ollamaRequestSettings({ draftTokens: 4 }, facts({ modelfile })).options).toEqual({ draft_num_predict: 4 });
    expect(
      ollamaRequestSettings(draft, facts({ modelInfo: { 'qwen35.nextn_predict_layers': Number.NaN } })).options
    ).toBeUndefined();
  });

  it("sends a model's effort only where its template names effort levels", () => {
    const gptOss = facts({ capabilities: ['completion', 'thinking'], thinkingValues: ['low', 'medium', 'high'] });
    expect(ollamaRequestSettings({ effort: 'high' }, gptOss).think).toBe('high');
    expect(ollamaRequestSettings({ effort: 'xhigh' }, gptOss).think).toBe('high');
    expect(ollamaRequestSettings({ effort: 'none' }, gptOss).think).toBe('low');
    expect(
      ollamaRequestSettings({ effort: 'none' }, { ...gptOss, thinkingValues: [false, 'none', 'low', 'high'] }).think
    ).toBe(false);
    expect(
      ollamaRequestSettings({ effort: 'high' }, facts({ capabilities: ['completion', 'thinking'] })).think
    ).toBeUndefined();
    expect(
      ollamaRequestSettings({ effort: 'high' }, facts({ capabilities: ['completion'], thinkingValues: ['high'] })).think
    ).toBeUndefined();
  });
});

describe('Desktop settings on a CLI Ollama turn', () => {
  const reply = { message: { content: 'ok', tool_calls: [] }, prompt_eval_count: 1, eval_count: 1 };

  function backend() {
    const ollama = new OllamaBackend('http://127.0.0.1:11434', silent, {
      requestSettings: desktopRequestSettings('ollama', { env: { B4M_DESKTOP_MODEL_SETTINGS: file } }),
    });
    const chat = vi.fn(async (_request: Record<string, unknown>) => reply);
    (ollama as unknown as { _api: unknown })._api = {
      chat,
      show: vi.fn(async () => ({
        capabilities: ['completion', 'tools'],
        model_info: { 'qwen3.context_length': 40960 },
      })),
      list: vi.fn(async () => ({ models: [{ name: 'qwen3:8b' }, { name: 'other:1b' }] })),
    };
    return { ollama, chat };
  }

  const send = (ollama: OllamaBackend, model: string) =>
    ollama.complete(
      model,
      [{ role: 'user', content: 'hi' }] as unknown as IMessage[],
      { temperature: 0.7 },
      async () => {}
    );

  it("applies the model's settings to the request and lists its context", async () => {
    await writeSettings({
      [QWEN]: { context: { mode: 'fixed', tokens: 16384 }, keepAlive: 3600, generation: { temperature: 0.6 } },
    });
    const { ollama, chat } = backend();
    await send(ollama, 'qwen3:8b');
    expect(chat.mock.calls[0][0]).toMatchObject({
      keep_alive: 3600,
      options: { num_ctx: 16384, temperature: 0.6 },
    });
    const listed = await ollama.getModelInfo();
    expect(listed.map(model => [model.id, model.contextWindow])).toEqual([
      ['qwen3:8b', 16384],
      ['other:1b', 32768],
    ]);
  });

  it('fails only the turn of the model whose entry is broken', async () => {
    await writeSettings({ [QWEN]: { keepAlive: '1h' } });
    const { ollama, chat } = backend();
    await expect(send(ollama, 'qwen3:8b')).rejects.toThrow(`has an invalid "keepAlive" for "${QWEN}"`);
    expect(chat).not.toHaveBeenCalled();
    await send(ollama, 'other:1b');
    expect(chat.mock.calls[0][0]).toMatchObject({ options: { num_ctx: 32768, temperature: 0.7 } });
    expect(chat.mock.calls[0][0]).not.toHaveProperty('keep_alive');
  });

  it('sends what it always did when there is no settings file', async () => {
    const { ollama, chat } = backend();
    await send(ollama, 'qwen3:8b');
    expect(chat.mock.calls[0][0]).toMatchObject({ options: { num_ctx: 32768, temperature: 0.7 } });
    expect(chat.mock.calls[0][0]).not.toHaveProperty('keep_alive');
    expect(chat.mock.calls[0][0]).not.toHaveProperty('think');
  });

  it('picks up a fix to the file on the next turn', async () => {
    await writeSettings({ [QWEN]: { keepAlive: '1h' } });
    const { ollama, chat } = backend();
    await expect(send(ollama, 'qwen3:8b')).rejects.toThrow(DesktopModelSettingsError);
    await writeSettings({ [QWEN]: { keepAlive: 300 } });
    await send(ollama, 'qwen3:8b');
    expect(chat.mock.calls[0][0]).toMatchObject({ keep_alive: 300 });
  });
});
