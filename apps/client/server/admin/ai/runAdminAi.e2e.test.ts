import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { z } from 'zod';
import {
  AdminAiConfigSchema,
  type AdminAiConfig,
  type DecisionModelId,
  type DecisionQuestion,
  type DecisionResponse,
  type ModelInfo,
} from '@bike4mind/common';
import { AdminAiAttemptModel, AdminAiSuggestionModel, Cache, adminAiSuggestionRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { DecisionProviderError } from '@bike4mind/utils/decisionProviders';
import { DecisionRequestError } from '@bike4mind/server-utils/decisions/decisionErrors';
import type { ExecuteDecisionParams, ExecutedDecision } from '@bike4mind/server-utils/decisions/executeDecision';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { completionCeilingUsd, completionUsd } from '@bike4mind/server-utils/billing/meterPlatformCompletion';
import { toMicroUsd } from '@bike4mind/server-utils/decisions/platformDecision';
import { readAdminAiSpend } from './budget';
import { adminAiTextOutputSchema, runAdminAi, type AdminAiRunInput, type RunAdminAiDeps } from './runAdminAi';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await Cache.syncIndexes();
  await AdminAiSuggestionModel.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map(c => c.deleteMany({})));
});

const logger = new Logger({ metadata: { test: 'runAdminAi' } });
const MODEL = 'decision-model' as DecisionModelId;

const config = (overrides: { feature?: Record<string, unknown>; root?: Record<string, unknown> } = {}) =>
  AdminAiConfigSchema.parse({
    enabled: true,
    monthlyCapUsd: 10,
    ...overrides.root,
    features: {
      abuseAssessment: { mode: 'shadow', dailyBudgetUsd: 1, maxCallsPerDay: 10, ...overrides.feature },
      feedbackTriage: { mode: 'shadow', dailyBudgetUsd: 1, maxCallsPerDay: 10, ...overrides.feature },
      dlqTriage: { mode: 'shadow', dailyBudgetUsd: 1, maxCallsPerDay: 10, ...overrides.feature },
    },
  } as unknown as AdminAiConfig);

const QUESTION: DecisionQuestion = {
  type: 'choice',
  name: 'verdict',
  instructions: 'Is this abuse?',
  choices: [{ value: 'abuse' }, { value: 'legitimate' }],
};

// A realistic detection carrying every identifier kind the payload must not leak.
const EVIDENCE = {
  userId: '64b7f0c2a1b2c3d4e5f60718',
  email: 'jane.doe@example.com',
  lastIp: '203.0.113.42',
  fingerprint: 'fp-9a8b7c6d5e4f',
  note: 'signed up from 198.51.100.7 as jane.doe@example.com, account 64b7f0c2a1b2c3d4e5f60718',
  requests: 42,
};

const decisionInput = (overrides: Partial<AdminAiRunInput> = {}): AdminAiRunInput => ({
  entityType: 'shadowDetection',
  entityId: 'det-1',
  evidence: EVIDENCE,
  evidenceLinks: ['/admin/security/detections/det-1'],
  policyVersion: 'v1',
  question: QUESTION,
  ...overrides,
});

const response = (p: number): DecisionResponse =>
  ({
    id: 'd1',
    object: 'decision',
    model: 'decision-model-2026',
    answers: [
      {
        type: 'choice',
        name: 'verdict',
        choice: 'abuse',
        probabilities: [
          { value: 'abuse', probability: p },
          { value: 'legitimate', probability: 1 - p },
        ],
        confidence: 2 * p - 1,
      },
    ],
    usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
  }) as DecisionResponse;

