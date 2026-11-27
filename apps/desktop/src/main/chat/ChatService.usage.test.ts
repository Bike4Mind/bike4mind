import { ChatModels, type CompletionRunAttribution, type CompletionRunBudgetState } from '@bike4mind/common';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { type ChatModelOption, type ChatStreamEvent, RUN_BUDGET_STOP } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addUsage, ChatService } from './ChatService';
import { MediaStore } from './media/MediaStore';
import { MessageQueue } from './MessageQueue';
import type { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { promptFootprint } from '../../../test-utils/requestFootprint';
import type { CompletionMessage } from './completions';
import { supportsDeferredTools, type WireTool } from './deferredTools';
import type { TaskContract } from '@shared/orchestration';
import type { CompletionRunMinter } from './completionRuns';

vi.mock('../git/hostGitArgs', async importOriginal =>
  (await import('./plainFolderGit.testHelper')).skipGitOutsideRepositories(await importOriginal())
);

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

describe('addUsage', () => {
  it('sums the round trips of one turn', () => {
    expect(addUsage({ inputTokens: 900, outputTokens: 100 }, { inputTokens: 1200, outputTokens: 50 })).toEqual({
      inputTokens: 2100,
      outputTokens: 150,
    });
  });

  it('keeps an unreported field unreported rather than calling it zero', () => {
    expect(addUsage(undefined, undefined)).toBeUndefined();
    expect(addUsage({ inputTokens: 10 }, { inputTokens: 5 })).toEqual({ inputTokens: 15 });
    expect(addUsage(undefined, { outputTokens: 7 })).toEqual({ outputTokens: 7 });
  });
});

describe('ChatService usage reporting', () => {
  let service: ChatService;
  let store: SessionStore;
  let backend: string;
  let events: ChatStreamEvent[];
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];

  beforeEach(async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-usage-')));
    await writeFile(join(root, 'tiny.txt'), 'z', 'utf8');

    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-usage-sessions-')), 'test-model');
    backend = 'anthropic';
    // Bound per test: a previous service replying late must not push into this test's events.
    const emitted: ChatStreamEvent[] = [];
    events = emitted;
    const opened: PassThrough[] = [];
    streams = opened;
    const boundPost = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      opened.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    post = boundPost;

    service = new ChatService({
      store,
      models: {
        list: async () => ({
          models: [
            { id: 'test-model', name: 'Test', backend },
            { id: ChatModels.CLAUDE_5_SONNET, name: 'Sonnet', backend },
          ],
        }),
        cached: () => [],
      } as unknown as ModelCatalog,
      access: { list: async () => [root] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post: boundPost }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => emitted.push(event),
    });
  });

  it('reports the running total after each round trip, not only with the reply', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'what is here?');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'call_1', name: 'glob_files', arguments: JSON.stringify({ pattern: '*' }) }],
        usage: { inputTokens: 900, outputTokens: 100 },
      })
    );
    streams[0].write(frame('[DONE]'));

    // The first count is available while the turn is still running, which is the whole point:
    // the status line shows a real number without waiting for the reply.
    const first = await vi.waitUntil(() => events.find(event => event.type === 'usage'), {
      timeout: 3000,
      interval: 5,
    });
    expect(first).toMatchObject({ usage: { inputTokens: 900, outputTokens: 100 } });

    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 3000, interval: 5 });
    streams[1].write(frame({ type: 'content', text: 'one file.', usage: { inputTokens: 1200, outputTokens: 40 } }));
    streams[1].write(frame('[DONE]'));

    const done = await vi.waitUntil(() => events.find(event => event.type === 'done'), { timeout: 3000, interval: 5 });
    expect(done).toMatchObject({ usage: { inputTokens: 2100, outputTokens: 140 } });

    const totals = events.filter(event => event.type === 'usage');
    expect(totals).toHaveLength(2);
  });

  it('bills an explore sub-agent to the turn that called it', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'how is this laid out?');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'call_1', name: 'explore', arguments: JSON.stringify({ question: 'what files exist?' }) }],
        usage: { inputTokens: 900, outputTokens: 100 },
      })
    );
    streams[0].write(frame('[DONE]'));

    await vi.waitUntil(() => streams.length === 2, { timeout: 3000, interval: 5 });
    const nested = post.mock.calls[1][1] as { options: { tools: { toolSchema: { name: string } }[] } };
    expect(nested.options.tools.map(tool => tool.toolSchema.name).sort()).toEqual([
      'file_read',
      'glob_files',
      'grep_search',
    ]);
    streams[1].write(frame({ type: 'content', text: 'tiny.txt only.', usage: { inputTokens: 300, outputTokens: 20 } }));
    streams[1].write(frame('[DONE]'));

    await vi.waitUntil(() => streams.length === 3, { timeout: 3000, interval: 5 });
    const resumed = post.mock.calls[2][1] as { messages: { content: unknown }[] };
    expect(JSON.stringify(resumed.messages.at(-1)?.content)).toContain('tiny.txt only.');
    streams[2].write(frame({ type: 'content', text: 'one file.', usage: { inputTokens: 1200, outputTokens: 40 } }));
    streams[2].write(frame('[DONE]'));

    const done = await vi.waitUntil(() => events.find(event => event.type === 'done'), { timeout: 3000, interval: 5 });
    expect(done).toMatchObject({ usage: { inputTokens: 2400, outputTokens: 160 } });
  });

  it('says nothing about tokens when the server reported none', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'hello');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(frame({ type: 'content', text: 'hi' }));
    streams[0].write(frame('[DONE]'));

    const done = await vi.waitUntil(() => events.find(event => event.type === 'done'), { timeout: 3000, interval: 5 });
    expect(done && 'usage' in done ? done.usage : 'missing').toBeUndefined();
    expect(events.some(event => event.type === 'usage')).toBe(false);
  });

  type Wire = { messages: { role: string; content: unknown; cache?: boolean }[] };
  const wireOf = (index: number): Wire => post.mock.calls[index][1] as Wire;
  const markers = (index: number): (boolean | undefined)[] => wireOf(index).messages.map(message => message.cache);

  async function runTwoRoundTurn(): Promise<string> {
    const { id } = await service.createSession();
    await service.send(id, 'what is here?');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'call_1', name: 'glob_files', arguments: JSON.stringify({ pattern: '*' }) }],
        usage: { inputTokens: 900, cacheCreationInputTokens: 4000, outputTokens: 100 },
        credits: { used: 5, usdCost: 0.05 },
      })
    );
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(() => streams.length === 2, { timeout: 3000, interval: 5 });
    streams[1].write(
      frame({
        type: 'content',
        text: 'one file.',
        usage: { inputTokens: 50, cacheReadInputTokens: 4900, outputTokens: 40 },
        credits: { used: 2, usdCost: 0.02 },
      })
    );
    streams[1].write(frame('[DONE]'));
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 3000, interval: 5 });
    return id;
  }

  it('marks the shared half of the system prompt and only the last message, in every round', async () => {
    await runTwoRoundTurn();

    // The system prompt goes as two blocks: what sessions share, then the per-session lines.
    expect(markers(0)).toEqual([true, undefined, true]);
    expect(
      wireOf(0)
        .messages.slice(0, 2)
        .map(message => message.role)
    ).toEqual(['system', 'system']);
    // Round 2 adds an assistant tool_use and a user tool_result: the old breakpoint on the
    // prompt is gone and the new one sits on the tool_result message.
    expect(markers(1)).toEqual([true, undefined, undefined, undefined, true]);
    expect(wireOf(1).messages[4].role).toBe('user');
  });

  it('sends no markers on a backend that would reject the flag', async () => {
    backend = 'bedrock';
    await runTwoRoundTurn();
    expect(markers(0).every(marker => marker === undefined)).toBe(true);
    expect(markers(1).every(marker => marker === undefined)).toBe(true);
  });

  it('never stores a cache flag on the session', async () => {
    const id = await runTwoRoundTurn();
    const stored = JSON.stringify((await store.get(id))?.messages);
    expect(stored).not.toContain('"cache"');
  });

  it('stores each round usage and the turn total, and keeps both off the wire', async () => {
    const id = await runTwoRoundTurn();
    const reply = (await store.get(id))?.messages.at(-1);

    expect(reply?.contextSnapshot).toMatchObject({ model: 'test-model', inputTokens: 4950 });
    expect(reply?.contextSnapshot?.overhead.some(slice => slice.id === 'system-tools')).toBe(true);
    const done = events.find(event => event.type === 'done');
    expect(done && 'contextSnapshot' in done ? done.contextSnapshot : null).toEqual(reply?.contextSnapshot);

    expect(reply?.rounds?.map(round => round.usage)).toEqual([
      { inputTokens: 900, cacheCreationInputTokens: 4000, outputTokens: 100, creditsUsed: 5, usdCost: 0.05 },
      { inputTokens: 50, cacheReadInputTokens: 4900, outputTokens: 40, creditsUsed: 2, usdCost: 0.02 },
    ]);
    expect(reply?.usage).toEqual({
      inputTokens: 950,
      cacheCreationInputTokens: 4000,
      cacheReadInputTokens: 4900,
      outputTokens: 140,
      creditsUsed: 7,
      usdCost: 0.07,
    });

    await service.send(id, 'and again?');
    await vi.waitUntil(() => post.mock.calls.length === 3, { timeout: 3000, interval: 5 });
    expect(JSON.stringify(wireOf(2).messages.slice(1))).not.toMatch(
      /"(usage|contextSnapshot|usdCost|creditsUsed|cacheRead\w*|cacheCreation\w*)"/
    );
  });

  it('stamps each reply with the model its requests went to, and keeps it off the wire', async () => {
    const id = await runTwoRoundTurn();
    expect((await store.get(id))?.messages.at(-1)?.model).toBe('test-model');

    await service.setSessionModel(id, ChatModels.CLAUDE_5_SONNET);
    await service.send(id, 'and again?');
    await vi.waitUntil(() => post.mock.calls.length === 3, { timeout: 3000, interval: 5 });
    expect(JSON.stringify(wireOf(2).messages.slice(1))).not.toContain('"model"');
    streams[2].write(frame({ type: 'content', text: 'sure.' }));
    streams[2].write(frame('[DONE]'));
    await vi.waitUntil(() => events.filter(event => event.type === 'done').length === 2, {
      timeout: 3000,
      interval: 5,
    });

    const replies = (await store.get(id))?.messages.filter(message => message.role === 'assistant');
    expect(replies?.map(reply => reply.model)).toEqual(['test-model', ChatModels.CLAUDE_5_SONNET]);
  });

  it('keeps the request model when the session switches models mid-reply', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'hello');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    await service.setSessionModel(id, ChatModels.CLAUDE_5_SONNET);

    streams[0].write(frame({ type: 'content', text: 'hi' }));
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 3000, interval: 5 });

    expect((await store.get(id))?.messages.at(-1)?.model).toBe('test-model');
  });

  it('stamps the model on a reply that failed', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'hello');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    streams[0].write(frame({ type: 'error', message: 'insufficient credits' }));
    await vi.waitUntil(() => events.some(event => event.type === 'error'), { timeout: 3000, interval: 5 });

    expect((await store.get(id))?.messages.at(-1)).toMatchObject({
      error: 'insufficient credits',
      model: 'test-model',
    });
  });

  it('records the explore sub-loop usage on the tool call', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'how is this laid out?');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'call_1', name: 'explore', arguments: JSON.stringify({ question: 'what files exist?' }) }],
      })
    );
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(() => streams.length === 2, { timeout: 3000, interval: 5 });
    expect(markers(1)).toEqual([true, true]);
    streams[1].write(
      frame({ type: 'content', text: 'tiny.txt', usage: { inputTokens: 300, cacheReadInputTokens: 10 } })
    );
    streams[1].write(frame('[DONE]'));
    await vi.waitUntil(() => streams.length === 3, { timeout: 3000, interval: 5 });
    streams[2].write(frame({ type: 'content', text: 'done' }));
    streams[2].write(frame('[DONE]'));
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 3000, interval: 5 });

    const call = (await store.get(id))?.messages.at(-1)?.toolCalls?.[0];
    expect(call?.detail?.usage).toEqual({ inputTokens: 300, cacheReadInputTokens: 10 });
  });

  it('keeps the last measured snapshot when a later tool round fails', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'read files');
    await vi.waitUntil(() => streams.length === 1, { interval: 5 });
    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'call_1', name: 'glob_files', arguments: '{"pattern":"*"}' }],
        usage: { inputTokens: 50, cacheReadInputTokens: 4900 },
      })
    );
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(() => streams.length === 2, { interval: 5 });
    streams[1].destroy(new Error('connection lost'));
    const failed = await vi.waitUntil(() => events.find(event => event.type === 'error'), { interval: 5 });
    const reply = (await store.get(id))?.messages.at(-1);
    expect(reply?.contextSnapshot?.inputTokens).toBe(4950);
    expect(failed?.type === 'error' && failed.contextSnapshot).toEqual(reply?.contextSnapshot);
  });
});

