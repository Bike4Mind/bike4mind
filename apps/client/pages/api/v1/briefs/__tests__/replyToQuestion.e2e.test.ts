// @vitest-environment node
import { createMocks } from 'node-mocks-http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { BriefReplyRequestSchema, type Brief } from '@bike4mind/common';
import { AgentExecutionModel, AssistantBriefModel, Quest, questRepository } from '@bike4mind/database';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain: Record<string, unknown> = Object.assign(
      async (req: { method: string }, res: unknown) => handlers[req.method]?.(req, res),
      {
        get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain),
        post: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.POST = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({ perUserRateLimit: () => vi.fn() }));
vi.mock('@server/utils/callerModelList', () => ({ resolveCallerDefaultModel: vi.fn(async (model: string) => model) }));
// The agent dispatch is the external edge; the brief, the claim and the quests are real.
const startAgentExecution = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/startAgentExecution', () => ({ startAgentExecution }));

import reply from '../[id]/decisions/[decisionId]/reply';
import getBrief from '../[id]';

type Handler = (req: unknown, res: unknown) => Promise<void>;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const userA = new mongoose.Types.ObjectId().toString();
const userB = new mongoose.Types.ObjectId().toString();

const call = async (handler: unknown, method: 'GET' | 'POST', userId: string, extra: Record<string, unknown>) => {
  const { req, res } = createMocks({ method });
  Object.assign(req, { user: { id: userId }, logger, ...extra });
  await (handler as Handler)(req, res);
  return res;
};

const send = (briefId: string, decisionId: string, body: Record<string, unknown>, userId = userA) =>
  call(reply, 'POST', userId, { validatedParams: { id: briefId, decisionId }, validated: body });

const questionState = async (briefId: string, decisionId: string) => {
  const res = await call(getBrief, 'GET', userA, { validatedParams: { id: briefId } });
  return (res._getJSONData() as Brief).decisions.find(d => d.id === decisionId)?.question?.state;
};

/** A session whose last turn asks the user to pick, and a brief citing it next to an approval. */
const seed = async () => {
  const sessionId = new mongoose.Types.ObjectId().toString();
  const questId = new mongoose.Types.ObjectId();
  await Quest.collection.insertOne({
    _id: questId,
    sessionId,
    timestamp: new Date(),
    reply: 'Which venue should I book?',
    suggestedChoices: {
      options: [
        { label: 'The hall', description: 'Indoors' },
        { label: 'The garden', description: 'Outdoors' },
      ],
    },
  });
  const brief = await AssistantBriefModel.create({
    userId: userA,
    status: 'ready',
    periodStart: new Date(Date.now() - 3_600_000),
    periodEnd: new Date(),
    composedAt: new Date(),
    decisions: [
      {
        id: 'd1',
        text: 'Send it?',
        approval: { questId: new mongoose.Types.ObjectId().toString(), sessionId, pendingActionTs: Date.now() },
      },
      {
        id: 'd2',
        text: 'Pick a venue.',
        question: { questId: questId.toString(), sessionId, options: ['The hall', 'The garden'] },
      },
    ],
  });
  return { briefId: brief._id.toString(), questId: questId.toString(), sessionId };
};

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

