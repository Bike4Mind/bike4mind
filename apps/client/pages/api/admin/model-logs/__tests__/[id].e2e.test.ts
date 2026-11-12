import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import {
  Quest,
  Session,
  AdminSupportAccessAuditLog,
  adminSupportAccessAuditLogRepository,
  userRepository,
} from '@bike4mind/database';
import { AdminSupportAccessAction } from '@bike4mind/common';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) middleware(req, res, () => undefined);
        return h[(req as { method?: string }).method ?? 'GET']?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (middlewares.push(fn), chain),
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  NotFoundError: class NotFoundError extends Error {
    name = 'NotFoundError';
  },
  ForbiddenError: class ForbiddenError extends Error {
    name = 'ForbiddenError';
  },
}));

import handler from '../[id]';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const SUPPORT_CASE = 'ZD-4821';

const run = (id: string, isAdmin = true, supportCase: string | null = SUPPORT_CASE) => {
  const { req, res } = createMocks({ method: 'GET', query: { id, ...(supportCase === null ? {} : { supportCase }) } });
  (req as Record<string, unknown>).user = { id: 'admin1', isAdmin };
  return { req, res };
};

const createLog = (ownerUserId = 'user-2') =>
  Quest.create({
    sessionId: 'session-1',
    type: 'message',
    timestamp: new Date('2026-01-01T00:00:00Z'),
    prompt: 'hello',
    promptMeta: {
      session: { id: 'session-1', userId: ownerUserId },
      model: { name: 'claude-sonnet-5' },
      functionCalls: [
        {
          id: 'call-1',
          name: 'web_search',
          parameters: {},
          returnValue: 'private tool output',
          error: 'private tool error',
          success: true,
        },
      ],
      citables: [
        {
          id: 'file-1',
          type: 'document',
          title: 'Reference',
          metadata: { sourceSystem: 'knowledge_base', chunkId: 'chunk-1', fullContext: 'private passage' },
        },
      ],
    },
  });

