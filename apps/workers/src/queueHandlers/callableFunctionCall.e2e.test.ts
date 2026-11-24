import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import type { SQSEvent } from 'aws-lambda';
import {
  CALLABLE_FUNCTION_RESULT_MAX_BYTES,
  calculateContentHash,
  parseFunctionContract,
  type FunctionContract,
} from '@bike4mind/common';
import {
  Artifact,
  ArtifactContent,
  CallableFunction,
  CallableFunctionCall,
  CallableFunctionResult,
  callableFunctionResultRepository,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import type { CallableFunctionRunner } from '@bike4mind/server-utils/callableFunctions/runtimeRunner';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

/**
 * Asynchronous calls end to end on a real database: the dispatcher's refusals before anything is queued, one call-log
 * row from `queued` to finished, the result document's cap and 24 hours, the caller-only read, and a real Pyodide
 * run that outlives its limit.
 */

const h = vi.hoisted(() => ({ enabled: true, limitMs: 30_000, limitFails: false }));

vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({ dispatchWithLogger: (fn: unknown) => fn }));
vi.mock('@bike4mind/server-utils/callableFunctions/access', () => ({
  resolveCallableFunctionsEnabled: async () => h.enabled,
}));
vi.mock('@bike4mind/server-utils/callableFunctions/timeLimit', () => ({
  resolveCallableFunctionTimeLimitMs: async () => {
    if (h.limitFails) throw new Error('settings unavailable');
    return h.limitMs;
  },
}));

const { queueFunctionCall, readFunctionCall, runQueuedFunctionCall } =
  await import('@bike4mind/server-utils/callableFunctions/asyncCalls');
const { CALLABLE_FUNCTION_QUEUED_MAX_TIMEOUT_MS } =
  await import('@bike4mind/server-utils/callableFunctions/runtimeParent');
const { createInProcessCallableFunctionRunner } =
  await import('@bike4mind/server-utils/callableFunctions/runtimeRunner');
const { handleCallableFunctionCallRecords } = await import('./callableFunctionCall');

vi.setConfig({ testTimeout: Math.max(MONGO_TEST_TIMEOUT_MS, 120_000), hookTimeout: MONGO_TEST_TIMEOUT_MS });

const OWNER = { id: 'owner-1' };
const STRANGER = { id: 'stranger-1' };

const SOURCE = `
FUNCTION = {"name": "beam_midspan_deflection"}

def run(load, span):
    if load < 0:
        while True:
            pass
    return {"deflection": load * span / 384}
`;

const parsed = parseFunctionContract({
  name: 'beam_midspan_deflection',
  description: 'Midspan deflection of a simply supported beam under a uniform load.',
  inputs: {
    type: 'object',
    additionalProperties: false,
    required: ['load', 'span'],
    properties: {
      load: { type: 'number', unit: 'N/m' },
      span: { type: 'number', unit: 'm' },
      notes: { type: 'array', items: { type: 'string' } },
    },
  },
  outputs: {
    type: 'object',
    additionalProperties: false,
    required: ['deflection'],
    properties: { deflection: { type: 'number', unit: 'm' } },
  },
});
if (!parsed.ok) throw new Error('fixture contract must parse');
const CONTRACT: FunctionContract = parsed.contract;

const ARGS = { load: 384, span: 2 };

const okRunner = (): CallableFunctionRunner & { mock: { calls: unknown[][] } } =>
  vi.fn(async () => ({
    outcome: 'ok' as const,
    outputs: { deflection: 2 },
    durationMs: 5,
    runtime: { lockHash: 'a'.repeat(64), packages: [] },
  }));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

let mongo: Awaited<ReturnType<typeof createMongoServer>>;
let functionId: string;