/** Reserves and settles through the real accounting, like executeDecision does. */
const decideStub = (impl: () => DecisionResponse | Promise<DecisionResponse> = () => response(0.9)) =>
  vi.fn(async (params: ExecuteDecisionParams): Promise<ExecutedDecision> => {
    const settlement = await params.accounting.reserve({ decisionId: 'd1', maxCostUsd: 0.01 });
    try {
      const res = await impl();
      await settlement.settle({
        decisionId: 'd1',
        provider: 'openai',
        model: params.model,
        inputTokens: 10,
        outputTokens: 1,
        costUsd: 0.002,
      });
      return { response: res, costUsd: 0.002, creditsCharged: 0, retries: 0 };
    } catch (error) {
      await settlement.fail();
      throw error;
    }
  });

const decisionDeps = (decide: RunAdminAiDeps['decide'], cfg = config()): RunAdminAiDeps => ({
  loadConfig: async () => cfg,
  callableDecisionModel: async model => model ?? MODEL,
  decide,
  logger,
});

const TEXT_MODEL = {
  id: 'text-model',
  type: 'text',
  backend: 'openai',
  max_tokens: 4096,
  pricing: { 200_000: { input: 3 / 1e6, output: 15 / 1e6 } },
} as unknown as ModelInfo;

const textDeps = (replies: (string | Error)[], cfg = config()) => {
  const complete = vi.fn(
    async (
      _model: string,
      _messages: unknown,
      _options: unknown,
      cb: (parts: string[], info: Record<string, number>) => Promise<void>
    ) => {
      const next = replies.shift();
      if (next instanceof Error) throw next;
      await cb([next ?? ''], { inputTokens: 100, outputTokens: 50 });
    }
  );
  const deps: RunAdminAiDeps = {
    loadConfig: async () => cfg,
    textBackend: async () => ({ modelInfo: TEXT_MODEL, llm: { complete } as never }),
    logger,
  };
  return { complete, deps };
};

const textInput = (): AdminAiRunInput => ({
  entityType: 'feedback',
  entityId: 'fb-1',
  evidence: { body: 'The export button does nothing' },
  policyVersion: 'v1',
  prompt: { system: 'Triage this feedback.', outputSchema: adminAiTextOutputSchema },
});

const GOOD = JSON.stringify({ verdict: 'bug', confidence: 0.9, reasons: ['Export fails'] });

