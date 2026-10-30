import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HardwareProfile } from '@bike4mind/common';
import type { ChatMessage, ChatStreamEvent } from '@shared/chat';
import { autoCompactThreshold, contextTokens, effectiveContextLimit, resentReplyTokens } from '@shared/contextLimit';
import { AUTO_LOCAL_CONTEXT, type LocalContextSetting } from '@shared/localContextSetting';
import { afterEach, expect, it, vi } from 'vitest';
import { describeCompaction, formatTokens } from '../../renderer/src/chat/statusLine';
import { ChatService } from './ChatService';
import { COMPACT_MAX_TOKENS } from './compaction';
import { cpuMachine, discreteMachine, GIB, lowConfidenceMachine, stubArch, unifiedMachine } from './fitStub.testHelper';
import { localTranscriptChars, shrunkTranscriptChars } from './localContext';
import type { ModelCatalog } from './ModelCatalog';
import { forgetLocalContexts, OllamaLocal, type LocalContextSizing } from './OllamaLocal';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  estimateFit: (await import('./fitStub.testHelper')).stubEstimateFit,
}));

interface SentRequest {
  messages: { role: string; content: string }[];
  options?: { num_ctx?: number; num_predict?: number };
}

const services: ChatService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.unstubAllGlobals();
  forgetLocalContexts();
});

const answer = (promptTokens: number) =>
  new Response(
    `${JSON.stringify({
      message: { content: 'A useful summary of the conversation and its current state.' },
      done: true,
      prompt_eval_count: promptTokens,
      eval_count: 12,
    })}\n`
  );

const overflow = (tokens: number, limit: number) =>
  Response.json(
    { error: `request (${tokens} tokens) exceeds the available context size (${limit} tokens), try increasing it` },
    { status: 400 }
  );

/** A stream that sends `first` and then nothing until aborted, like a long prefill. */
const hanging = (signal: AbortSignal | null | undefined, ...first: unknown[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of first) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
        signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      },
    })
  );

/** A stored reply paused on its tool budget after one measured round that read a file. */
function pausedReply(measured: number, preview: string): ChatMessage {
  return {
    id: 'a-paused',
    role: 'assistant',
    content: 'Reading the notes.',
    createdAt: new Date().toISOString(),
    stopReason: 'tool_turn_limit',
    toolCalls: [{ id: 'c0', name: 'read_file', input: { path: 'notes.md' }, status: 'done', preview }],
    rounds: [{ text: 'Reading the notes.', toolCallIds: ['c0'], usage: { inputTokens: measured, outputTokens: 30 } }],
  };
}

async function localService(
  contextWindow: number,
  reply: (request: SentRequest, signal?: AbortSignal | null) => Response,
  catalogCached = true,
  parameters?: string,
  sizing?: LocalContextSizing
) {
  const requests: SentRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/api/tags')) return Response.json({ models: [{ name: 'llama3.2' }] });
      if (String(input).endsWith('/api/show'))
        return Response.json({
          capabilities: ['completion'],
          model_info: { 'llama.context_length': contextWindow },
          ...(parameters === undefined ? {} : { parameters }),
        });
      const request = JSON.parse(String(init?.body)) as SentRequest;
      requests.push(request);
      return reply(request, init?.signal);
    })
  );
  const model = 'local:ollama:llama3.2';
  const option = { id: model, name: 'Local', supportsTools: false, contextWindow };
  const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-local-context-')), model);
  const events: ChatStreamEvent[] = [];
  const service = new ChatService({
    store,
    local: new OllamaLocal(undefined, sizing),
    access: { list: async () => [] } as unknown as AccessStore,
    models: {
      cached: () => (catalogCached ? [option] : null),
      listLocal: async () => [option],
      list: async () => ({ models: [option] }),
    } as unknown as ModelCatalog,
    getApiClient: () => null,
    getEnvironmentUrl: () => '',
    logger: { debug: vi.fn(), warn: vi.fn() },
    emit: event => events.push(event),
  });
  services.push(service);
  const { id } = await service.createSession();
  await service.renameSession(id, 'Keep title');
  const send = async (text: string) => {
    expect(await service.send(id, text)).toMatchObject({ ok: true });
    await vi.waitUntil(() => !service.isSessionBusy(id));
  };
  return { service, store, events, requests, id, send };
}