async function seedFunction(overrides: Record<string, unknown> = {}): Promise<string> {
  const artifactId = `artifact-${new mongoose.Types.ObjectId().toString()}`;
  const contentHash = calculateContentHash(SOURCE);
  const content = await ArtifactContent.create({
    artifactId,
    version: 1,
    content: SOURCE,
    contentHash,
    contentSize: Buffer.byteLength(SOURCE),
  });
  await Artifact.create({
    id: artifactId,
    type: 'python',
    title: 'Beam deflection',
    version: 1,
    userId: OWNER.id,
    permissions: { canRead: [], canWrite: [], canDelete: [] },
    contentId: content._id,
    contentHash,
    contentSize: Buffer.byteLength(SOURCE),
  });
  const fn = await CallableFunction.create({
    ownerType: 'user',
    ownerKey: OWNER.id,
    userId: OWNER.id,
    slug: CONTRACT.name,
    description: CONTRACT.description,
    state: 'live',
    enabled: true,
    pin: {
      artifactId,
      version: 1,
      contentHash: createHash('sha256').update(SOURCE).digest('hex'),
      source: SOURCE,
      pinnedAt: new Date(),
      seq: 1,
    },
    contract: CONTRACT,
    trustLabel: 'unverified',
    ...overrides,
  });
  return String(fn._id);
}

const queue = async (
  args: Record<string, unknown> = ARGS,
  options: { id?: string; caller?: { id: string }; runner?: CallableFunctionRunner | null } = {}
) => {
  const sent: { callId: string }[] = [];
  const call = await queueFunctionCall(
    { caller: options.caller ?? OWNER, functionId: options.id ?? functionId, args, surface: 'rest', apiKeyId: 'key-1' },
    { send: async job => sent.push(job), runner: options.runner === undefined ? okRunner() : options.runner }
  );
  return { call, sent };
};

const rows = () => CallableFunctionCall.find({}).lean();
const event = (body: unknown): SQSEvent =>
  ({ Records: [{ messageId: 'm1', body: JSON.stringify(body) }] }) as unknown as SQSEvent;

beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri());
  await CallableFunctionResult.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  h.enabled = true;
  h.limitMs = 30_000;
  h.limitFails = false;
  vi.unstubAllEnvs();
  await Promise.all([
    CallableFunctionCall.deleteMany({}),
    CallableFunctionResult.deleteMany({}),
    CallableFunction.deleteMany({}),
    Artifact.deleteMany({}),
    ArtifactContent.deleteMany({}),
  ]);
  functionId = await seedFunction();
});

describe('refusals before anything is queued', () => {
  it.each([
    ['the setting is off', async () => ((h.enabled = false), queue()), 'refused', 'setting_off'],
    ['the function does not exist', () => queue(ARGS, { id: '6b0000000000000000000009' }), 'refused', 'not_found'],
    ['the caller is not the owner', () => queue(ARGS, { caller: STRANGER }), 'refused', undefined],
    [
      'the function is turned off',
      async () => {
        await CallableFunction.updateOne({ _id: functionId }, { $set: { enabled: false } });
        return queue();
      },
      'refused',
      'disabled',
    ],
    [
      'the artifact was deleted',
      async () => {
        const fn = await CallableFunction.findById(functionId);
        await Artifact.updateOne({ id: fn!.pin.artifactId }, { $set: { deletedAt: new Date() } });
        return queue();
      },
      'refused',
      'source_deleted',
    ],
    ['an input does not fit', () => queue({ load: 'heavy', span: 2 }), 'input_invalid', undefined],
    [
      'the input is over the cap',
      // A string field is capped at 2000 characters, so the 5 MiB is a list of full-length strings.
      () => queue({ load: 1, span: 2, notes: Array.from({ length: 2800 }, () => 'x'.repeat(2000)) }),
      'input_invalid',
      'input_too_large',
    ],
    ['no runtime is configured', () => queue(ARGS, { runner: null }), 'refused', 'runtime_unavailable'],
  ])('%s', async (_name, run, outcome, reason) => {
    const { call, sent } = await run();
    expect(call.outcome).toBe(outcome);
    if (reason) expect(call.reason).toBe(reason);
    expect(sent).toEqual([]);
    expect(await CallableFunctionResult.countDocuments({})).toBe(0);
    const log = await rows();
    expect(log).toHaveLength(1);
    expect(log[0].outcome).toBe(outcome);
  });
});

