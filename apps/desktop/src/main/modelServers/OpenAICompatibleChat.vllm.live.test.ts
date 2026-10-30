import { describe, expect, it } from 'vitest';
import type { SecretCipher, StoreFile } from '../chat/mcp/McpServerStore';
import type { CompletionRequest } from '../chat/completions';
import type { CompletionStreamEvent } from '../chat/streamEvents';
import { ModelServerRegistry } from './ModelServerRegistry';
import { ModelServerStore } from './ModelServerStore';

// Opt-in check against a real vLLM started as in .claude/work/vllm-desktop/start-vllm.sh: served names
// `qwen-small qwen`, LoRA `sql-lora`, --max-model-len 4096. DESKTOP_LIVE_VLLM_TOOLS says whether it has tool flags.
const URL = process.env.DESKTOP_LIVE_VLLM_URL;
const TOOLS = process.env.DESKTOP_LIVE_VLLM_TOOLS === 'on';

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: plain => Buffer.from(plain, 'utf8'),
  decryptString: encrypted => encrypted.toString('utf8'),
};

function memoryFile(): StoreFile {
  let contents: string | null = null;
  return {
    read: async () => contents,
    write: async next => {
      contents = next;
    },
  };
}

const WEATHER_TOOL = {
  toolSchema: {
    name: 'get_weather',
    description: 'Current weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};

describe.runIf(URL)('live vLLM through ModelServerRegistry', () => {
  async function saved() {
    const quiet = { debug: () => undefined, warn: () => undefined };
    const servers = new ModelServerRegistry({
      store: new ModelServerStore(cipher, memoryFile(), quiet),
      logger: quiet,
    });
    const views = await servers.add({
      address: URL as string,
      credential: { type: 'none' },
      name: 'live vllm',
      kind: 'openai-compatible',
      access: 'chat',
    });
    const view = views[1];
    const runtimeId = `srv-${view.id}`;
    return { servers, view, runtimeId, chat: servers.chatFor(runtimeId)! };
  }

  async function turn(
    chat: NonNullable<ReturnType<ModelServerRegistry['chatFor']>>,
    request: CompletionRequest,
    notices: string[]
  ) {
    const events: CompletionStreamEvent[] = [];
    await chat.stream(
      request,
      event => events.push(event),
      undefined,
      undefined,
      message => notices.push(message)
    );
    return events;
  }

  it('lists the aliases once and the adapter with its base, sized by --max-model-len', async () => {
    const { servers, view, chat, runtimeId } = await saved();
    console.log('view', JSON.stringify({ health: view.health, models: view.models }));
    expect(view.health).toMatchObject({ state: 'online' });
    expect(view.models).toEqual(['qwen-small', 'sql-lora']);
    const models = await servers.models();
    console.log(
      'picker',
      JSON.stringify(models.map(({ name, contextWindow, baseModel }) => ({ name, contextWindow, baseModel })))
    );
    expect(models.map(model => [model.name, model.contextWindow, model.baseModel])).toEqual([
      ['qwen-small', 4096, undefined],
      ['sql-lora', 4096, 'qwen-small'],
    ]);
    expect(await chat.contextTokens(`local:${runtimeId}:qwen`)).toBe(4096);
  }, 120_000);

  it.runIf(TOOLS)(
    'round-trips a tool call',
    async () => {
      const { chat, runtimeId } = await saved();
      const notices: string[] = [];
      const ask: CompletionRequest = {
        model: `local:${runtimeId}:qwen-small`,
        messages: [{ role: 'user', content: 'What is the weather in Paris right now? Use the get_weather tool.' }],
        tools: [WEATHER_TOOL],
        maxTokens: 128,
        sessionId: 'live-1',
      };
      const first = await turn(chat, ask, notices);
      console.log('first', JSON.stringify(first));
      const use = first.find(event => event.type === 'tool_use');
      expect(use?.tools?.[0]).toMatchObject({ name: 'get_weather' });
      const call = use!.tools![0];
      const second = await turn(
        chat,
        {
          ...ask,
          messages: [
            ...ask.messages,
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.arguments) }],
            },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: '21C and clear' }] },
          ],
        },
        notices
      );
      const answer = second.map(event => event.text ?? '').join('');
      console.log('answer', JSON.stringify(answer), JSON.stringify(second.at(-1)));
      expect(answer).toMatch(/21/);
      expect(second.at(-1)).toMatchObject({ stopReason: 'stop' });
      expect(notices).toEqual([]);
    },
    300_000
  );

  it.runIf(!TOOLS)(
    'chats without tools, says why, and shows the hint on the server',
    async () => {
      const { servers, chat, runtimeId } = await saved();
      await expect
        .poll(async () => (await servers.views())[1].toolsHint, { timeout: 30_000 })
        .toMatch(/--enable-auto-tool-choice/);
      const notices: string[] = [];
      const events = await turn(
        chat,
        {
          model: `local:${runtimeId}:qwen-small`,
          messages: [{ role: 'user', content: 'Say hello in three words.' }],
          tools: [WEATHER_TOOL],
          maxTokens: 32,
          sessionId: 'live-2',
        },
        notices
      );
      const text = events.map(event => event.text ?? '').join('');
      console.log('reply', JSON.stringify(text), 'notices', JSON.stringify(notices));
      expect(text.length).toBeGreaterThan(0);
      expect(notices).toHaveLength(1);
      expect((await servers.models()).map(model => model.supportsTools)).toEqual([false, false]);
    },
    300_000
  );
});