it('uses measured Ollama input tokens to compact before the next local turn', async () => {
  const { store, events, requests, id, send } = await localService(100, () => answer(90));
  await send('first prompt');
  expect((await store.get(id))?.messages.at(-1)?.usage).toMatchObject({ inputTokens: 90, outputTokens: 12 });
  await send('second prompt');
  expect(requests).toHaveLength(3);
  expect(requests[1].options?.num_predict).toBe(COMPACT_MAX_TOKENS);
  expect(events).toContainEqual({ type: 'auto-compact', sessionId: id, running: true });
  expect((await store.get(id))?.messages.some(message => message.boundary)).toBe(true);
});

it('compacts at the old window when growing the local model fails', async () => {
  const grow = vi.spyOn(OllamaLocal.prototype, 'growFor').mockRejectedValue(new Error('show failed'));
  try {
    const { store, events, requests, id, send } = await localService(100, () => answer(90));
    await send('first prompt');
    await send('second prompt');
    expect(grow).toHaveBeenCalled();
    expect(requests).toHaveLength(3);
    expect(requests[1].options?.num_predict).toBe(COMPACT_MAX_TOKENS);
    expect(events).toContainEqual({ type: 'auto-compact', sessionId: id, running: true });
    expect((await store.get(id))?.messages.some(message => message.boundary)).toBe(true);
  } finally {
    grow.mockRestore();
  }
});

// Signed out, the catalog keeps local models for seconds only, so the turn usually finds nothing cached.
it('drops the oldest turns of an overflowing prompt, says so, and compacts before the next turn', async () => {
  let refuse = false;
  const { store, events, requests, id, send } = await localService(
    32_768,
    () => {
      if (!refuse) return answer(50);
      refuse = false;
      return overflow(17_000, 16_384);
    },
    false
  );
  await send('first prompt');
  refuse = true;
  await send('second prompt');
  expect(requests).toHaveLength(3);
  expect(requests[2].messages.map(message => message.content)).not.toContain('first prompt');
  expect(requests[2].messages.at(-1)?.content).toBe('second prompt');
  expect(events).toContainEqual({ type: 'context-trimmed', sessionId: id, dropped: 2 });
  expect((await store.get(id))?.messages.at(-1)?.usage).toMatchObject({ inputTokens: 17_000 });
  await send('third prompt');
  expect(requests[3].options?.num_predict).toBe(COMPACT_MAX_TOKENS);
  expect(events).toContainEqual({ type: 'auto-compact', sessionId: id, running: true });
});

it('sizes a local summary request to the model window', async () => {
  const { service, requests, id, send } = await localService(4096, () => answer(50));
  for (let turn = 0; turn < 6; turn++) await send(`prompt ${turn} ${'x'.repeat(3000)}`);
  expect(await service.compactContext(id)).toMatchObject({ ok: true });
  const transcript = requests.at(-1)?.messages.at(-1)?.content ?? '';
  expect(transcript).toContain('omitted for length');
  expect(transcript.length).toBeLessThan(localTranscriptChars(4096, COMPACT_MAX_TOKENS) + 200);
});

