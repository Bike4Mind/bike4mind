import { describe, it, expect, vi } from 'vitest';
import type { ChatRequest } from 'ollama';
import type { IMessage } from '@bike4mind/common';
import { OllamaBackend } from './ollamaBackend';
import { buildIdentityReminder } from './identityReminder';
import type { ICompletionOptionTools } from './backend';

const MODEL = 'qwen2.5-coder:3b';
const REMINDER = buildIdentityReminder(MODEL);
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as never;

function makeBackend(chatResponses: unknown[]) {
  const backend = new OllamaBackend('http://localhost:11434', silentLogger);
  const chat = vi.fn<(request: ChatRequest) => Promise<unknown>>();
  chatResponses.forEach(r => chat.mockResolvedValueOnce(r));
  (backend as unknown as { _api: unknown })._api = { chat };
  return { backend, chat };
}

const answer = (content: string) => ({ message: { content, tool_calls: [] }, prompt_eval_count: 1, eval_count: 1 });

async function run(backend: OllamaBackend, messages: IMessage[], options: Record<string, unknown> = {}) {
  await backend.complete(MODEL, messages, { stream: false, ...options } as never, async () => {});
}

const systemContents = (request: ChatRequest) =>
  request.messages.filter(message => message.role === 'system').map(message => String(message.content));

const reminderCount = (request: ChatRequest) =>
  systemContents(request).join('\n').split('<platform_identity>').length - 1;

describe('OllamaBackend identity reminder', () => {
  it('appends the reminder to the caller system message by default', async () => {
    const { backend, chat } = makeBackend([answer('ok')]);

    await run(backend, [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' },
    ]);

    expect(systemContents(chat.mock.calls[0][0])).toEqual([`You are terse.\n\n${REMINDER}`]);
  });

  it('appends the reminder to the last system message only', async () => {
    const { backend, chat } = makeBackend([answer('ok')]);

    await run(backend, [
      { role: 'system', content: 'first layer' },
      { role: 'system', content: 'last layer' },
      { role: 'user', content: 'hi' },
    ]);

    expect(chat.mock.calls[0][0].messages).toEqual([
      { role: 'system', content: 'first layer' },
      { role: 'system', content: `last layer\n\n${REMINDER}` },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('prepends a system message when the call carries none', async () => {
    const { backend, chat } = makeBackend([answer('ok')]);

    await run(backend, [{ role: 'user', content: 'hi' }]);

    expect(systemContents(chat.mock.calls[0][0])).toEqual([REMINDER]);
  });

  it('sends no reminder when the caller opts out', async () => {
    const { backend, chat } = makeBackend([answer('ok')]);

    await run(backend, [{ role: 'user', content: 'hi' }], { omitIdentityReminder: true });

    expect(systemContents(chat.mock.calls[0][0])).toEqual([]);
  });

  it('sends the caller system message unappended when the caller opts out', async () => {
    const { backend, chat } = makeBackend([answer('ok')]);

    await run(
      backend,
      [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'hi' },
      ],
      { omitIdentityReminder: true }
    );

    expect(chat.mock.calls[0][0].messages).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' },
    ]);
  });

  // The tool round recurses with the caller's original message array: appending in place
  // would stack one reminder per round.
  it('carries exactly one reminder on every round of a tool loop', async () => {
    const toolFn = vi.fn(async () => '4');
    const tool: ICompletionOptionTools = {
      toolFn,
      toolSchema: {
        name: 'math_evaluate',
        description: 'Evaluate math',
        parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
      },
    };
    const { backend, chat } = makeBackend([
      {
        message: {
          content: '',
          tool_calls: [{ function: { name: 'math_evaluate', arguments: { expression: '2+2' } } }],
        },
        prompt_eval_count: 5,
        eval_count: 1,
      },
      answer('The answer is 4.'),
    ]);

    await run(backend, [{ role: 'user', content: 'go' }], { executeTools: true, tools: [tool] });

    expect(chat).toHaveBeenCalledTimes(2);
    for (const call of chat.mock.calls) expect(reminderCount(call[0])).toBe(1);
  });

  // Applied after the strip: the reminder belongs on what is actually sent, so a tool-ordering
  // system prompt that the strip removes must not carry the identity line away with it.
  it('prepends the reminder after stripping a requiresTool system message', async () => {
    const tool: ICompletionOptionTools = {
      toolFn: vi.fn(async () => '4'),
      toolSchema: {
        name: 'math_evaluate',
        description: 'Evaluate math',
        parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
      },
    };
    const { backend, chat } = makeBackend([answer('ok')]);

    await run(
      backend,
      [
        { role: 'user', content: 'go' },
        { role: 'system', content: 'You MUST call math_evaluate.', requiresTool: 'math_evaluate' },
      ],
      { executeTools: true, tools: [tool], _internal: { toolCallCount: 0, maxToolCalls: 0 } }
    );

    expect(systemContents(chat.mock.calls[0][0])).toEqual([REMINDER]);
  });
});