describe('controlledCost', () => {
  type Arm = { name: string; deferred: 'off' | 'current' | 'zero'; ttl: '5m' | '1h'; compact: boolean };
  const arms: Arm[] = [
    { name: 'reference', deferred: 'current', ttl: '5m', compact: false },
    { name: 'deferred-off', deferred: 'off', ttl: '5m', compact: false },
    { name: 'deferred-zero', deferred: 'zero', ttl: '5m', compact: false },
    { name: 'ttl-only', deferred: 'current', ttl: '1h', compact: false },
    { name: 'compaction-only', deferred: 'current', ttl: '5m', compact: true },
  ];

  type Request = { model: string; messages: CompletionMessage[]; options: { tools?: WireTool[]; cacheTtl?: string } };
  const wait = { timeout: 5000, interval: 5 };
  const frame = (payload: unknown) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;

  // These are capability fixtures, not a claim that either model is available on an evaluation account.
  const models: ChatModelOption[] = [
    { id: 'gpt-6.1-sol', name: 'Fixture broad sweep', backend: 'openai' },
    {
      id: ChatModels.CLAUDE_5_5_OPUS,
      name: 'Fixture final comparison',
      backend: 'anthropic',
      supportsOneHourCache: true,
    },
  ];

  describe('controlled Desktop cost evaluation preparation', () => {
    it('assembles matched isolated arms, counts failed attempts and leaves billing unknown', async () => {
      const pending = [];
      for (const model of models) {
        const effective = new Set<string>();
        for (const arm of arms) {
          const deferred = supportsDeferredTools(model) ? arm.deferred : 'off';
          const ttl = model.supportsOneHourCache ? arm.ttl : '5m';
          const key = JSON.stringify({ deferred, ttl, compact: arm.compact });
          if (effective.has(key)) {
            pending.push({ model: model.id, arm: arm.name, status: 'duplicate-effective-arm-not-run' });
            continue;
          }
          effective.add(key);
          // Each arm has its own folder, store and service, so they run side by side.
          pending.push(runFixture(model, arm));
        }
      }
      const reports = await Promise.all(pending);
      expect(reports.filter(report => 'attempts' in report)).toHaveLength(7);
      const serialized = JSON.stringify({
        kind: 'desktop-controlled-cost-preparation-v1',
        mode: 'dry-run-scripted-completions',
        fixture: 'read-z-v1',
        liveExecution: 'unsupported-no-budget-verifier',
        modelsAreCapabilityFixtures: true,
        reports,
      });
      expect(serialized).not.toContain(tmpdir());
      expect(serialized).not.toContain('Required fixture rule');
      expect(serialized).not.toContain('Read tiny.txt');
      if (process.env.B4M_CONTROLLED_COST_DRY_RUN === '1') console.info(serialized);
    }, 60_000);
  });

  async function runFixture(model: ChatModelOption, arm: Arm) {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), 'b4m-controlled-')));
    const root = join(temporary, 'project');
    await mkdir(root);
    const instructions = join(temporary, 'instructions');
    await mkdir(instructions);
    await writeFile(join(instructions, 'CLAUDE.md'), 'Required fixture rule: preserve evidence.');
    await writeFile(join(root, 'CLAUDE.md'), 'Required project rule: report the character exactly.');
    await writeFile(join(root, 'tiny.txt'), 'z');
    const store = new SessionStore(join(temporary, 'sessions'), model.id);
    const requests: Request[] = [];
    const streams: PassThrough[] = [];
    const attempts: {
      ordinal: number;
      stage: string;
      status: string;
      requestBytes: number;
      blocks: unknown;
      usage: null;
      inputTokens: null;
      outputTokens: null;
      cacheReadTokens: null;
      cacheWrite5mTokens: null;
      cacheWrite1hTokens: null;
      providerUsd: null;
      platformUsd: null;
    }[] = [];
    let stage = 'fresh';
    const post = vi.fn(async (_url: string, body: Request) => {
      const stream = new PassThrough();
      requests.push(body);
      streams.push(stream);
      attempts.push({
        ordinal: attempts.length + 1,
        stage,
        status: stage === 'failure' ? 'scripted-failure' : 'scripted-success',
        requestBytes: Buffer.byteLength(JSON.stringify(body)),
        blocks: promptFootprint(body.messages, body.options.tools ?? []).map(({ block, bytes, estimatedTokens }) => ({
          block,
          bytes,
          estimatedTokens,
        })),
        usage: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWrite5mTokens: null,
        cacheWrite1hTokens: null,
        providerUsd: null,
        platformUsd: null,
      });
      return { data: stream, status: 200 };
    });
    const createService = () =>
      new ChatService({
        store,
        deferredTools:
          arm.deferred === 'off' ? undefined : { startSetMaxTokens: arm.deferred === 'zero' ? 0 : 100_000 },
        models: { list: async () => ({ models: [model] }), cached: () => [model] } as unknown as ModelCatalog,
        access: { list: async () => [root] } as unknown as AccessStore,
        logger: { debug: () => {}, warn: () => {} },
        userInstructionsRoot: instructions,
        getApiClient: () =>
          ({
            get: async () => ({}),
            getAxiosInstance: () => ({ post }),
          }) as unknown as AuthenticatedApiClient,
        getEnvironmentUrl: () => 'http://fixture.invalid',
        emit: () => {},
      });
    let service = createService();
    const reply = (index: number, text: string) => {
      streams[index].write(frame({ type: 'content', text }));
      streams[index].write(frame('[DONE]'));
    };
    try {
      const created = await service.createCodeSession({ directory: root, branch: '', workspace: false });
      if (!created.ok) throw new Error(created.error);
      const { id } = created.session;
      await store.rename(id, 'Controlled fixture');
      await store.setPromptCacheTtl(id, arm.ttl);
      await service.send(id, 'Read tiny.txt and report its single character.');
      await vi.waitUntil(() => requests.length === 1, wait);
      expect(JSON.stringify(requests[0].messages)).toContain('Required fixture rule: preserve evidence.');
      expect(JSON.stringify(requests[0].messages)).toContain('Required project rule: report the character exactly.');
      const declared = requests[0].options.tools ?? [];
      expect(declared.some(tool => tool.toolSchema.name === 'file_read')).toBe(true);
      expect(declared.some(tool => tool.toolSchema.defer_loading)).toBe(
        supportsDeferredTools(model) && arm.deferred !== 'off'
      );
      expect(requests[0].options.cacheTtl ?? '5m').toBe(model.supportsOneHourCache ? arm.ttl : '5m');
      streams[0].write(
        frame({
          type: 'tool_use',
          tools: [
            {
              id: 'fixture-read',
              name: 'file_read',
              arguments: JSON.stringify({ path: join(root, 'tiny.txt') }),
            },
          ],
        })
      );
      streams[0].write(frame('[DONE]'));
      await vi.waitUntil(() => requests.length === 2, wait);
      expect(JSON.stringify(requests[1].messages.at(-1))).toContain('z');
      reply(1, 'It says z.');
      await vi.waitUntil(() => !service.isSessionBusy(id), wait);
      const accepted = (await store.get(id))?.messages.at(-1)?.content === 'It says z.';
      expect(accepted).toBe(true);

      stage = 'warm';
      let before = requests.length;
      await service.send(id, 'Repeat the result.');
      await vi.waitUntil(() => requests.length === before + 1, wait);
      reply(before, 'It says z.');
      await vi.waitUntil(() => !service.isSessionBusy(id), wait);
      if (arm.compact) {
        stage = 'summary';
        before = requests.length;
        const compacted = service.compactContext(id);
        await vi.waitUntil(() => requests.length === before + 1, wait);
        reply(before, 'Read tiny.txt successfully. Its single character is z. Preserve evidence.');
        expect((await compacted).ok).toBe(true);
      }
      service.dispose();
      service = createService();
      stage = 'service-recreation';
      before = requests.length;
      await service.send(id, 'Continue with the result.');
      await vi.waitUntil(() => requests.length === before + 1, wait);
      expect(JSON.stringify(requests[before].messages)).toContain('Required fixture rule: preserve evidence.');
      expect(JSON.stringify(requests[before].messages)).toContain(
        'Required project rule: report the character exactly.'
      );
      expect(JSON.stringify(requests[before].messages)).toContain('z');
      reply(before, 'It says z.');
      await vi.waitUntil(() => !service.isSessionBusy(id), wait);
      expect((await store.get(id))?.messages.at(-1)?.content).toBe('It says z.');

      stage = 'failure';
      before = requests.length;
      await service.send(id, 'Scripted failure control.');
      await vi.waitUntil(() => requests.length === before + 1, wait);
      streams[before].write(frame({ type: 'error', message: 'scripted terminal failure' }));
      await vi.waitUntil(() => !service.isSessionBusy(id), wait);
      expect((await store.get(id))?.messages.at(-1)?.error).toBeTruthy();
      expect(requests).toHaveLength(arm.compact ? 6 : 5);
      return {
        model: model.id,
        arm: arm.name,
        controls: {
          deferred: supportsDeferredTools(model) ? arm.deferred : 'not-applicable',
          ttl: model.supportsOneHourCache ? arm.ttl : 'not-applicable',
          compaction: arm.compact,
        },
        attempts,
        outcomes: {
          scriptedTasks: 2,
          scriptedAccepted: Number(accepted),
          scriptedRejected: 1,
          acceptedLiveResults: null,
        },
        totalProviderUsd: null,
        costPerAcceptedLiveResultUsd: null,
        missing: [
          'provider-usage',
          'provider-pricing-snapshot',
          'platform-charges',
          'cache-cause-attribution',
          'live-acceptance',
          'ttl-boundary-waits',
          'fresh-process-restart',
          'quality-and-latency',
        ],
      };
    } finally {
      service.dispose();
      for (const stream of streams) stream.destroy();
      await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
});