it('trims a replayed history whose earlier replies used tools, and answers', async () => {
  let refuse = true;
  const { store, events, requests, id, send } = await localService(32_768, () => {
    if (!refuse) return answer(9000);
    refuse = false;
    return overflow(17_000, 16_384);
  });
  const now = new Date().toISOString();
  for (let turn = 0; turn < 4; turn++) {
    const reply = `old answer ${turn}`;
    const user: ChatMessage = { id: `u${turn}`, role: 'user', content: `old question ${turn}`, createdAt: now };
    const assistant: ChatMessage = {
      id: `a${turn}`,
      role: 'assistant',
      content: reply,
      createdAt: now,
      toolCalls: [
        { id: `c${turn}`, name: 'read_file', input: { path: 'a.ts' }, status: 'done', preview: 'body '.repeat(1600) },
      ],
      rounds: [{ text: reply, toolCallIds: [] }],
    };
    await store.appendMessage(id, user);
    await store.appendMessage(id, assistant);
  }
  await send('latest question');
  expect(requests).toHaveLength(2);
  const sent = requests[1].messages.map(message => message.content);
  expect(sent).not.toContain('old question 0');
  expect(sent.at(-1)).toBe('latest question');
  expect(events.some(event => event.type === 'context-trimmed')).toBe(true);
  const last = (await store.get(id))?.messages.at(-1);
  expect(last?.error).toBeUndefined();
  expect(last?.content).toContain('A useful summary');
});

const sizedOn = (setting: LocalContextSetting, hardware: HardwareProfile): LocalContextSizing => {
  const footprint = { arch: stubArch(131_072), weightsBytes: 4 * GIB, hardware };
  return { setting: async () => setting, footprint: async () => footprint, cachedFootprint: () => footprint };
};

it.each([
  // The stub estimator: 72K is the largest context that stays in 13 GiB.
  { label: 'the largest resident size', hardware: unifiedMachine(13), first: 65_536, measured: 60_000, grown: 73_728 },
  {
    label: 'one Settings size on an unmeasured GPU',
    hardware: lowConfidenceMachine(64),
    first: 16_384,
    measured: 15_000,
    grown: 32_768,
  },
])(
  'grows a local model to $label instead of compacting a conversation near its window',
  async ({ hardware, first, measured, grown }) => {
    const { events, requests, send } = await localService(
      131_072,
      () => answer(measured),
      false,
      undefined,
      sizedOn(AUTO_LOCAL_CONTEXT, hardware)
    );
    await send('first prompt');
    await send('second prompt');
    expect(requests.map(request => request.options?.num_ctx)).toEqual([first, grown]);
    expect(events.some(event => event.type === 'auto-compact')).toBe(false);
  }
);

it('compacts at the threshold under a Fixed size, which never grows', async () => {
  const { events, requests, send } = await localService(
    131_072,
    () => answer(15_000),
    false,
    undefined,
    sizedOn({ mode: 'fixed', tokens: 16_384 }, cpuMachine(64))
  );
  await send('first prompt');
  await send('second prompt');
  expect(requests[1].options?.num_predict).toBe(COMPACT_MAX_TOKENS);
  expect(requests.every(request => request.options?.num_ctx === 16_384)).toBe(true);
  expect(events).toContainEqual(expect.objectContaining({ type: 'auto-compact', running: true }));
});

it('tells the conversation when Auto grows the context past what fits on the GPU', async () => {
  // The stub estimator: 16K fits a 7 GiB GPU, and nothing that holds a 25K prompt does.
  const footprint = { arch: stubArch(), weightsBytes: 4 * GIB, hardware: discreteMachine(7, 32) };
  let refuse = true;
  const { events, requests, id, send } = await localService(
    262_144,
    () => {
      if (!refuse) return answer(25_000);
      refuse = false;
      return overflow(25_000, 16_384);
    },
    false,
    undefined,
    { setting: async () => ({ mode: 'auto' }), footprint: async () => footprint, cachedFootprint: () => footprint }
  );
  await send('long prompt');
  expect(requests.map(request => request.options?.num_ctx)).toEqual([16_384, 32_768]);
  expect(events).toContainEqual({
    type: 'context-notice',
    sessionId: id,
    message: expect.stringContaining('replies will be slower'),
  });
});