describe('runAdminAi decision path', () => {
  it('stores a pending suggestion with cost, latency and input-sourced evidence links', async () => {
    let t = 1000;
    const decide = decideStub();
    const result = await runAdminAi('abuseAssessment', decisionInput(), {
      ...decisionDeps(decide),
      now: () => (t += 25),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cached).toBe(false);
    expect(result.suggestion).toMatchObject({
      status: 'pending',
      verdict: 'abuse',
      escalated: false,
      model: 'decision-model-2026',
      costUsd: 0.002,
      latencyMs: 25,
      confidence: { band: 'high', probability: 0.9 },
    });
    expect(result.suggestion.reasons[0].evidenceLinks).toEqual(['/admin/security/detections/det-1']);
    expect(await AdminAiSuggestionModel.countDocuments()).toBe(1);
  });

  it('answers the same evidence from the stored row and re-asks after a policyVersion bump', async () => {
    const decide = decideStub();
    const first = await runAdminAi('abuseAssessment', decisionInput(), decisionDeps(decide));
    const second = await runAdminAi('abuseAssessment', decisionInput(), decisionDeps(decide));
    expect(decide).toHaveBeenCalledTimes(1);
    expect(second.ok && second.cached).toBe(true);
    expect(first.ok && second.ok && first.suggestion.id === second.suggestion.id).toBe(true);

    await runAdminAi('abuseAssessment', decisionInput({ policyVersion: 'v2' }), decisionDeps(decide));
    expect(decide).toHaveBeenCalledTimes(2);
    expect(await AdminAiSuggestionModel.countDocuments()).toBe(2);
  });

  it.each([
    ['zero monthly cap', { root: { monthlyCapUsd: 0 } }, 'budget'],
    ['zero daily budget', { feature: { dailyBudgetUsd: 0 } }, 'budget'],
    ['zero call cap', { feature: { maxCallsPerDay: 0 } }, 'call_cap'],
  ])('skips with no provider call on a %s', async (_label, overrides, skip) => {
    const impl = vi.fn(() => response(0.9));
    const result = await runAdminAi(
      'abuseAssessment',
      decisionInput(),
      decisionDeps(decideStub(impl), config(overrides))
    );
    expect(result).toEqual({ ok: false, skip });
    expect(impl).not.toHaveBeenCalled();
    expect(await AdminAiSuggestionModel.countDocuments()).toBe(0);
  });

  it('skips as disabled when the master switch or the feature mode is off', async () => {
    const decide = decideStub();
    const off = await runAdminAi(
      'abuseAssessment',
      decisionInput(),
      decisionDeps(decide, config({ root: { enabled: false } }))
    );
    const modeOff = await runAdminAi(
      'abuseAssessment',
      decisionInput(),
      decisionDeps(decide, config({ feature: { mode: 'off' } }))
    );
    expect(off).toEqual({ ok: false, skip: 'disabled' });
    expect(modeOff).toEqual({ ok: false, skip: 'disabled' });
    expect(decide).not.toHaveBeenCalled();
  });

  it('maps a provider failure to provider_down without throwing', async () => {
    const decide = decideStub(() => {
      throw new DecisionProviderError('overloaded', 'provider failed', { status: 503 });
    });
    const result = await runAdminAi('abuseAssessment', decisionInput(), decisionDeps(decide));
    expect(result).toEqual({ ok: false, skip: 'provider_down' });
    expect(await AdminAiAttemptModel.findOne().lean()).toMatchObject({
      outcome: 'skip',
      skipReason: 'provider_down',
      calls: 1,
      knownCostUsd: 0,
      costUnknown: true,
    });
  });

  it.each([
    ['model_unavailable', 'no_model'],
    ['provider_not_configured', 'no_model'],
    ['invalid_request', 'error'],
  ] as const)('maps a %s request error to %s', async (code, skip) => {
    const decide = decideStub(() => {
      throw new DecisionRequestError(422, code, undefined, 'rejected');
    });
    expect(await runAdminAi('abuseAssessment', decisionInput(), decisionDeps(decide))).toEqual({ ok: false, skip });
  });

  it('skips as in_flight while another run holds the claim, and releases it after', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let entered!: () => void;
    const inCall = new Promise<void>(resolve => {
      entered = resolve;
    });
    const decide = decideStub(async () => {
      entered();
      await gate;
      return response(0.9);
    });
    const first = runAdminAi('abuseAssessment', decisionInput(), decisionDeps(decide));
    await inCall;
    expect(await runAdminAi('abuseAssessment', decisionInput(), decisionDeps(decide))).toEqual({
      ok: false,
      skip: 'in_flight',
    });
    release();
    expect((await first).ok).toBe(true);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(await Cache.countDocuments({ key: /inflight/ })).toBe(0);
  });

  it('leaves a lapsed claim alone once another run has taken it', async () => {
    const decide = decideStub(async () => {
      await Cache.updateOne({ key: /inflight/ }, { $set: { 'result.owner': 'other-run' } });
      return response(0.9);
    });
    expect((await runAdminAi('abuseAssessment', decisionInput(), decisionDeps(decide))).ok).toBe(true);
    expect(await Cache.countDocuments({ key: /inflight/, 'result.owner': 'other-run' })).toBe(1);
  });

  it('answers from a row stored between the lookup and the claim without calling the model', async () => {
    await runAdminAi('abuseAssessment', decisionInput(), decisionDeps(decideStub()));
    const spy = vi.spyOn(adminAiSuggestionRepository, 'findByKey').mockResolvedValueOnce(null);
    const decide = decideStub();
    try {
      const result = await runAdminAi('abuseAssessment', decisionInput(), decisionDeps(decide));
      expect(result).toMatchObject({ ok: true, cached: true });
      expect(decide).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('reports an unexpected error as error, never a throw', async () => {
    const result = await runAdminAi('abuseAssessment', decisionInput(), {
      ...decisionDeps(decideStub()),
      loadConfig: async () => {
        throw new Error('settings unavailable');
      },
    });
    expect(result).toEqual({ ok: false, skip: 'error' });
  });

  it('asks the escalation model once when the first answer is below the threshold', async () => {
    const replies = [response(0.6), response(0.95)];
    const decide = decideStub(() => replies.shift()!);
    const cfg = config();
    cfg.features.abuseAssessment = {
      ...cfg.features.abuseAssessment,
      escalationModel: 'jev-latest',
      confidenceThreshold: 0.8,
    };
    const result = await runAdminAi('abuseAssessment', decisionInput(), {
      ...decisionDeps(decide, cfg),
      callableDecisionModel: async model => model as DecisionModelId,
    });
    expect(decide).toHaveBeenCalledTimes(2);
    expect(decide.mock.calls[1][0].model).toBe('jev-latest');
    expect(result.ok && result.suggestion).toMatchObject({ escalated: true, costUsd: 0.004 });
  });

  it('stores the paid primary answer when the escalation fails', async () => {
    const replies: (DecisionResponse | Error)[] = [
      response(0.6),
      new DecisionProviderError('overloaded', 'provider failed', { status: 503 }),
    ];
    const decide = decideStub(() => {
      const next = replies.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const cfg = config();
    cfg.features.abuseAssessment = {
      ...cfg.features.abuseAssessment,
      escalationModel: 'jev-latest',
      confidenceThreshold: 0.8,
    };
    const result = await runAdminAi('abuseAssessment', decisionInput(), decisionDeps(decide, cfg));
    expect(decide).toHaveBeenCalledTimes(2);
    expect(result.ok && result.suggestion).toMatchObject({ escalated: false, costUsd: 0.002, verdict: 'abuse' });
  });

  it('sends a payload with no email, IP, fingerprint or account id', async () => {
    const decide = decideStub();
    await runAdminAi('abuseAssessment', decisionInput(), decisionDeps(decide));
    const sent = JSON.stringify(decide.mock.calls[0][0].body);
    for (const raw of [
      'jane.doe@example.com',
      '203.0.113.42',
      '198.51.100.7',
      'fp-9a8b7c6d5e4f',
      '64b7f0c2a1b2c3d4e5f60718',
    ]) {
      expect(sent).not.toContain(raw);
    }
    expect(sent).toContain('42');
  });
});

describe('runAdminAi text path', () => {
  it('stores a valid reply from one call', async () => {
    const { complete, deps } = textDeps([GOOD]);
    const result = await runAdminAi('dlqTriage', textInput(), deps);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][2]).toMatchObject({ maxTokens: 800 });
    expect(result.ok && result.suggestion).toMatchObject({ verdict: 'bug', model: 'text-model' });
    expect(result.ok && result.suggestion.costUsd).toBeCloseTo(0.00105);
    expect(await readAdminAiSpend('dlqTriage')).toEqual({
      callsToday: 1,
      spentTodayUsd: toMicroUsd(completionUsd(TEXT_MODEL, { inputTokens: 100, outputTokens: 50 })) / 1_000_000,
      spentThisMonthUsd: toMicroUsd(completionUsd(TEXT_MODEL, { inputTokens: 100, outputTokens: 50 })) / 1_000_000,
    });
  });

  it('repairs a bad reply once, carrying the validation error', async () => {
    const { complete, deps } = textDeps(['not json', GOOD]);
    const result = await runAdminAi('dlqTriage', textInput(), deps);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(complete.mock.calls[1][1])).toContain('rejected');
    expect(result.ok).toBe(true);
  });

  it.each([
    ['bad JSON twice', ['{', '{"verdict": 1}']],
    ['empty output twice', ['', '']],
  ])('gives up as invalid_output after %s, with two calls not three', async (_label, replies) => {
    const { complete, deps } = textDeps([...replies, GOOD]);
    const result = await runAdminAi('dlqTriage', textInput(), deps);
    expect(result).toEqual({ ok: false, skip: 'invalid_output' });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('maps a thrown completion to provider_down without throwing', async () => {
    const { deps } = textDeps([new Error('upstream 500')]);
    expect(await runAdminAi('dlqTriage', textInput(), deps)).toEqual({ ok: false, skip: 'provider_down' });
  });

  it('counts a failed provider call against the daily call cap', async () => {
    const { complete, deps } = textDeps([new Error('upstream 500'), GOOD], config({ feature: { maxCallsPerDay: 1 } }));
    expect(await runAdminAi('dlqTriage', textInput(), deps)).toEqual({ ok: false, skip: 'provider_down' });
    expect(await runAdminAi('dlqTriage', textInput(), deps)).toEqual({ ok: false, skip: 'call_cap' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each(['daily', 'monthly'] as const)('keeps unknown provider spend against the %s cap', async window => {
    const input = textInput();
    const messages = [
      { role: 'system' as const, content: `${input.prompt!.system}\n\nReply with one JSON object only, no prose.` },
      { role: 'user' as const, content: JSON.stringify(input.evidence) },
    ];
    const ceilingUsd = toMicroUsd(completionCeilingUsd(TEXT_MODEL, messages, 800, false)) / 1_000_000;
    const cfg = config({
      feature: { dailyBudgetUsd: window === 'daily' ? ceilingUsd : 10, maxCallsPerDay: 2 },
      root: { monthlyCapUsd: window === 'monthly' ? ceilingUsd : 10 },
    });
    const { complete, deps } = textDeps([new Error('provider failed after accepting the request'), GOOD], cfg);
    expect(await runAdminAi('dlqTriage', input, deps)).toEqual({ ok: false, skip: 'provider_down' });
    expect(await readAdminAiSpend('dlqTriage')).toEqual({
      callsToday: 1,
      spentTodayUsd: ceilingUsd,
      spentThisMonthUsd: ceilingUsd,
    });
    expect(await runAdminAi('dlqTriage', { ...input, entityId: 'fb-2' }, deps)).toEqual({
      ok: false,
      skip: 'budget',
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('settles reported usage even when the provider then throws', async () => {
    const { complete, deps } = textDeps([]);
    complete.mockImplementationOnce(async (_model, _messages, _options, callback) => {
      await callback([], { inputTokens: 100, outputTokens: 50 });
      throw new Error('response interrupted');
    });
    expect(await runAdminAi('dlqTriage', textInput(), deps)).toEqual({ ok: false, skip: 'provider_down' });
    expect(await AdminAiAttemptModel.findOne().lean()).toMatchObject({ outcome: 'skip', calls: 1, costUnknown: false });
    expect((await AdminAiAttemptModel.findOne().lean())?.knownCostUsd).toBeCloseTo(0.00105);
    expect(await readAdminAiSpend('dlqTriage')).toEqual({
      callsToday: 1,
      spentTodayUsd: toMicroUsd(completionUsd(TEXT_MODEL, { inputTokens: 100, outputTokens: 50 })) / 1_000_000,
      spentThisMonthUsd: toMicroUsd(completionUsd(TEXT_MODEL, { inputTokens: 100, outputTokens: 50 })) / 1_000_000,
    });
  });

  it('refuses before the provider on a zero budget', async () => {
    const { complete, deps } = textDeps([GOOD], config({ feature: { dailyBudgetUsd: 0 } }));
    expect(await runAdminAi('dlqTriage', textInput(), deps)).toEqual({ ok: false, skip: 'budget' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('accepts a feature schema that extends the base output', async () => {
    const schema = adminAiTextOutputSchema.extend({ area: z.string() });
    const { deps } = textDeps([JSON.stringify({ ...JSON.parse(GOOD), area: 'export' })]);
    const result = await runAdminAi(
      'dlqTriage',
      { ...textInput(), prompt: { system: 's', outputSchema: schema } },
      deps
    );
    expect(result.ok).toBe(true);
  });
});
