import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { ChatModels } from '@bike4mind/common';
import type { ChatModelOption } from '@shared/chat';
import { describe, expect, it, vi } from 'vitest';
import { promptFootprint } from '../../../test-utils/requestFootprint';
import { ChatService } from './ChatService';
import type { CompletionMessage } from './completions';
import { supportsDeferredTools, type WireTool } from './deferredTools';
import type { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

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
    const reports = [];
    for (const model of models) {
      const effective = new Set<string>();
      for (const arm of arms) {
        const deferred = supportsDeferredTools(model) ? arm.deferred : 'off';
        const ttl = model.supportsOneHourCache ? arm.ttl : '5m';
        const key = JSON.stringify({ deferred, ttl, compact: arm.compact });
        if (effective.has(key)) {
          reports.push({ model: model.id, arm: arm.name, status: 'duplicate-effective-arm-not-run' });
          continue;
        }
        effective.add(key);
        reports.push(await runFixture(model, arm));
      }
    }
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
      deferredTools: arm.deferred === 'off' ? undefined : { startSetMaxTokens: arm.deferred === 'zero' ? 0 : 100_000 },
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
    expect(JSON.stringify(requests[before].messages)).toContain('Required project rule: report the character exactly.');
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