// Signed out, so the window comes from Ollama, not the catalog.
it.each([
  { label: '8k model', contextLength: 8192, parameters: undefined, numCtx: 8192 },
  // Without a memory estimate Auto cannot show the Modelfile's size stays resident, so it keeps 16K.
  { label: 'Modelfile num_ctx 32768', contextLength: 131_072, parameters: 'num_ctx 32768', numCtx: 16_384 },
])(
  'compacts a $label exactly at the threshold the ring shows, counting the re-sent reply',
  async ({ contextLength, parameters, numCtx }) => {
    const threshold = autoCompactThreshold(effectiveContextLimit(numCtx));
    const measured: number[] = [];
    const { store, requests, id, send } = await localService(
      contextLength,
      () => answer(measured.shift() ?? 50),
      false,
      parameters
    );
    measured.push(1);
    await send('first prompt');
    const resent = resentReplyTokens((await store.get(id))!.messages.at(-1)!);
    expect(resent).toBeGreaterThan(0);
    expect(requests[0].options?.num_ctx).toBe(numCtx);

    // One token under: the next turn goes straight out.
    requests.length = 0;
    measured.push(threshold - resent - 1);
    await send('second prompt');
    measured.push(threshold - resent);
    await send('third prompt');
    expect(requests.map(request => request.options?.num_predict === COMPACT_MAX_TOKENS)).toEqual([false, false]);

    await send('fourth prompt');
    expect(requests[2].options?.num_predict).toBe(COMPACT_MAX_TOKENS);
    expect(requests[2].options?.num_ctx).toBe(numCtx);

    const window = (await new OllamaLocal().models())[0]?.contextWindow ?? null;
    expect(window).toBe(numCtx);
    expect(describeCompaction(effectiveContextLimit(window), window)).toBe(
      `Compacts automatically at ${formatTokens(threshold)}`
    );
  }
);

it('compacts before re-sending the large tool result of a turn that stopped on its budget', async () => {
  const { store, requests, id, send } = await localService(32_768, request => {
    if (request.options?.num_predict === COMPACT_MAX_TOKENS) return answer(400);
    const carriesResult = request.messages.some(message => message.content.includes('BIGRESULT'));
    return carriesResult ? overflow(17_150, 16_384) : answer(1200);
  });
  const now = new Date().toISOString();
  await store.appendMessage(id, { id: 'u0', role: 'user', content: 'refactor the parser', createdAt: now });
  await store.appendMessage(id, {
    id: 'a0',
    role: 'assistant',
    content: 'Reading the parser.',
    createdAt: now,
    stopReason: 'tool_turn_limit',
    toolCalls: [
      {
        id: 'c0',
        name: 'read_file',
        input: { path: 'parser.ts' },
        status: 'done',
        preview: `BIGRESULT ${'x'.repeat(24_000)}`,
      },
    ],
    rounds: [{ text: 'Reading the parser.', toolCallIds: ['c0'], usage: { inputTokens: 11_000, outputTokens: 40 } }],
  });
  await new OllamaLocal().models();
  await send('carry on');
  expect(requests[0].options?.num_predict).toBe(COMPACT_MAX_TOKENS);
});

it('compacts before re-sending a reply whose artifact the wire puts back', async () => {
  const { store, requests, id, send } = await localService(32_768, request =>
    request.messages.some(message => message.content.includes('ARTIFACTBODY')) ? answer(16_150) : answer(1200)
  );
  const now = new Date().toISOString();
  await store.appendMessage(id, { id: 'u0', role: 'user', content: 'make me a landing page', createdAt: now });
  await store.appendMessage(id, {
    id: 'a0',
    role: 'assistant',
    content: 'Here is the page.',
    createdAt: now,
    usage: { inputTokens: 7000, outputTokens: 9100 },
    artifacts: [
      {
        id: 'art1',
        type: 'html',
        mimeType: 'text/html',
        title: 'Landing',
        content: `<!-- ARTIFACTBODY -->${'<div>x</div>'.repeat(3000)}`,
      },
    ],
  });
  await new OllamaLocal().models();
  await send('make the button blue');
  expect(requests[0].options?.num_predict).toBe(COMPACT_MAX_TOKENS);
});