describe('a queued call', () => {
  it('keeps one call-log row from queued through running to finished, and runs once', async () => {
    const { call, sent } = await queue();
    expect(call.outcome).toBe('queued');
    expect(sent).toEqual([{ callId: call.callId }]);
    expect((await rows()).map(r => r.outcome)).toEqual(['queued']);
    expect(await readFunctionCall(OWNER, call.callId)).toMatchObject({ state: 'queued' });

    const seen: string[] = [];
    const runner: CallableFunctionRunner = async () => {
      seen.push(String((await CallableFunctionCall.findById(call.callId).lean())?.outcome));
      seen.push(String((await readFunctionCall(OWNER, call.callId))?.state));
      return {
        outcome: 'ok',
        outputs: { deflection: 2 },
        durationMs: 5,
        runtime: { lockHash: 'a'.repeat(64), packages: [] },
      };
    };
    const ran = await runQueuedFunctionCall({ callId: call.callId }, { runner });
    expect(seen).toEqual(['running', 'running']);
    expect(ran?.outcome).toBe('ok');
    expect(await runQueuedFunctionCall({ callId: call.callId }, { runner })).toBeNull();
    expect(seen).toHaveLength(2);

    const log = await rows();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ outcome: 'ok', surface: 'rest', apiKeyId: 'key-1' });
    const result = await readFunctionCall(OWNER, call.callId);
    expect(result).toMatchObject({ state: 'finished', outcome: 'ok', outputs: { deflection: 2 } });
    expect(result?.stamp).toMatchObject({ function_id: functionId, surface: 'rest', pin_seq: 1 });
    expect((await CallableFunctionResult.findOne({ callId: call.callId }).lean())?.input).toBeUndefined();
  });

  it("passes the organization's time limit to the run, within what the consumer can wait", async () => {
    const limits: unknown[] = [];
    const runner: CallableFunctionRunner = async payload => {
      limits.push(payload.limits?.timeoutMs);
      return { outcome: 'ok', outputs: { deflection: 2 }, durationMs: 5 };
    };
    h.limitMs = 300_000;
    await runQueuedFunctionCall({ callId: (await queue()).call.callId }, { runner });
    h.limitMs = 825_000;
    await runQueuedFunctionCall({ callId: (await queue()).call.callId }, { runner });
    expect(limits).toEqual([300_000, CALLABLE_FUNCTION_QUEUED_MAX_TIMEOUT_MS]);
  });

  it('ends timeout when the run outlives its limit in the real runtime', async () => {
    const pyodideDir = realpathSync(path.dirname(createRequire(import.meta.url).resolve('pyodide')));
    const childPath = path.resolve(import.meta.dirname, '../callableFunctions/child.ts');
    vi.stubEnv('CALLABLE_FUNCTION_CHILD_PATH', childPath);
    vi.stubEnv('CALLABLE_FUNCTION_PYODIDE_DIR', pyodideDir);
    const runner = createInProcessCallableFunctionRunner({ childPath, pyodideDir });
    h.limitMs = 2_000;
    const { call } = await queue({ load: -1, span: 2 }, { runner });

    await handleCallableFunctionCallRecords(event({ callId: call.callId }), logger);

    const log = await rows();
    expect(log).toHaveLength(1);
    expect(log[0].outcome).toBe('timeout');
    expect(await readFunctionCall(OWNER, call.callId)).toMatchObject({ state: 'finished', outcome: 'timeout' });
  });

  it('drops a malformed job without touching any call', async () => {
    const { call } = await queue();
    await handleCallableFunctionCallRecords(event({ callId: 'nope' }), logger);
    await handleCallableFunctionCallRecords(
      { Records: [{ messageId: 'm2', body: '{' }] } as unknown as SQSEvent,
      logger
    );
    expect((await rows())[0].outcome).toBe('queued');
    expect(await readFunctionCall(OWNER, call.callId)).toMatchObject({ state: 'queued' });
  });

  it('marks the row and result error when the run cannot be started', async () => {
    const { call } = await queue();
    h.limitFails = true;
    await expect(runQueuedFunctionCall({ callId: call.callId }, { runner: okRunner() })).rejects.toThrow(
      'settings unavailable'
    );
    expect((await rows()).map(r => [r.outcome, r.reason])).toEqual([['error', 'dispatch_failed']]);
    expect(await readFunctionCall(OWNER, call.callId)).toMatchObject({
      state: 'finished',
      outcome: 'error',
      reason: 'dispatch_failed',
    });
  });

  describe('when the worker is lost after its claim', () => {
    const claimAndAge = async (ageMs: number) => {
      const { call } = await queue();
      await callableFunctionResultRepository.claim(call.callId);
      await CallableFunctionCall.updateOne({ _id: call.callId }, { $set: { outcome: 'running' } });
      await CallableFunctionResult.collection.updateOne(
        { callId: call.callId },
        { $set: { updatedAt: new Date(Date.now() - ageMs) } }
      );
      await handleCallableFunctionCallRecords(event({ callId: call.callId }), logger);
      return call.callId;
    };

    it('ends the result and the row as error worker_lost once it has run past 900 s', async () => {
      const callId = await claimAndAge(901_000);
      expect(await readFunctionCall(OWNER, callId)).toMatchObject({
        state: 'finished',
        outcome: 'error',
        reason: 'worker_lost',
      });
      expect((await rows()).map(r => [r.outcome, r.reason])).toEqual([['error', 'worker_lost']]);
    });

    it('leaves a call a live worker may still be running as running', async () => {
      const callId = await claimAndAge(800_000);
      expect(await readFunctionCall(OWNER, callId)).toMatchObject({ state: 'running' });
      expect((await rows()).map(r => r.outcome)).toEqual(['running']);
    });
  });

  it('marks the row and result error when the job cannot be sent', async () => {
    const call = await queueFunctionCall(
      { caller: OWNER, functionId, args: ARGS, surface: 'rest' },
      { send: async () => Promise.reject(new Error('queue down')), runner: okRunner() }
    );
    expect(call).toMatchObject({ outcome: 'error', reason: 'queue_failed' });
    expect((await rows()).map(r => [r.outcome, r.reason])).toEqual([['error', 'queue_failed']]);
    expect(await readFunctionCall(OWNER, call.callId)).toMatchObject({ state: 'finished', outcome: 'error' });
  });
});

