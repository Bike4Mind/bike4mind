import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A vLLM stand-in that answers with vLLM's own shapes: ModelCard and ErrorResponse from
 * vllm/entrypoints/serve/engine/protocol.py, the tool-choice refusal from vllm/renderers/online_renderer.py, and
 * the chunk sequence `vllm serve --enable-auto-tool-choice --tool-call-parser hermes` streams for a tool call.
 */
export interface FakeVllm {
  baseUrl: string;
  /** Restarts it with or without `--enable-auto-tool-choice --tool-call-parser hermes`. */
  toolFlags: boolean;
  /** Restarts it with another `--max-model-len`. */
  maxModelLen: number;
  requests: Record<string, unknown>[];
  close(): Promise<void>;
}

export const FAKE_VLLM_SERVED: readonly string[] = ['qwen-small', 'qwen'];
export const FAKE_VLLM_MAX_MODEL_LEN = 4096;
const ROOT = '/models/Qwen2.5-0.5B-Instruct';
const REFUSAL = '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set';

function modelList(maxModelLen: number) {
  const created = Math.floor(Date.now() / 1000);
  const card = (id: string, root: string, parent: string | null, maxModelLen: number | null) => ({
    id,
    object: 'model',
    created,
    owned_by: 'vllm',
    root,
    parent,
    max_model_len: maxModelLen,
    permission: [{ id: `modelperm-${id}`, object: 'model_permission', created, allow_create_engine: false }],
  });
  return {
    object: 'list',
    data: [
      ...FAKE_VLLM_SERVED.map(name => card(name, ROOT, null, maxModelLen)),
      card('sql-lora', '/adapters/sql-lora', FAKE_VLLM_SERVED[0], null),
    ],
  };
}

function chunk(model: string, delta: object, finish: string | null = null) {
  return {
    id: 'chatcmpl-4f1c',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
  };
}

export async function startFakeVllm(options: { toolFlags?: boolean; maxModelLen?: number } = {}): Promise<FakeVllm> {
  const fake = {
    toolFlags: options.toolFlags ?? true,
    maxModelLen: options.maxModelLen ?? FAKE_VLLM_MAX_MODEL_LEN,
    requests: [] as Record<string, unknown>[],
  };
  const server: Server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part as Buffer);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/v1/models') return send(200, modelList(fake.maxModelLen));
    if (req.method === 'GET' && req.url === '/version') return send(200, { version: '0.32.0' });
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return send(404, { detail: 'Not Found' });
    const body = JSON.parse(Buffer.concat(parts).toString('utf8')) as {
      model: string;
      stream?: boolean;
      tools?: unknown[];
      tool_choice?: unknown;
      messages: { role: string }[];
    };
    fake.requests.push(body);
    if (![...FAKE_VLLM_SERVED, 'sql-lora'].includes(body.model))
      return send(404, {
        error: {
          message: `The model \`${body.model}\` does not exist.`,
          type: 'NotFoundError',
          param: 'model',
          code: 404,
        },
      });
    if (body.tools?.length && !fake.toolFlags && (body.tool_choice ?? 'auto') === 'auto')
      return send(400, { error: { message: REFUSAL, type: 'BadRequestError', param: null, code: 400 } });
    if (!body.stream)
      return send(200, {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'p' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 160, completion_tokens: 1, total_tokens: 161 },
      });
    const frames: object[] = [chunk(body.model, { role: 'assistant', content: '' })];
    if (body.messages.at(-1)?.role === 'tool') {
      frames.push(chunk(body.model, { content: 'It is 21C ' }), chunk(body.model, { content: 'in Paris.' }, 'stop'));
    } else if (body.tools?.length) {
      frames.push(
        chunk(body.model, {
          tool_calls: [{ id: 'chatcmpl-tool-9a2b', type: 'function', index: 0, function: { name: 'get_weather' } }],
        }),
        chunk(body.model, { tool_calls: [{ index: 0, function: { arguments: '{"city": "' } }] }),
        chunk(body.model, { tool_calls: [{ index: 0, function: { arguments: 'Paris"}' } }] }),
        chunk(body.model, { content: '' }, 'tool_calls')
      );
    } else {
      frames.push(chunk(body.model, { content: 'Hello.' }, 'stop'));
    }
    frames.push({
      id: 'chatcmpl-4f1c',
      object: 'chat.completion.chunk',
      model: body.model,
      choices: [],
      usage: { prompt_tokens: 210, total_tokens: 230, completion_tokens: 20 },
    });
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(fake, {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  });
}