it('keeps the promised compaction when a trimmed reply is stopped', async () => {
  let phase = 'answer';
  const { service, events, requests, id, send } = await localService(32_768, (request, signal) => {
    if (request.options?.num_predict === COMPACT_MAX_TOKENS) return answer(300);
    if (phase === 'refuse') {
      phase = 'hang';
      return overflow(17_000, 16_384);
    }
    if (phase === 'hang') {
      phase = 'answer';
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { content: 'Partial' } })}\n`));
            signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
          },
        })
      );
    }
    return answer(phase === 'first' ? 3000 : 50);
  });
  await new OllamaLocal().models();
  phase = 'first';
  await send('first prompt');
  phase = 'refuse';
  expect(await service.send(id, 'second prompt')).toMatchObject({ ok: true });
  await vi.waitUntil(() => events.some(event => event.type === 'delta' && event.text.includes('Partial')));
  service.stop(id);
  await vi.waitUntil(() => !service.isSessionBusy(id));

  const before = requests.length;
  await send('third prompt');
  expect(requests[before].options?.num_predict).toBe(COMPACT_MAX_TOKENS);
  expect(events.filter(event => event.type === 'context-trimmed')).toHaveLength(1);
});

it('stores a reply that thinks until the window is full as a length stop, keeping its reasoning', async () => {
  const frames = [
    { message: { content: '', thinking: 'Weighing the options at length.' }, done: false },
    { message: { content: '' }, done: true, done_reason: 'length', prompt_eval_count: 900, eval_count: 15_000 },
  ];
  const { store, id, send } = await localService(
    16_384,
    () => new Response(`${frames.map(frame => JSON.stringify(frame)).join('\n')}\n`)
  );
  await send('think hard');
  const last = (await store.get(id))?.messages.at(-1);
  expect(last?.stopReason).toBe('max_tokens');
  expect(last?.rounds?.at(-1)?.reasoning).toContain('Weighing the options');
});

it('keeps the measured size of a trimmed round stopped before its first token, after a tool round', async () => {
  let phase = 'answer';
  const { service, store, events, requests, id, send } = await localService(32_768, (request, signal) => {
    if (request.options?.num_predict === COMPACT_MAX_TOKENS) return answer(300);
    if (phase === 'refuse') {
      phase = 'hang';
      return overflow(16_410, 16_384);
    }
    if (phase === 'hang') {
      phase = 'answer';
      return hanging(signal);
    }
    return answer(50);
  });
  await new OllamaLocal().models();
  const now = new Date().toISOString();
  for (let turn = 0; turn < 3; turn++) {
    await store.appendMessage(id, { id: `u${turn}`, role: 'user', content: `old question ${turn}`, createdAt: now });
    await store.appendMessage(id, {
      id: `a${turn}`,
      role: 'assistant',
      content: `old answer ${turn} ${'words '.repeat(300)}`,
      createdAt: now,
      usage: { inputTokens: 1000 * (turn + 1), outputTokens: 300 },
    });
  }
  await store.appendMessage(id, { id: 'u-last', role: 'user', content: 'summarise my notes', createdAt: now });
  await store.appendMessage(id, pausedReply(13_300, 'notes '.repeat(100)));

  phase = 'refuse';
  expect(await service.continueReply(id)).toMatchObject({ ok: true });
  await vi.waitUntil(() => events.some(event => event.type === 'context-trimmed'));
  service.stop(id);
  await vi.waitUntil(() => !service.isSessionBusy(id));
  expect(contextTokens((await store.get(id))?.messages.at(-1))).toBe(16_410);

  const before = requests.length;
  await send('next question');
  expect(requests[before].options?.num_predict).toBe(COMPACT_MAX_TOKENS);
});

it('counts the measured round tool results when the round after it was stopped mid-reply', async () => {
  let phase = 'answer';
  const preview = `// notes.ts\n${'export const value = computeSomething(input, options);\n'.repeat(480)}`;
  const { service, store, events, requests, id, send } = await localService(32_768, (request, signal) => {
    if (request.options?.num_predict === COMPACT_MAX_TOKENS) return answer(300);
    if (phase === 'stream') {
      phase = 'answer';
      return hanging(signal, { message: { content: 'Partial answer' }, done: false });
    }
    return answer(50);
  });
  await new OllamaLocal().models();
  const now = new Date().toISOString();
  await store.appendMessage(id, { id: 'u-last', role: 'user', content: 'summarise my notes', createdAt: now });
  await store.appendMessage(id, pausedReply(9000, preview));

  phase = 'stream';
  expect(await service.continueReply(id)).toMatchObject({ ok: true });
  await vi.waitUntil(() => events.some(event => event.type === 'delta' && event.text.includes('Partial')));
  service.stop(id);
  await vi.waitUntil(() => !service.isSessionBusy(id));

  const before = requests.length;
  await send('next question');
  expect(requests[before].options?.num_predict).toBe(COMPACT_MAX_TOKENS);
});