describe('reading a result', () => {
  it("answers another caller's id as it answers a made-up or malformed one", async () => {
    const { call } = await queue();
    expect(await readFunctionCall(OWNER, call.callId)).not.toBeNull();
    expect(await readFunctionCall(STRANGER, call.callId)).toBeNull();
    expect(await readFunctionCall(OWNER, new mongoose.Types.ObjectId().toString())).toBeNull();
    expect(await readFunctionCall(OWNER, 'not-an-id')).toBeNull();
  });

  it('reads nothing once the result is 24 hours old, before the TTL index removes it', async () => {
    const { call } = await queue();
    await runQueuedFunctionCall({ callId: call.callId }, { runner: okRunner() });
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000 - 1000);
    await CallableFunctionResult.collection.updateOne({ callId: call.callId }, { $set: { createdAt: dayAgo } });
    expect(await CallableFunctionResult.countDocuments({ callId: call.callId })).toBe(1);
    expect(await readFunctionCall(OWNER, call.callId)).toBeNull();
  });

  it('expires results after 24 hours through a TTL index on createdAt', async () => {
    const ttl = (await CallableFunctionResult.collection.indexes()).find(i => i.name === 'callablefnresult_ttl');
    expect(ttl).toMatchObject({ key: { createdAt: 1 }, expireAfterSeconds: 86_400 });
  });

  it('stores no outputs over the 5 MB cap and reads output_too_large instead', async () => {
    const { call } = await queue();
    await callableFunctionResultRepository.claim(call.callId);
    const big = { deflection: 1, samples: 'x'.repeat(CALLABLE_FUNCTION_RESULT_MAX_BYTES) };
    expect(await callableFunctionResultRepository.finish(call.callId, { outcome: 'ok', outputs: big })).toBe(
      'output_too_large'
    );
    const stored = await readFunctionCall(OWNER, call.callId);
    expect(stored).toMatchObject({ state: 'finished', outcome: 'output_too_large', reason: 'result_too_large' });
    expect(stored?.outputs).toBeUndefined();

    const { call: small } = await queue();
    const fits = { deflection: 1, samples: 'x'.repeat(CALLABLE_FUNCTION_RESULT_MAX_BYTES - 64) };
    expect(await callableFunctionResultRepository.finish(small.callId, { outcome: 'ok', outputs: fits })).toBe('ok');
  });
});