describe('runBudget', () => {
  const RUN_A = '7d0c8f3e-2b1a-4c5d-9e8f-0a1b2c3d4e5f';
  const BUDGET_PATH = `/api/v1/completion-runs/${RUN_A}/budget`;
  const USAGE_PATH = `/api/v1/completion-runs/${RUN_A}/usage`;
  const contract: TaskContract = {
    version: 1,
    outcome: 'Fix the focused behavior',
    rationale: 'Keep scope bounded',
    role: 'implementation',
    paths: ['src/feature.ts'],
    contextReferences: [],
    ownedChanges: ['src/feature.ts'],
    coordinationConstraints: [],
    nonGoals: [],
    acceptanceCriteria: ['Focused test passes'],
    verification: ['pnpm test feature'],
    assumptions: [],
    escalationConditions: ['Public API must change'],
  };
  const frame = (payload: unknown) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
  type Wire = { model: string; run?: CompletionRunAttribution };

  const spend = {
    creditsCharged: 0,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const usage = (budget: CompletionRunBudgetState) => ({
    runId: RUN_A,
    createdAt: '2026-11-10T00:00:00.000Z',
    settled: spend,
    byRole: [],
    byPurpose: [],
    byModel: [],
    byAttempt: [],
    byAttemptTruncated: false,
    budget,
  });

  /** A rejection shaped like axios's for a streamed request: its body is a stream too. */
  const rejection = (status: number, body: Record<string, unknown>) =>
    Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { status, data: Readable.from([Buffer.from(JSON.stringify(body))]) },
    });
  /** The same refusal from a paid media route, where the body is plain JSON, not a stream. */
  const paidRefusal = () =>
    Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { status: 422, data: { error: 'Run budget used up', errorCode: 'run_budget_exhausted' } },
    });
  const exhausted = () => rejection(422, { error: 'Run budget exhausted', errorCode: 'run_budget_exhausted' });

  describe('orchestration run budget', () => {
    let store: SessionStore;
    let service: ChatService;
    let project: string;
    let streams: PassThrough[];
    type Request = (...args: unknown[]) => Promise<unknown>;
    let completions: ReturnType<typeof vi.fn<Request>>;
    let raise: ReturnType<typeof vi.fn<Request>>;
    let get: ReturnType<typeof vi.fn<Request>>;
    /** Client-level post (resolves to the body): the paid media routes. */
    let paid: ReturnType<typeof vi.fn<Request>>;
    /** Client-level get (resolves to the body): the image quest poll. */
    let paidGet: ReturnType<typeof vi.fn<Request>>;
    let mint: ReturnType<typeof vi.fn<CompletionRunMinter>>;
    let events: ChatStreamEvent[];
    let budgetState: CompletionRunBudgetState;
    let storeDirectory: string;
    let deps: ConstructorParameters<typeof ChatService>[0];

    beforeEach(async () => {
      project = await realpath(await mkdtemp(join(tmpdir(), 'b4m-budget-project-')));
      storeDirectory = await mkdtemp(join(tmpdir(), 'b4m-budget-store-'));
      store = new SessionStore(storeDirectory, 'planner');
      const models: ChatModelOption[] = [
        { id: 'planner', name: 'Planner', supportsTools: true },
        { id: 'worker', name: 'Worker', supportsTools: true },
        // A small model for a suggestion request to pick.
        { id: 'claude-haiku-4-5-20251001', name: 'Haiku', supportsTools: true },
      ];
      streams = [];
      events = [];
      budgetState = { budgetCredits: 500, committedCredits: 100, reservedCredits: 0, remainingCredits: 400 };
      completions = vi.fn<Request>().mockImplementation(() => {
        const stream = new PassThrough();
        streams.push(stream);
        return Promise.resolve({ data: stream, status: 200 });
      });
      raise = vi.fn<Request>().mockResolvedValue({ status: 200, data: {} });
      const post = vi.fn((url: string, ...rest: unknown[]) =>
        url === BUDGET_PATH ? raise(url, ...rest) : completions(url, ...rest)
      );
      get = vi.fn<Request>(url =>
        url === USAGE_PATH ? Promise.resolve({ data: usage(budgetState) }) : Promise.reject(new Error(`no ${url}`))
      );
      paidGet = vi.fn<Request>().mockResolvedValue({});
      paid = vi.fn<Request>().mockRejectedValue(new Error('no paid call expected'));
      mint = vi.fn<CompletionRunMinter>().mockResolvedValue({ runId: RUN_A, createdAt: '2026-11-10T00:00:00.000Z' });
      deps = {
        store,
        summaryChanged: vi.fn(),
        access: { list: async () => [] } as unknown as AccessStore,
        models: {
          list: async () => ({ models }),
          cached: () => models,
          listImageModels: async () => ['image-model'],
        } as unknown as ModelCatalog,
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: () =>
          ({
            get: paidGet,
            post: paid,
            getAxiosInstance: () => ({ post, get }),
          }) as unknown as AuthenticatedApiClient,
        getEnvironmentUrl: () => 'http://localhost:3000',
        emit: event => void events.push(event),
        mintCompletionRun: mint,
        media: new MediaStore(await mkdtemp(join(tmpdir(), 'b4m-budget-media-'))),
        // A planner is woken for its agents through the queue.
        queue: new MessageQueue(() => undefined),
      };
      service = new ChatService(deps);
    });
    afterEach(() => {
      vi.restoreAllMocks();
      service.dispose();
      for (const stream of streams) stream.end();
    });

    const wire = (index: number) => completions.mock.calls[index][1] as Wire;
    const created = () =>
      store.create('planner', {
        title: 'Fixed test title',
        mode: 'code',
        project: {
          directory: project,
          workingDirectory: project,
          name: 'Project',
          branch: '',
          workspace: false,
          contextDirectories: [],
        },
      });
    const waitStream = (index: number) => vi.waitUntil(() => streams.length > index, { timeout: 5000, interval: 5 });
    const idle = (id: string) => vi.waitUntil(() => !service.isSessionBusy(id), { timeout: 5000, interval: 5 });
    const finish = (index: number, text = 'Finished') => {
      streams[index].write(frame({ type: 'content', text }));
      streams[index].write(frame('[DONE]'));
    };
    const lastReply = async (id: string) => (await store.get(id))?.messages.at(-1);
    const policyOf = async (id: string) => (await store.get(id))?.orchestrationPolicy;
    const budgeted = async (credits = 500) => {
      const root = await created();
      await service.setSessionOrchestrate(root.id, true, credits);
      return root;
    };
    const toolUse = (...tools: { id: string; name: string; args: object }[]) =>
      frame({
        type: 'tool_use',
        tools: tools.map(tool => ({ id: tool.id, name: tool.name, arguments: JSON.stringify(tool.args) })),
      });
    const notices = (sessionId: string) =>
      events.filter(event => event.type === 'context-notice' && event.sessionId === sessionId);

    it('mints the run with the budget entered when Orchestrate turned on', async () => {
      const root = await budgeted(500);
      expect((await policyOf(root.id))?.budgetCredits).toBe(500);

      await service.send(root.id, 'Plan the work');
      await waitStream(0);

      expect(mint).toHaveBeenCalledWith(expect.any(String), expect.anything(), root.id, 500, {
        organization_id: null,
      });
      expect(wire(0).run?.runId).toBe(RUN_A);
      finish(0);
      await idle(root.id);
    });

    it('pauses the run on run_budget_exhausted with a fixed message, without resending unattributed', async () => {
      const root = await budgeted(500);
      budgetState = { budgetCredits: 500, committedCredits: 500, reservedCredits: 40, remainingCredits: 0 };
      completions.mockImplementationOnce(() => Promise.reject(exhausted()));

      await service.send(root.id, 'Plan the work');
      await idle(root.id);

      expect(completions).toHaveBeenCalledTimes(1);
      const reply = await lastReply(root.id);
      expect(reply?.stopReason).toBe(RUN_BUDGET_STOP);
      expect(reply?.error).toBe(
        'Paused: this orchestration run has used its 500-credit budget (460 spent, 40 reserved). Raise the budget to resume; the work so far is kept.'
      );
      expect((await policyOf(root.id))?.budgetPaused).toBe(true);
      // The user's prompt is kept, so the task's progress is intact for the resume.
      expect((await store.get(root.id))?.messages.some(message => message.content === 'Plan the work')).toBe(true);
    });

    it('refuses later turns of a paused run locally, with no request', async () => {
      const root = await budgeted(500);
      completions.mockImplementationOnce(() => Promise.reject(exhausted()));
      await service.send(root.id, 'Plan the work');
      await idle(root.id);

      await service.send(root.id, 'Try again anyway');
      await idle(root.id);

      expect(completions).toHaveBeenCalledTimes(1);
      expect((await lastReply(root.id))?.stopReason).toBe(RUN_BUDGET_STOP);
    });

    it('resumes the paused turn only after the budget is raised', async () => {
      const root = await budgeted(500);
      completions.mockImplementationOnce(() => Promise.reject(exhausted()));
      await service.send(root.id, 'Plan the work');
      await idle(root.id);

      await expect(service.raiseRunBudget(root.id, 1500)).resolves.toEqual({ ok: true, resumed: 1 });
      expect(raise).toHaveBeenCalledWith(BUDGET_PATH, { budgetCredits: 1500 }, expect.anything());
      // The 80% warning named the old budget, so the raise withdraws it.
      expect(events).toContainEqual({
        type: 'context-notice-cleared',
        sessionId: root.id,
        seq: expect.any(Number),
        kind: 'run-budget',
      });
      await waitStream(0);
      expect(wire(1).run?.runId).toBe(RUN_A);
      finish(0, 'Carried on');
      await idle(root.id);

      const policy = await policyOf(root.id);
      expect(policy?.budgetCredits).toBe(1500);
      expect(policy?.budgetPaused).toBeUndefined();
      const reply = await lastReply(root.id);
      expect(reply?.stopReason).not.toBe(RUN_BUDGET_STOP);
      expect(reply?.error).toBeUndefined();
      expect(reply?.content).toContain('Carried on');
    });

    it('keeps a paused run paused, and resumable, after the app relaunches', async () => {
      const root = await budgeted(500);
      completions.mockImplementationOnce(() => Promise.reject(exhausted()));
      await service.send(root.id, 'Plan the work');
      await idle(root.id);
      const worker = await store.create('worker', {
        origin: { parentSessionId: root.id, depth: 1, seedPrompt: 'Brief' },
        orchestrationPolicy: (await policyOf(root.id))!,
      });
      service.dispose();

      store = new SessionStore(storeDirectory, 'planner', 'relaunched');
      service = new ChatService({ ...deps, store });
      expect((await store.get(root.id))?.orchestrate).toBeUndefined();

      await service.send(root.id, 'Try again after relaunch');
      await idle(root.id);
      await service.send(worker.id, 'Worker turn after relaunch');
      await idle(worker.id);
      expect(completions).toHaveBeenCalledTimes(1);
      expect((await lastReply(root.id))?.stopReason).toBe(RUN_BUDGET_STOP);
      expect((await lastReply(worker.id))?.stopReason).toBe(RUN_BUDGET_STOP);

      await expect(service.raiseRunBudget(root.id, 1500)).resolves.toMatchObject({ ok: true });
      await waitStream(0);
      expect(wire(1).run?.runId).toBe(RUN_A);
      expect(mint).toHaveBeenCalledTimes(1);
    });

    it('drops a usage read that a raise made stale, so the old budget is not warned about', async () => {
      const root = await budgeted(500);
      budgetState = { budgetCredits: 500, committedCredits: 450, reservedCredits: 0, remainingCredits: 50 };
      let release: () => void = () => {};
      get.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            release = () => resolve({ data: usage(budgetState) });
          })
      );

      await service.send(root.id, 'Plan the work');
      await waitStream(0);
      finish(0);
      await idle(root.id);
      await vi.waitUntil(() => get.mock.calls.length >= 1, { timeout: 5000, interval: 5 });
      await expect(service.raiseRunBudget(root.id, 2000)).resolves.toMatchObject({ ok: true });
      release();
      await vi.waitUntil(() => events.some(event => event.type === 'context-notice-cleared'), {
        interval: 5,
        timeout: 5000,
      });
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(notices(root.id)).toHaveLength(0);
      expect((await policyOf(root.id))?.budgetWarnedAt).toBeUndefined();
    });

    it('stays paused when the new budget is not a raise', async () => {
      const root = await budgeted(500);
      completions.mockImplementationOnce(() => Promise.reject(exhausted()));
      await service.send(root.id, 'Plan the work');
      await idle(root.id);
      raise.mockRejectedValueOnce(
        Object.assign(new Error('Conflict'), {
          isAxiosError: true,
          response: { status: 409, data: { error: 'Not raised', errorCode: 'run_budget_not_raised' } },
        })
      );

      await expect(service.raiseRunBudget(root.id, 400)).resolves.toEqual({
        ok: false,
        error: 'Enter a budget above the current 500 credits.',
      });

      expect(completions).toHaveBeenCalledTimes(1);
      expect((await policyOf(root.id))?.budgetPaused).toBe(true);
    });

    it('never sends a budgeted turn unattributed when the server no longer knows the run', async () => {
      const root = await budgeted(500);
      completions.mockImplementationOnce(() =>
        Promise.reject(rejection(404, { error: 'Run not found', errorCode: 'run_not_found' }))
      );

      await service.send(root.id, 'Plan the work');
      await idle(root.id);

      expect(completions).toHaveBeenCalledTimes(1);
      expect((await lastReply(root.id))?.error).toMatch(/budget cannot be enforced/);
      // Kept, not re-minted: a fresh run would restart the budget at zero.
      expect((await policyOf(root.id))?.serverRunId).toBe(RUN_A);
    });

    it('never resends a budgeted auxiliary call unattributed when the server no longer knows the run', async () => {
      const root = await budgeted(500);
      await service.send(root.id, 'Plan the work');
      await waitStream(0);
      finish(0);
      await idle(root.id);
      const sent = completions.mock.calls.length;
      completions.mockImplementationOnce(() =>
        Promise.reject(rejection(404, { error: 'Run not found', errorCode: 'run_not_found' }))
      );

      await service.suggestNextPrompt(root.id).catch(() => undefined);

      expect(completions).toHaveBeenCalledTimes(sent + 1);
      expect(wire(sent).run?.purpose).toBe('suggestion');
      expect((await policyOf(root.id))?.serverRunId).toBe(RUN_A);
    });

    it('never sends a budgeted turn unattributed when the run cannot be minted', async () => {
      mint.mockResolvedValueOnce(undefined);
      const root = await budgeted(500);

      await service.send(root.id, 'Plan the work');
      await idle(root.id);

      expect(completions).not.toHaveBeenCalled();
      expect((await lastReply(root.id))?.error).toMatch(/budgeted run/);
    });

    it('warns once when the run has committed 80% of its budget, showing spent and reserved', async () => {
      const root = await budgeted(500);
      budgetState = { budgetCredits: 500, committedCredits: 410, reservedCredits: 60, remainingCredits: 90 };

      await service.send(root.id, 'Plan the work');
      await waitStream(0);
      finish(0);
      await idle(root.id);
      await vi.waitUntil(() => notices(root.id).length > 0, { timeout: 5000, interval: 5 });

      expect(notices(root.id)).toEqual([
        {
          type: 'context-notice',
          sessionId: root.id,
          seq: expect.any(Number),
          message:
            'This orchestration run has committed 82% of its 500-credit budget (350 spent, 60 reserved, 90 left). It pauses when the budget runs out.',
          kind: 'run-budget',
        },
      ]);

      await service.send(root.id, 'Keep going');
      await waitStream(1);
      finish(1);
      await idle(root.id);
      await vi.waitUntil(() => get.mock.calls.length >= 1, { interval: 5, timeout: 5000 });
      expect(notices(root.id)).toHaveLength(1);
      expect((await policyOf(root.id))?.budgetWarnedAt).toBe(500);
    });

    it('does not warn below 80%', async () => {
      const root = await budgeted(500);
      budgetState = { budgetCredits: 500, committedCredits: 300, reservedCredits: 0, remainingCredits: 200 };

      await service.send(root.id, 'Plan the work');
      await waitStream(0);
      finish(0);
      await idle(root.id);
      await vi.waitUntil(() => get.mock.calls.length >= 1, { timeout: 5000, interval: 5 });

      expect(notices(root.id)).toHaveLength(0);
    });

    it('pauses the whole run when a worker hits the budget, and the raise resumes the worker', async () => {
      const root = await budgeted(500);
      await service.send(root.id, 'Delegate the bounded task');
      await waitStream(0);
      // The worker's first request is refused for the budget; the root's own rounds stream as usual.
      const streamed = completions.getMockImplementation()!;
      let refusedWorker = false;
      completions.mockImplementation((url, rawBody, ...rest) => {
        const body = rawBody as Wire;
        if (body.run?.role === 'worker' && !refusedWorker) {
          refusedWorker = true;
          return Promise.reject(exhausted());
        }
        return streamed(url, body, ...rest);
      });
      streams[0].write(
        frame({
          type: 'tool_use',
          tools: [
            {
              id: 'spawn-0',
              name: 'session_spawn',
              arguments: JSON.stringify({ prompt: 'Do the task', title: 'Fixed child title', contract }),
            },
          ],
        })
      );
      streams[0].write(frame('[DONE]'));

      const worker = await vi.waitUntil(
        async () => (await store.list()).find(session => session.origin?.parentSessionId === root.id),
        { timeout: 5000, interval: 5 }
      );
      await vi.waitUntil(async () => (await lastReply(worker.id))?.stopReason === RUN_BUDGET_STOP, {
        timeout: 5000,
        interval: 5,
      });
      expect((await policyOf(root.id))?.budgetPaused).toBe(true);
      expect(refusedWorker).toBe(true);
      // The root's next round is over the same budget: refused locally, with no request.
      await vi.waitUntil(() => streams.length > 1 || !service.isSessionBusy(root.id), { timeout: 5000, interval: 5 });
      for (let index = 1; index < streams.length; index += 1) finish(index);
      await idle(root.id);
      const before = completions.mock.calls.length;

      const result = await service.raiseRunBudget(worker.id, 2000);
      expect(result.ok).toBe(true);
      await vi.waitUntil(
        () =>
          completions.mock.calls
            .slice(before)
            .some(([, body]) => (body as Wire).run?.role === 'worker' && (body as Wire).run?.runId === RUN_A),
        { timeout: 5000, interval: 5 }
      );
      expect((await policyOf(root.id))?.budgetCredits).toBe(2000);
      expect((await policyOf(root.id))?.budgetPaused).toBeUndefined();
      for (const stream of streams) stream.end();
    });
    /** Streams every request except the ones `refuse` picks, which the server rejects for the budget. */
    const refuseWhen = (refuse: (body: Wire) => boolean | Promise<boolean>) => {
      const streamed = completions.getMockImplementation()!;
      completions.mockImplementation(async (url, rawBody, ...rest) => {
        if (await refuse(rawBody as Wire)) throw exhausted();
        return streamed(url, rawBody, ...rest);
      });
    };
    const spawnWorker = (index: number) => {
      streams[index].write(
        toolUse({
          id: 'spawn-0',
          name: 'session_spawn',
          args: { prompt: 'Do the task', title: 'Fixed child title', contract },
        })
      );
      streams[index].write(frame('[DONE]'));
    };
    const workerOf = (rootId: string) =>
      vi.waitUntil(async () => (await store.list()).find(session => session.origin?.parentSessionId === rootId), {
        timeout: 5000,
        interval: 5,
      });
    /** Whether an agents-settled wake reached the planner's transcript. */
    const rootWokeForAgents = async (rootId: string) =>
      ((await store.get(rootId))?.messages ?? []).some(message => message.automatic?.kind === 'agents-settled');
    const rootRequestsSince = (start: number) =>
      completions.mock.calls.slice(start).filter(([, body]) => (body as Wire).run?.role === 'root').length;

    it('wakes the planner once its worker finishes after a raise that resumed the worker', async () => {
      const root = await budgeted(500);
      await service.send(root.id, 'Delegate the bounded task');
      await waitStream(0);
      // The worker's first request is refused, then the planner's next round over the same spent run.
      let refusedWorker = false;
      let rootCalls = 1;
      refuseWhen(async body => {
        if (body.run?.role === 'worker' && !refusedWorker) {
          refusedWorker = true;
          return true;
        }
        if (body.run?.role !== 'root' || ++rootCalls !== 2) return false;
        await vi.waitUntil(() => refusedWorker, { timeout: 5000, interval: 5 });
        return true;
      });
      spawnWorker(0);
      const worker = await workerOf(root.id);
      await vi.waitUntil(async () => (await lastReply(worker.id))?.stopReason === RUN_BUDGET_STOP, {
        timeout: 5000,
        interval: 5,
      });
      await idle(root.id);
      // The stopped worker's report lands under the planner after its stopped turn, on a timing
      // that varies by machine: wait for it, so the planner's last message is a known one.
      await vi.waitUntil(async () => (await lastReply(root.id))?.reportedChildId === worker.id, {
        timeout: 5000,
        interval: 5,
      });
      const plannerTurn = (await store.get(root.id))?.messages.findLast(message => message.role === 'assistant');
      expect(plannerTurn?.stopReason).toBe(RUN_BUDGET_STOP);
      const opened = streams.length;

      await expect(service.raiseRunBudget(worker.id, 2000)).resolves.toMatchObject({ ok: true });
      // Finish every stream as it opens until the planner has been woken for the finished worker.
      for (let next = opened; !(await rootWokeForAgents(root.id)); next += 1) {
        await vi.waitUntil(() => streams.length > next, { timeout: 5000, interval: 5 });
        finish(next);
        await idle(worker.id);
      }
      for (const stream of streams) stream.end();
    });

    it('resumes a planner whose own turn the budget stopped, even after a worker report landed under it', async () => {
      const root = await budgeted(500);
      await service.send(root.id, 'Delegate the bounded task');
      await waitStream(0);
      let rootCalls = 1;
      // Held until the worker is streaming, so the pause lands while its request is in flight.
      refuseWhen(async body => {
        if (body.run?.role !== 'root' || ++rootCalls !== 2) return false;
        await vi.waitUntil(() => streams.length > 1, { timeout: 5000, interval: 5 });
        return true;
      });
      spawnWorker(0);
      const worker = await workerOf(root.id);
      await vi.waitUntil(async () => (await lastReply(root.id))?.stopReason === RUN_BUDGET_STOP, {
        timeout: 5000,
        interval: 5,
      });
      await idle(root.id);
      expect((await policyOf(root.id))?.budgetPaused).toBe(true);
      expect(deps.summaryChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          id: root.id,
          orchestrationPolicy: expect.objectContaining({ budgetPaused: true }),
        })
      );
      // The worker's request was already streaming when the planner was refused, so it finishes.
      await waitStream(1);
      finish(1);
      await idle(worker.id);
      await vi.waitUntil(async () => (await lastReply(root.id))?.role === 'user', { timeout: 5000, interval: 5 });
      // Not woken while paused: the wake would only be refused for the same budget.
      expect(rootRequestsSince(0)).toBe(2);
      const before = completions.mock.calls.length;

      await expect(service.raiseRunBudget(root.id, 2000)).resolves.toMatchObject({ ok: true });
      await vi.waitUntil(() => rootRequestsSince(before) > 0, { timeout: 5000, interval: 5 });
      await waitStream(2);
      finish(2, 'Summary of the work');
      await idle(root.id);
      expect((await lastReply(root.id))?.content).toContain('Summary of the work');
    });

    it('pauses the run when a paid tool is refused for the budget, and the raise resumes it', async () => {
      const root = await budgeted(500);
      budgetState = { budgetCredits: 500, committedCredits: 480, reservedCredits: 0, remainingCredits: 20 };
      paid.mockRejectedValue(paidRefusal());

      await service.send(root.id, 'Read the summary aloud');
      await waitStream(0);
      streams[0].write(
        frame({
          type: 'tool_use',
          tools: [{ id: 'tts-0', name: 'generate_speech', arguments: JSON.stringify({ text: 'The summary' }) }],
        })
      );
      streams[0].write(frame('[DONE]'));
      await idle(root.id);

      expect(paid).toHaveBeenCalledWith(
        '/api/ai/tts',
        expect.objectContaining({ run: expect.objectContaining({ runId: RUN_A, role: 'root', purpose: 'tool' }) }),
        expect.anything()
      );
      // The model is not asked to carry on past a refused spend: the run stops where it is.
      expect(completions).toHaveBeenCalledTimes(1);
      const reply = await lastReply(root.id);
      expect(reply?.stopReason).toBe(RUN_BUDGET_STOP);
      expect(reply?.toolCalls?.[0]).toMatchObject({ id: 'tts-0', status: 'error' });
      expect(reply?.toolCalls?.[0]?.error).toContain('call this tool again');
      expect((await policyOf(root.id))?.budgetPaused).toBe(true);

      await expect(service.raiseRunBudget(root.id, 1500)).resolves.toEqual({ ok: true, resumed: 1 });
      await waitStream(1);
      expect(wire(1).run?.runId).toBe(RUN_A);
      // The resumed request tells the model the budget is higher, not the stale shortfall.
      const resent = JSON.stringify(completions.mock.calls[1][1]);
      expect(resent).toContain('raised to 1,500 credits: call this tool again now');
      expect(resent).not.toContain('once it resumes');
      finish(1, 'Carried on');
      await idle(root.id);
      expect((await lastReply(root.id))?.stopReason).not.toBe(RUN_BUDGET_STOP);
    });

    it('saves both tool calls of a round when only the first is refused, and stops the turn once', async () => {
      const root = await budgeted(500);
      const setRunBudget = vi.spyOn(store, 'setRunBudget');
      paid
        .mockRejectedValueOnce(paidRefusal())
        .mockResolvedValueOnce({ audio: 'AAAA', contentType: 'audio/mpeg', format: 'mp3' });

      await service.send(root.id, 'Read two lines aloud');
      await waitStream(0);
      streams[0].write(
        toolUse(
          { id: 'tts-0', name: 'generate_speech', args: { text: 'First line' } },
          { id: 'tts-1', name: 'generate_speech', args: { text: 'Second line' } }
        )
      );
      streams[0].write(frame('[DONE]'));
      await idle(root.id);

      expect(paid).toHaveBeenCalledTimes(2);
      expect(completions).toHaveBeenCalledTimes(1);
      const reply = await lastReply(root.id);
      expect(reply?.stopReason).toBe(RUN_BUDGET_STOP);
      expect(reply?.toolCalls?.map(call => call.status).sort()).toEqual(['done', 'error']);
      expect(setRunBudget.mock.calls.filter(call => call[2].budgetPaused === true)).toHaveLength(1);
    });

    it('attributes a worker paid call to the worker and pauses the root run when it is refused', async () => {
      const root = await budgeted(500);
      paid.mockRejectedValue(paidRefusal());
      await service.send(root.id, 'Delegate the bounded task');
      await waitStream(0);
      const streamed = completions.getMockImplementation()!;
      completions.mockImplementation((url, rawBody, ...rest) => {
        const result = streamed(url, rawBody, ...rest);
        if ((rawBody as Wire).run?.role !== 'worker') return result;
        const stream = streams.at(-1)!;
        stream.write(toolUse({ id: 'tts-w', name: 'generate_speech', args: { text: 'Worker line' } }));
        stream.write(frame('[DONE]'));
        return result;
      });
      streams[0].write(
        toolUse({
          id: 'spawn-0',
          name: 'session_spawn',
          args: { prompt: 'Do the task', title: 'Fixed child title', contract },
        })
      );
      streams[0].write(frame('[DONE]'));

      const worker = await vi.waitUntil(
        async () => (await store.list()).find(session => session.origin?.parentSessionId === root.id),
        { timeout: 5000, interval: 5 }
      );
      await vi.waitUntil(async () => (await lastReply(worker.id))?.stopReason === RUN_BUDGET_STOP, {
        timeout: 5000,
        interval: 5,
      });

      expect(paid).toHaveBeenCalledWith(
        '/api/ai/tts',
        expect.objectContaining({
          run: expect.objectContaining({ runId: RUN_A, role: 'worker', purpose: 'tool', taskId: worker.id }),
        }),
        expect.anything()
      );
      expect((await policyOf(root.id))?.budgetPaused).toBe(true);
      for (let index = 1; index < streams.length; index += 1) finish(index);
      await idle(root.id);
    });

    it('pauses the run when the image job is refused for the budget at create', async () => {
      const root = await budgeted(500);
      paid.mockRejectedValue(paidRefusal());

      await service.send(root.id, 'Draw a bicycle');
      await waitStream(0);
      streams[0].write(toolUse({ id: 'img-0', name: 'generate_image', args: { prompt: 'a bicycle' } }));
      streams[0].write(frame('[DONE]'));
      await idle(root.id);

      expect(paid).toHaveBeenCalledWith(
        '/api/v1/image-jobs',
        expect.objectContaining({ run: expect.objectContaining({ runId: RUN_A, role: 'root', purpose: 'tool' }) }),
        expect.anything()
      );
      expect(paidGet).not.toHaveBeenCalledWith(expect.stringContaining('/api/v1/image-jobs/'), expect.anything());
      expect(completions).toHaveBeenCalledTimes(1);
      const reply = await lastReply(root.id);
      expect(reply?.stopReason).toBe(RUN_BUDGET_STOP);
      expect(reply?.toolCalls?.[0]).toMatchObject({ id: 'img-0', status: 'error' });
      expect((await policyOf(root.id))?.budgetPaused).toBe(true);
    });
  });
});