it('compacts before re-sending a Devanagari reply that fills the window', async () => {
  const hindi = String.fromCodePoint(0x0915, 0x093e, 0x092e, 0x0020).repeat(1000);
  let first = true;
  const { requests, send } = await localService(32_768, request => {
    if (request.options?.num_predict === COMPACT_MAX_TOKENS) return answer(300);
    if (!first) return answer(15_300);
    first = false;
    return new Response(
      `${JSON.stringify({ message: { content: hindi }, done: true, prompt_eval_count: 12_000, eval_count: 3000 })}\n`
    );
  });
  await new OllamaLocal().models();
  await send('please answer in Hindi');
  const before = requests.length;
  await send('and again');
  expect(requests[before].options?.num_predict).toBe(COMPACT_MAX_TOKENS);
});

it('retries a refused summary with a transcript shrunk by what Ollama measured', async () => {
  let refuseSummary = true;
  const { service, requests, id, send } = await localService(32_768, request => {
    if (request.options?.num_predict !== COMPACT_MAX_TOKENS || !refuseSummary) return answer(50);
    refuseSummary = false;
    return overflow(30_000, 16_384);
  });
  const chinese = String.fromCharCode(0x4e2d, 0x6587);
  for (let turn = 0; turn < 6; turn++) await send(`prompt ${turn} ${chinese.repeat(1500)}`);
  expect(await service.compactContext(id)).toMatchObject({ ok: true });
  const summaries = requests.filter(request => request.options?.num_predict === COMPACT_MAX_TOKENS);
  expect(summaries).toHaveLength(2);
  const [first, second] = summaries.map(request => request.messages.at(-1)?.content ?? '');
  expect(second).toContain('omitted for length');
  expect(second.length).toBeLessThan(shrunkTranscriptChars(first.length, 30_000, 16_384, COMPACT_MAX_TOKENS) + 200);
});

it('keeps the model and its tools for a local turn whose catalog /api/show timed out', async () => {
  let listing = false;
  let timedOut = 0;
  const requests: { tools?: unknown[] }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/api/tags')) return Response.json({ models: [{ name: 'llama3.2' }] });
      if (String(input).endsWith('/api/show')) {
        if (listing && ++timedOut) throw new DOMException('timed out', 'TimeoutError');
        return Response.json({ capabilities: ['completion', 'tools'] });
      }
      requests.push(JSON.parse(String(init?.body)) as { tools?: unknown[] });
      return answer(50);
    })
  );
  const local = new OllamaLocal();
  const slowList = async () => {
    listing = true;
    try {
      return await local.models();
    } finally {
      listing = false;
    }
  };
  const model = 'local:ollama:llama3.2';
  const service = new ChatService({
    store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-local-context-')), model),
    local,
    access: { list: async () => [] } as unknown as AccessStore,
    models: {
      cached: () => null,
      listLocal: slowList,
      list: async () => ({ models: await slowList() }),
    } as unknown as ModelCatalog,
    getApiClient: () => null,
    getEnvironmentUrl: () => '',
    logger: { debug: vi.fn(), warn: vi.fn() },
    emit: () => undefined,
  });
  services.push(service);
  const { id } = await service.createSession();
  await service.renameSession(id, 'Keep title');
  expect(await service.send(id, 'hello')).toMatchObject({ ok: true });
  await vi.waitUntil(() => !service.isSessionBusy(id));
  expect(timedOut).toBeGreaterThan(0);
  expect(requests[0].tools?.length).toBeGreaterThan(0);
});