describe('POST /api/v1/briefs/[id]/decisions/[decisionId]/reply', () => {
  beforeEach(() => {
    startAgentExecution.mockReset().mockResolvedValue({ ok: true, executionId: 'exec-1', questId: 'q-new' });
  });

  it('sends the reply to the raising session on its model, records the pick, and closes the question', async () => {
    const { briefId, questId, sessionId } = await seed();
    await AgentExecutionModel.collection.insertOne({
      userId: userA,
      sessionId,
      model: 'model-x',
      createdAt: new Date(),
    });
    expect(await questionState(briefId, 'd2')).toBe('open');

    const res = await send(briefId, 'd2', { text: 'The garden, please.', choiceIndex: 1 });
    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData()).toEqual({ executionId: 'exec-1', sessionId });
    expect(startAgentExecution).toHaveBeenCalledTimes(1);
    expect(startAgentExecution.mock.calls[0][0]).toMatchObject({
      userId: userA,
      sessionId,
      questId: sessionId,
      query: 'The garden, please.',
      model: 'model-x',
      apiKeyInfo: undefined,
    });
    const quest = await Quest.findById(questId).lean<{ suggestedChoices: { selectedIndex: number } }>();
    expect(quest?.suggestedChoices.selectedIndex).toBe(1);
    expect(await questionState(briefId, 'd2')).toBe('answered');
  });

  it('still answers 202 when the run started but marking the chosen option failed', async () => {
    const { briefId } = await seed();
    const mark = vi.spyOn(questRepository, 'selectSuggestedChoice').mockRejectedValueOnce(new Error('write failed'));
    try {
      const res = await send(briefId, 'd2', { text: 'Hall', choiceIndex: 0 });
      expect(res._getStatusCode()).toBe(202);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('marking the chosen option failed'),
        expect.objectContaining({ error: 'write failed' })
      );
      expect(await questionState(briefId, 'd2')).toBe('answered');
    } finally {
      mark.mockRestore();
    }
  });

  it('answers once: a second reply is a 409 and starts no second run', async () => {
    const { briefId } = await seed();
    expect((await send(briefId, 'd2', { text: 'Hall' }))._getStatusCode()).toBe(202);
    await expect(send(briefId, 'd2', { text: 'Hall' })).rejects.toMatchObject({
      statusCode: 409,
      additionalInfo: { errorCode: 'question_closed' },
    });
    expect(startAgentExecution).toHaveBeenCalledTimes(1);
  });

  it('allows one of two concurrent replies through', async () => {
    const { briefId } = await seed();
    const results = await Promise.allSettled([send(briefId, 'd2', { text: 'A' }), send(briefId, 'd2', { text: 'B' })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(startAgentExecution).toHaveBeenCalledTimes(1);
  });

  it('is a 409 once the conversation moved past the question', async () => {
    const { briefId, sessionId } = await seed();
    await Quest.collection.insertOne({ sessionId, timestamp: new Date(Date.now() + 1000), reply: 'later' });
    expect(await questionState(briefId, 'd2')).toBe('superseded');
    await expect(send(briefId, 'd2', { text: 'Hall' })).rejects.toMatchObject({ statusCode: 409 });
    expect(startAgentExecution).not.toHaveBeenCalled();
  });

  it('is a 404 for another user, an approval decision, a missing decision and a malformed id', async () => {
    const { briefId } = await seed();
    await expect(send(briefId, 'd2', { text: 'Hall' }, userB)).rejects.toMatchObject({ statusCode: 404 });
    await expect(send(briefId, 'd1', { text: 'Hall' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(send(briefId, 'd9', { text: 'Hall' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(send('not-an-id', 'd2', { text: 'Hall' })).rejects.toMatchObject({ statusCode: 404 });
    expect(startAgentExecution).not.toHaveBeenCalled();
    expect(await questionState(briefId, 'd2')).toBe('open');
  });

  it('releases the claim when the run is refused, so the user can reply again', async () => {
    const { briefId } = await seed();
    startAgentExecution.mockResolvedValueOnce({ ok: false, reason: 'concurrent_limit', message: 'busy' });
    await expect(send(briefId, 'd2', { text: 'Hall', choiceIndex: 0 })).rejects.toMatchObject({ statusCode: 409 });
    expect(await questionState(briefId, 'd2')).toBe('open');
    expect((await send(briefId, 'd2', { text: 'Hall' }))._getStatusCode()).toBe(202);
  });

  it('keeps the claim when the dispatch could not be confirmed', async () => {
    const { briefId } = await seed();
    startAgentExecution.mockResolvedValueOnce({
      ok: false,
      reason: 'dispatch_failed',
      message: 'x',
      executionId: 'e',
      dispatchUnconfirmed: true,
    });
    await expect(send(briefId, 'd2', { text: 'Hall' })).rejects.toMatchObject({ statusCode: 502 });
    expect(await questionState(briefId, 'd2')).toBe('answered');
  });

  it('releases the claim when the dispatch failed without starting a run', async () => {
    const { briefId } = await seed();
    startAgentExecution.mockResolvedValueOnce({ ok: false, reason: 'dispatch_failed', message: 'x', executionId: 'e' });
    await expect(send(briefId, 'd2', { text: 'Hall' })).rejects.toMatchObject({ statusCode: 502 });
    expect(await questionState(briefId, 'd2')).toBe('open');
    expect((await send(briefId, 'd2', { text: 'Hall' }))._getStatusCode()).toBe(202);
  });

  it('is a 400 for a choiceIndex past the question options and claims nothing', async () => {
    const { briefId } = await seed();
    await expect(send(briefId, 'd2', { text: 'Hall', choiceIndex: 3 })).rejects.toMatchObject({ statusCode: 400 });
    expect(startAgentExecution).not.toHaveBeenCalled();
    expect(await questionState(briefId, 'd2')).toBe('open');
  });
});

describe('reply request schema', () => {
  it('rejects empty, blank, oversize and out-of-range bodies', () => {
    expect(BriefReplyRequestSchema.safeParse({ text: '' }).success).toBe(false);
    expect(BriefReplyRequestSchema.safeParse({ text: ' \n\t ' }).success).toBe(false);
    expect(BriefReplyRequestSchema.safeParse({ text: 'x'.repeat(4001) }).success).toBe(false);
    expect(BriefReplyRequestSchema.safeParse({ text: 'ok', choiceIndex: 4 }).success).toBe(false);
    expect(BriefReplyRequestSchema.safeParse({ text: 'ok', choiceIndex: 3 }).success).toBe(true);
  });
});

describe('questRepository.findOpenQuestionsBySessionIds', () => {
  it('keeps only a session whose latest turn is an unpicked question with no pending action', async () => {
    const since = new Date(Date.now() - 60_000);
    const choices = { options: [{ label: 'Yes', description: 'y' }] };
    const [open, picked, pending, older, stale] = Array.from({ length: 5 }, () =>
      new mongoose.Types.ObjectId().toString()
    );
    await Quest.collection.insertMany([
      { sessionId: open, timestamp: new Date(), reply: 'Proceed?', suggestedChoices: choices },
      { sessionId: picked, timestamp: new Date(), suggestedChoices: { ...choices, selectedIndex: 0 } },
      { sessionId: pending, timestamp: new Date(), suggestedChoices: choices, pendingAction: { ts: 1, tool: 't' } },
      { sessionId: older, timestamp: new Date(Date.now() - 1000), suggestedChoices: choices },
      { sessionId: older, timestamp: new Date(), reply: 'moved on' },
      { sessionId: stale, timestamp: new Date(Date.now() - 120_000), suggestedChoices: choices },
    ]);

    const found = await questRepository.findOpenQuestionsBySessionIds([open, picked, pending, older, stale], since, 10);
    expect(found).toEqual([expect.objectContaining({ sessionId: open, reply: 'Proceed?', options: ['Yes'] })]);
  });
});