describe('GET /api/admin/model-logs/[id]', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await Quest.init();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  afterEach(async () => {
    await mongoose.connection.dropDatabase();
  });

  it('returns the full promptMeta with owner-only tool output redacted', async () => {
    const quest = await createLog();
    const { req, res } = run(quest.id);
    await handler(req, res);

    const body = res._getJSONData();
    expect(body).toMatchObject({
      id: quest.id,
      timestamp: '2026-01-01T00:00:00.000Z',
      model: { name: 'claude-sonnet-5' },
      functionCalls: [expect.objectContaining({ name: 'web_search' })],
    });
    expect(JSON.stringify(body)).not.toContain('private tool output');
    expect(JSON.stringify(body)).not.toContain('private tool error');
    expect(JSON.stringify(body)).not.toContain('private passage');
    expect(body.citables[0]).toMatchObject({
      id: 'file-1',
      title: 'Reference',
      metadata: { sourceSystem: 'knowledge_base', chunkId: 'chunk-1' },
    });
  });

  it.each([
    ['an unknown id', () => new mongoose.Types.ObjectId().toString()],
    ['a malformed id', () => 'not-an-id'],
  ])('answers 404 for %s', async (_label, makeId) => {
    const { req, res } = run(makeId());
    await expect(handler(req, res)).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('rejects an empty id before any query runs', async () => {
    const findSpy = vi.spyOn(Quest, 'findById');
    const { req, res } = run('');
    await expect(handler(req, res)).rejects.toMatchObject({ name: 'ZodError' });
    expect(findSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
  });

  it('answers 404 for a soft-deleted log', async () => {
    const quest = await createLog();
    await Quest.updateOne({ _id: quest._id }, { $set: { deletedAt: new Date() } });
    const { req, res } = run(quest.id);
    await expect(handler(req, res)).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('rejects a non-admin before reading the log', async () => {
    const quest = await createLog();
    const findSpy = vi.spyOn(Quest, 'findById');
    const { req, res } = run(quest.id, false);
    await expect(handler(req, res)).rejects.toThrow(/missing permission/i);
    expect(findSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
  });

  describe('support-case audit', () => {
    it('records exactly one ModelLogRead with the owner, session and quest before serving', async () => {
      const quest = await createLog();
      const { req, res } = run(quest.id);
      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const records = await AdminSupportAccessAuditLog.find({}).lean();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        action: AdminSupportAccessAction.ModelLogRead,
        actorUserId: 'admin1',
        targetUserId: 'user-2',
        sessionId: 'session-1',
        supportCase: SUPPORT_CASE,
        details: { questId: quest.id },
      });
    });

    it.each([
      ['missing', null],
      ['too short', 'ab'],
    ])('rejects a %s supportCase and writes no audit record', async (_label, supportCase) => {
      const quest = await createLog();
      const { req, res } = run(quest.id, true, supportCase);
      await expect(handler(req, res)).rejects.toMatchObject({ name: 'ZodError' });
      expect(await AdminSupportAccessAuditLog.countDocuments()).toBe(0);
      expect(res._isEndCalled()).toBe(false);
    });

    it('refuses a caller without support:read before parsing the case', async () => {
      const quest = await createLog();
      const { req, res } = run(quest.id, false, null);
      await expect(handler(req, res)).rejects.toThrow(/missing permission/i);
      expect(await AdminSupportAccessAuditLog.countDocuments()).toBe(0);
    });

    it('does not record a read for an unknown log', async () => {
      const { req, res } = run(new mongoose.Types.ObjectId().toString());
      await expect(handler(req, res)).rejects.toMatchObject({ name: 'NotFoundError' });
      expect(await AdminSupportAccessAuditLog.countDocuments()).toBe(0);
    });

    it('refuses an owner in their deletion grace period, as the notebook read does, and records nothing', async () => {
      const ownerUserId = new mongoose.Types.ObjectId().toString();
      const quest = await createLog(ownerUserId);
      const findUserSpy = vi
        .spyOn(userRepository, 'findById')
        .mockResolvedValue({ deletion: { scheduledFor: new Date() } } as Awaited<
          ReturnType<typeof userRepository.findById>
        >);
      const { req, res } = run(quest.id);

      await expect(handler(req, res)).rejects.toMatchObject({ name: 'ForbiddenError' });
      expect(findUserSpy).toHaveBeenCalledWith(ownerUserId);
      expect(await AdminSupportAccessAuditLog.countDocuments()).toBe(0);
      expect(res._isEndCalled()).toBe(false);
      findUserSpy.mockRestore();
    });

    it('serves an owner with no deletion pending', async () => {
      const ownerUserId = new mongoose.Types.ObjectId().toString();
      const quest = await createLog(ownerUserId);
      const findUserSpy = vi
        .spyOn(userRepository, 'findById')
        .mockResolvedValue({} as Awaited<ReturnType<typeof userRepository.findById>>);
      const { req, res } = run(quest.id);

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(await AdminSupportAccessAuditLog.findOne({}).lean()).toMatchObject({ targetUserId: ownerUserId });
      findUserSpy.mockRestore();
    });

    it('records an unresolved owner as such, still serving the log', async () => {
      // A legacy log with no recorded owner (the schema now requires one, so unset it past validation)
      // and no session to fall back to.
      const quest = await createLog();
      await Quest.updateOne({ _id: quest._id }, { $unset: { 'promptMeta.session.userId': '' } });
      const { req, res } = run(quest.id);

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const records = await AdminSupportAccessAuditLog.find({}).lean();
      expect(records).toHaveLength(1);
      expect(records[0].targetUserId).toBeUndefined();
      expect(records[0]).toMatchObject({
        sessionId: 'session-1',
        details: { questId: quest.id, ownerUnresolved: true },
      });
    });

    describe('owner resolved from the session when the log records none', () => {
      const seedSessionOwnedLog = async () => {
        const ownerUserId = new mongoose.Types.ObjectId().toString();
        const session = await Session.create({
          name: 'owned session',
          userId: ownerUserId,
          lastUpdated: new Date(),
          firstCreated: new Date(),
        });
        const quest = await Quest.create({
          sessionId: session.id,
          type: 'message',
          timestamp: new Date('2026-01-01T00:00:00Z'),
          prompt: 'hello',
          promptMeta: { session: { id: session.id, userId: 'placeholder' }, model: { name: 'claude-sonnet-5' } },
        });
        // The schema requires a recorded owner, so drop it past validation to mimic a legacy log.
        await Quest.updateOne({ _id: quest._id }, { $unset: { 'promptMeta.session.userId': '' } });
        return { ownerUserId, sessionId: session.id as string, quest };
      };

      it('audits the session owner as the target', async () => {
        const { ownerUserId, sessionId, quest } = await seedSessionOwnedLog();
        const { req, res } = run(quest.id);

        await handler(req, res);

        expect(res._getStatusCode()).toBe(200);
        const records = await AdminSupportAccessAuditLog.find({}).lean();
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ targetUserId: ownerUserId, sessionId });
        expect(records[0].details).not.toHaveProperty('ownerUnresolved');
      });

      it('refuses when the session owner is in their deletion grace period, and records nothing', async () => {
        const { ownerUserId, quest } = await seedSessionOwnedLog();
        const findUserSpy = vi
          .spyOn(userRepository, 'findById')
          .mockResolvedValue({ deletion: { scheduledFor: new Date() } } as Awaited<
            ReturnType<typeof userRepository.findById>
          >);
        const { req, res } = run(quest.id);

        await expect(handler(req, res)).rejects.toMatchObject({ name: 'ForbiddenError' });
        expect(findUserSpy).toHaveBeenCalledWith(ownerUserId);
        expect(await AdminSupportAccessAuditLog.countDocuments()).toBe(0);
        expect(res._isEndCalled()).toBe(false);
        findUserSpy.mockRestore();
      });
    });

    it('fails the request and serves no body when the audit write fails', async () => {
      const quest = await createLog();
      const recordSpy = vi.spyOn(adminSupportAccessAuditLogRepository, 'record').mockRejectedValue(new Error('down'));
      const { req, res } = run(quest.id);
      await expect(handler(req, res)).rejects.toThrow('down');
      expect(res._isEndCalled()).toBe(false);
      expect(res._getData()).toBe('');
      recordSpy.mockRestore();
    });
  });
});
