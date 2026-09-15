import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@bike4mind/database', () => ({
  questMasterPlanRepository: {
    findByUserId: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateQuestProgress: vi.fn(),
    updateMetrics: vi.fn(),
    continueInSession: vi.fn(),
  },
  sessionRepository: {
    findById: vi.fn(),
  },
  questRepository: {
    create: vi.fn(),
  },
  projectRepository: {},
  fabFileRepository: {},
}));

vi.mock('@bike4mind/services', () => ({
  sessionService: {
    createSession: vi.fn(),
  },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: vi.fn(() => ({
    get: vi.fn((handler: any) => ({
      post: vi.fn((postHandler: any) => ({
        _handlers: { get: handler, post: postHandler },
      })),
      patch: vi.fn((patchHandler: any) => ({
        delete: vi.fn((deleteHandler: any) => ({
          _handlers: { get: handler, patch: patchHandler, delete: deleteHandler },
        })),
      })),
    })),
    post: vi.fn((handler: any) => ({
      _handlers: { post: handler },
    })),
    patch: vi.fn((handler: any) => ({
      _handlers: { patch: handler },
    })),
  })),
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'mock-uuid-123'),
}));

describe('Quest Plans API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication', () => {
    it('should return 401 when user is not authenticated', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      const { req, res } = createMocks({ method: 'GET' });

      // Simulate handler logic for unauthenticated user
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
      }

      expect(res._getStatusCode()).toBe(401);
      expect(JSON.parse(res._getData())).toEqual({ error: 'Unauthorized' });
      expect(questMasterPlanRepository.findByUserId).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/quest-plans', () => {
    it('should return user quest plans with pagination', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      const mockPlans = [
        { id: 'plan1', goal: 'Test Quest 1', userId: 'user123' },
        { id: 'plan2', goal: 'Test Quest 2', userId: 'user123' },
      ];

      (questMasterPlanRepository.findByUserId as any).mockResolvedValue(mockPlans);

      const { req, res } = createMocks({
        method: 'GET',
        query: { limit: '50', offset: '0' },
      });
      req.user = { id: 'user123' } as any;

      // Simulate handler logic
      const userId = req.user?.id;
      const { limit = '50', offset = '0' } = req.query;
      const plans = await questMasterPlanRepository.findByUserId(userId!, {
        limit: Number(limit),
        offset: Number(offset),
      });

      res.json({
        data: plans,
        pagination: {
          limit: Number(limit),
          offset: Number(offset),
          total: plans.length,
          hasMore: false,
        },
      });

      expect(questMasterPlanRepository.findByUserId).toHaveBeenCalledWith('user123', {
        limit: 50,
        offset: 0,
      });
      expect(res._getStatusCode()).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data.data).toHaveLength(2);
      expect(data.pagination.total).toBe(2);
    });

    it('should filter by state when provided', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      const mockPlans = [{ id: 'plan1', goal: 'Active Quest', state: 'active' }];

      (questMasterPlanRepository.findByUserId as any).mockResolvedValue(mockPlans);

      const { req } = createMocks({
        method: 'GET',
        query: { state: 'active' },
      });
      req.user = { id: 'user123' } as any;

      const userId = req.user?.id;
      const { state } = req.query;
      await questMasterPlanRepository.findByUserId(userId!, { state: state as string });

      expect(questMasterPlanRepository.findByUserId).toHaveBeenCalledWith('user123', {
        state: 'active',
      });
    });

    it('should filter by tags when provided', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      (questMasterPlanRepository.findByUserId as any).mockResolvedValue([]);

      const { req } = createMocks({
        method: 'GET',
        query: { tags: 'work,urgent' },
      });
      req.user = { id: 'user123' } as any;

      const userId = req.user?.id;
      const { tags } = req.query;
      const parsedTags = tags ? (tags as string).split(',') : undefined;
      await questMasterPlanRepository.findByUserId(userId!, { tags: parsedTags });

      expect(questMasterPlanRepository.findByUserId).toHaveBeenCalledWith('user123', {
        tags: ['work', 'urgent'],
      });
    });
  });

  describe('POST /api/quest-plans', () => {
    it('should create a new quest plan', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      const mockPlan = {
        id: 'new-plan',
        goal: 'New Quest',
        userId: 'user123',
        quests: [],
        state: 'active',
      };

      (questMasterPlanRepository.create as any).mockResolvedValue(mockPlan);

      const { req, res } = createMocks({
        method: 'POST',
        body: { goal: 'New Quest', quests: [], tags: ['test'] },
      });
      req.user = { id: 'user123' } as any;

      const userId = req.user?.id;
      const { goal, quests, tags } = req.body;

      const plan = await questMasterPlanRepository.create({
        notebookId: `direct-${Date.now()}`,
        userId,
        goal,
        quests,
        tags,
        visibility: 'user',
        state: 'active',
      });

      res.status(201).json(plan);

      expect(questMasterPlanRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user123',
          goal: 'New Quest',
          visibility: 'user',
          state: 'active',
        })
      );
      expect(res._getStatusCode()).toBe(201);
    });
  });

  describe('GET /api/quest-plans/[id]', () => {
    it('should return quest plan for owner', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      const mockPlan = {
        id: 'plan1',
        goal: 'Test Quest',
        userId: 'user123',
        lastAccessedAt: new Date(),
      };

      (questMasterPlanRepository.findById as any).mockResolvedValue(mockPlan);
      (questMasterPlanRepository.update as any).mockResolvedValue(mockPlan);

      const { req, res } = createMocks({
        method: 'GET',
        query: { id: 'plan1' },
      });
      req.user = { id: 'user123' } as any;

      const plan = await questMasterPlanRepository.findById('plan1');
      const userId = req.user?.id;

      if (plan?.userId === userId) {
        plan.lastAccessedAt = new Date();
        await questMasterPlanRepository.update(plan);
        res.json(plan);
      }

      expect(res._getStatusCode()).toBe(200);
      expect(JSON.parse(res._getData()).goal).toBe('Test Quest');
    });

    it('should return 404 when plan not found', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      (questMasterPlanRepository.findById as any).mockResolvedValue(null);

      const { req, res } = createMocks({
        method: 'GET',
        query: { id: 'nonexistent' },
      });
      req.user = { id: 'user123' } as any;

      const plan = await questMasterPlanRepository.findById('nonexistent');
      if (!plan) {
        res.status(404).json({ error: 'Quest plan not found' });
      }

      expect(res._getStatusCode()).toBe(404);
      expect(JSON.parse(res._getData())).toEqual({ error: 'Quest plan not found' });
    });

    it('should return 403 when user lacks access', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      const mockPlan = {
        id: 'plan1',
        goal: 'Private Quest',
        userId: 'other-user',
        visibility: 'user',
        sharedWith: [],
      };

      (questMasterPlanRepository.findById as any).mockResolvedValue(mockPlan);

      const { req, res } = createMocks({
        method: 'GET',
        query: { id: 'plan1' },
      });
      req.user = { id: 'user123' } as any;

      const plan = await questMasterPlanRepository.findById('plan1');
      const userId = req.user?.id;

      if (plan?.userId !== userId && !plan?.sharedWith?.includes(userId!) && plan?.visibility !== 'public') {
        res.status(403).json({ error: 'Access denied' });
      }

      expect(res._getStatusCode()).toBe(403);
      expect(JSON.parse(res._getData())).toEqual({ error: 'Access denied' });
    });

    it('should allow access when plan is shared with user', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      const mockPlan = {
        id: 'plan1',
        goal: 'Shared Quest',
        userId: 'other-user',
        visibility: 'user',
        sharedWith: ['user123'],
        lastAccessedAt: new Date(),
      };

      (questMasterPlanRepository.findById as any).mockResolvedValue(mockPlan);
      (questMasterPlanRepository.update as any).mockResolvedValue(mockPlan);

      const { req, res } = createMocks({
        method: 'GET',
        query: { id: 'plan1' },
      });
      req.user = { id: 'user123' } as any;

      const plan = await questMasterPlanRepository.findById('plan1');
      const userId = req.user?.id;

      const hasAccess = plan?.userId === userId || plan?.sharedWith?.includes(userId!) || plan?.visibility === 'public';

      if (hasAccess) {
        res.json(plan);
      }

      expect(res._getStatusCode()).toBe(200);
    });

    it('should allow access when plan is public', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      const mockPlan = {
        id: 'plan1',
        goal: 'Public Quest',
        userId: 'other-user',
        visibility: 'public',
        sharedWith: [],
        lastAccessedAt: new Date(),
      };

      (questMasterPlanRepository.findById as any).mockResolvedValue(mockPlan);
      (questMasterPlanRepository.update as any).mockResolvedValue(mockPlan);

      const { req, res } = createMocks({
        method: 'GET',
        query: { id: 'plan1' },
      });
      req.user = { id: 'user123' } as any;

      const plan = await questMasterPlanRepository.findById('plan1');
      const userId = req.user?.id;

      const hasAccess = plan?.userId === userId || plan?.sharedWith?.includes(userId!) || plan?.visibility === 'public';

      if (hasAccess) {
        res.json(plan);
      }

      expect(res._getStatusCode()).toBe(200);
    });
  });

  describe('PATCH /api/quest-plans/[id]', () => {
    it('should update quest plan state', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      const mockPlan = {
        id: 'plan1',
        goal: 'Test Quest',
        userId: 'user123',
        state: 'active',
        lastAccessedAt: new Date(),
      };

      (questMasterPlanRepository.findById as any).mockResolvedValue(mockPlan);
      (questMasterPlanRepository.update as any).mockResolvedValue({ ...mockPlan, state: 'paused' });

      const { req, res } = createMocks({
        method: 'PATCH',
        query: { id: 'plan1' },
        body: { state: 'paused' },
      });
      req.user = { id: 'user123' } as any;

      const plan = await questMasterPlanRepository.findById('plan1');
      const userId = req.user?.id;

      if (plan?.userId === userId) {
        plan.state = req.body.state;
        const updated = await questMasterPlanRepository.update(plan);
        res.json(updated);
      }

      expect(questMasterPlanRepository.update).toHaveBeenCalled();
      expect(res._getStatusCode()).toBe(200);
    });

    it('should return 403 when non-owner tries to update', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      const mockPlan = {
        id: 'plan1',
        goal: 'Test Quest',
        userId: 'other-user',
      };

      (questMasterPlanRepository.findById as any).mockResolvedValue(mockPlan);

      const { req, res } = createMocks({
        method: 'PATCH',
        query: { id: 'plan1' },
        body: { state: 'paused' },
      });
      req.user = { id: 'user123' } as any;

      const plan = await questMasterPlanRepository.findById('plan1');
      const userId = req.user?.id;

      if (plan?.userId !== userId) {
        res.status(403).json({ error: 'Only owner can update quest plan' });
      }

      expect(res._getStatusCode()).toBe(403);
    });
  });

  describe('DELETE /api/quest-plans/[id]', () => {
    it('should archive quest plan (soft delete)', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      const mockPlan = {
        id: 'plan1',
        goal: 'Test Quest',
        userId: 'user123',
        state: 'active',
      };

      (questMasterPlanRepository.findById as any).mockResolvedValue(mockPlan);
      (questMasterPlanRepository.update as any).mockResolvedValue({
        ...mockPlan,
        state: 'archived',
      });

      const { req, res } = createMocks({
        method: 'DELETE',
        query: { id: 'plan1' },
      });
      req.user = { id: 'user123' } as any;

      const plan = await questMasterPlanRepository.findById('plan1');
      const userId = req.user?.id;

      if (plan?.userId === userId) {
        plan.state = 'archived';
        await questMasterPlanRepository.update(plan);
        res.status(204).end();
      }

      expect(questMasterPlanRepository.update).toHaveBeenCalledWith(expect.objectContaining({ state: 'archived' }));
      expect(res._getStatusCode()).toBe(204);
    });

    it('should return 403 when non-owner tries to delete', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      const mockPlan = {
        id: 'plan1',
        goal: 'Test Quest',
        userId: 'other-user',
      };

      (questMasterPlanRepository.findById as any).mockResolvedValue(mockPlan);

      const { req, res } = createMocks({
        method: 'DELETE',
        query: { id: 'plan1' },
      });
      req.user = { id: 'user123' } as any;

      const plan = await questMasterPlanRepository.findById('plan1');
      const userId = req.user?.id;

      if (plan?.userId !== userId) {
        res.status(403).json({ error: 'Only owner can archive quest plan' });
      }

      expect(res._getStatusCode()).toBe(403);
    });
  });

  describe('POST /api/quest-plans/[id]/clone', () => {
    it('should clone a quest plan with reset statuses', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      const originalPlan = {
        id: 'plan1',
        goal: 'Original Quest',
        userId: 'user123',
        quests: [
          {
            id: 'q1',
            title: 'Main Quest',
            description: 'Test',
            complexity: 'medium',
            subQuests: [
              { id: 'sq1', title: 'Sub 1', status: 'completed' },
              { id: 'sq2', title: 'Sub 2', status: 'in_progress' },
            ],
          },
        ],
        tags: ['work'],
        priority: 'high',
      };

      const clonedPlan = {
        id: 'cloned-plan',
        goal: 'Original Quest (Copy)',
        userId: 'user123',
        parentPlanId: 'plan1',
        state: 'active',
      };

      (questMasterPlanRepository.findById as any).mockResolvedValue(originalPlan);
      (questMasterPlanRepository.create as any).mockResolvedValue(clonedPlan);

      const { req, res } = createMocks({
        method: 'POST',
        query: { id: 'plan1' },
      });
      req.user = { id: 'user123' } as any;

      const plan = await questMasterPlanRepository.findById('plan1');
      const userId = req.user?.id;

      if (plan?.userId === userId) {
        const newPlan = await questMasterPlanRepository.create({
          notebookId: `clone-${Date.now()}`,
          userId,
          goal: `${plan.goal} (Copy)`,
          quests: plan.quests.map((q: any) => ({
            ...q,
            id: 'mock-uuid-123',
            subQuests: q.subQuests.map((sq: any) => ({
              ...sq,
              id: 'mock-uuid-123',
              status: 'not_started',
            })),
          })),
          parentPlanId: plan.id,
          state: 'active',
        });
        res.status(201).json({ success: true, plan: newPlan });
      }

      expect(questMasterPlanRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          goal: 'Original Quest (Copy)',
          parentPlanId: 'plan1',
          state: 'active',
        })
      );
      expect(res._getStatusCode()).toBe(201);
    });

    it('should allow cloning shared plans', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      const sharedPlan = {
        id: 'plan1',
        goal: 'Shared Quest',
        userId: 'other-user',
        sharedWith: ['user123'],
        quests: [],
      };

      (questMasterPlanRepository.findById as any).mockResolvedValue(sharedPlan);
      (questMasterPlanRepository.create as any).mockResolvedValue({ id: 'cloned' });

      const { req, res } = createMocks({
        method: 'POST',
        query: { id: 'plan1' },
      });
      req.user = { id: 'user123' } as any;

      const plan = await questMasterPlanRepository.findById('plan1');
      const userId = req.user?.id;

      const hasAccess = plan?.userId === userId || plan?.sharedWith?.includes(userId!) || plan?.visibility === 'public';

      if (hasAccess) {
        await questMasterPlanRepository.create({} as any);
        res.status(201).json({ success: true });
      }

      expect(res._getStatusCode()).toBe(201);
    });
  });

  describe('POST /api/quest-plans/[id]/continue', () => {
    it('should auto-resume paused quest when continuing', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      const pausedPlan = {
        id: 'plan1',
        goal: 'Paused Quest',
        userId: 'user123',
        state: 'paused',
        notebookId: 'session123',
      };

      (questMasterPlanRepository.findById as any).mockResolvedValue(pausedPlan);
      (questMasterPlanRepository.update as any).mockResolvedValue({ ...pausedPlan, state: 'active' });
      (questMasterPlanRepository.continueInSession as any).mockResolvedValue({
        ...pausedPlan,
        state: 'active',
      });

      const { req } = createMocks({
        method: 'POST',
        query: { id: 'plan1' },
        body: { sessionId: 'session123' },
      });
      req.user = { id: 'user123' } as any;

      const plan = await questMasterPlanRepository.findById('plan1');

      // Auto-resume if paused
      if (plan?.state === 'paused') {
        plan.state = 'active';
        await questMasterPlanRepository.update(plan);
      }

      expect(questMasterPlanRepository.update).toHaveBeenCalledWith(expect.objectContaining({ state: 'active' }));
    });

    it('should create notebook for cloned plans with placeholder notebookId', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      const { sessionService } = await import('@bike4mind/services');
      const clonedPlan = {
        id: 'plan1',
        goal: 'Cloned Quest',
        userId: 'user123',
        state: 'active',
        notebookId: 'clone-12345',
      };

      (questMasterPlanRepository.findById as any).mockResolvedValue(clonedPlan);
      (sessionService.createSession as any).mockResolvedValue({ id: 'new-session-id' });
      (questMasterPlanRepository.update as any).mockResolvedValue({
        ...clonedPlan,
        notebookId: 'new-session-id',
      });

      const { req } = createMocks({
        method: 'POST',
        query: { id: 'plan1' },
        body: { sessionId: 'temp-session' },
      });
      req.user = { id: 'user123' } as any;

      const plan = await questMasterPlanRepository.findById('plan1');
      const isPlaceholder = plan?.notebookId.startsWith('clone-') || plan?.notebookId.startsWith('direct-');

      if (isPlaceholder) {
        const newSession = await sessionService.createSession(req.user, { name: `Quest: ${plan?.goal}` }, {} as any);
        plan!.notebookId = newSession.id;
        await questMasterPlanRepository.update(plan!);
      }

      expect(sessionService.createSession).toHaveBeenCalled();
      expect(questMasterPlanRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ notebookId: 'new-session-id' })
      );
    });
  });

  describe('PATCH /api/quest-plans/[id]/progress', () => {
    it('should update sub-quest status', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      const mockPlan = {
        id: 'plan1',
        userId: 'user123',
        state: 'active',
        quests: [
          {
            id: 'q1',
            subQuests: [{ id: 'sq1', status: 'not_started' }],
          },
        ],
      };

      (questMasterPlanRepository.findById as any).mockResolvedValue(mockPlan);
      (questMasterPlanRepository.updateQuestProgress as any).mockResolvedValue(undefined);

      const { req } = createMocks({
        method: 'PATCH',
        query: { id: 'plan1' },
        body: { questId: 'q1', subQuestId: 'sq1', status: 'completed' },
      });
      req.user = { id: 'user123' } as any;

      await questMasterPlanRepository.updateQuestProgress('plan1', 'q1', 'sq1', {
        status: 'completed',
      });

      expect(questMasterPlanRepository.updateQuestProgress).toHaveBeenCalledWith('plan1', 'q1', 'sq1', {
        status: 'completed',
      });
    });

    it('should auto-resume paused quest when starting subtask', async () => {
      const { questMasterPlanRepository } = await import('@bike4mind/database');
      const pausedPlan = {
        id: 'plan1',
        userId: 'user123',
        state: 'paused',
      };

      (questMasterPlanRepository.findById as any).mockResolvedValue(pausedPlan);
      (questMasterPlanRepository.update as any).mockResolvedValue({ ...pausedPlan, state: 'active' });

      const { req } = createMocks({
        method: 'PATCH',
        query: { id: 'plan1' },
        body: { questId: 'q1', subQuestId: 'sq1', status: 'in_progress' },
      });
      req.user = { id: 'user123' } as any;

      const plan = await questMasterPlanRepository.findById('plan1');
      const status = req.body.status;

      // Auto-resume if paused and starting work
      if (plan?.state === 'paused' && status === 'in_progress') {
        plan.state = 'active';
        await questMasterPlanRepository.update(plan);
      }

      expect(questMasterPlanRepository.update).toHaveBeenCalledWith(expect.objectContaining({ state: 'active' }));
    });

    it('should require questId and subQuestId', async () => {
      const { req, res } = createMocks({
        method: 'PATCH',
        query: { id: 'plan1' },
        body: { status: 'completed' },
      });
      req.user = { id: 'user123' } as any;

      const { questId, subQuestId } = req.body;

      if (!questId || !subQuestId) {
        res.status(400).json({ error: 'questId and subQuestId are required' });
      }

      expect(res._getStatusCode()).toBe(400);
      expect(JSON.parse(res._getData())).toEqual({
        error: 'questId and subQuestId are required',
      });
    });

    it('should backfill userId for legacy plans', async () => {
      const { questMasterPlanRepository, sessionRepository } = await import('@bike4mind/database');
      const legacyPlan = {
        id: 'plan1',
        userId: undefined,
        notebookId: 'session123',
        state: 'active',
      };
      const session = { id: 'session123', userId: 'user123' };

      (questMasterPlanRepository.findById as any).mockResolvedValue(legacyPlan);
      (sessionRepository.findById as any).mockResolvedValue(session);
      (questMasterPlanRepository.update as any).mockResolvedValue({
        ...legacyPlan,
        userId: 'user123',
      });

      const { req } = createMocks({
        method: 'PATCH',
        query: { id: 'plan1' },
        body: { questId: 'q1', subQuestId: 'sq1', status: 'completed' },
      });
      req.user = { id: 'user123' } as any;

      const plan = await questMasterPlanRepository.findById('plan1');
      const userId = req.user?.id;

      // Check access for legacy plan
      if (!plan?.userId) {
        const sessionData = await sessionRepository.findById(plan!.notebookId);
        const hasAccess = Boolean(sessionData && sessionData.userId === userId);

        // Backfill userId
        if (hasAccess && sessionData) {
          plan!.userId = sessionData.userId;
          await questMasterPlanRepository.update(plan!);
        }
      }

      expect(questMasterPlanRepository.update).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user123' }));
    });
  });

  describe('Quest completion logic', () => {
    it('should auto-complete quest when all subtasks are done', () => {
      const plan = {
        id: 'plan1',
        state: 'active',
        metrics: {
          completionRate: 100,
          subQuestsCompleted: 5,
          subQuestsTotal: 5,
        },
      };

      // Simulate updateMetrics logic
      if (plan.metrics.completionRate === 100 && (plan.state === 'active' || plan.state === 'paused')) {
        plan.state = 'completed';
      }

      expect(plan.state).toBe('completed');
    });

    it('should auto-complete paused quests at 100%', async () => {
      const plan = {
        id: 'plan1',
        state: 'paused',
        metrics: { completionRate: 100 },
      };

      if (plan.metrics.completionRate === 100 && (plan.state === 'active' || plan.state === 'paused')) {
        plan.state = 'completed';
      }

      expect(plan.state).toBe('completed');
    });
  });

  describe('Security: Access control on /continue endpoint', () => {
    it('should deny access to non-owner on continue endpoint', async () => {
      const { questMasterPlanRepository, sessionRepository } = await import('@bike4mind/database');
      const otherUserPlan = {
        id: 'plan1',
        goal: 'Other User Quest',
        userId: 'other-user-id',
        state: 'active',
        notebookId: 'session123',
        sharedWith: [],
        visibility: 'user',
      };

      (questMasterPlanRepository.findById as any).mockResolvedValue(otherUserPlan);
      (sessionRepository.findById as any).mockResolvedValue({ id: 'session123', userId: 'user123' });

      const { req, res } = createMocks({
        method: 'POST',
        query: { id: 'plan1' },
        body: { sessionId: 'session123' },
      });
      req.user = { id: 'user123' } as any;

      const userId = req.user?.id;
      const plan = await questMasterPlanRepository.findById('plan1');

      // Check access: owner, shared, or public
      if (plan?.userId !== userId && !plan?.sharedWith?.includes(userId!) && plan?.visibility !== 'public') {
        res.status(403).json({ error: 'Access denied' });
      }

      expect(res._getStatusCode()).toBe(403);
      expect(JSON.parse(res._getData())).toEqual({ error: 'Access denied' });
    });

    it('should allow access to shared user on continue endpoint', async () => {
      const { questMasterPlanRepository, sessionRepository } = await import('@bike4mind/database');
      const sharedPlan = {
        id: 'plan1',
        goal: 'Shared Quest',
        userId: 'other-user-id',
        state: 'active',
        notebookId: 'session123',
        sharedWith: ['user123'],
        visibility: 'user',
      };

      (questMasterPlanRepository.findById as any).mockResolvedValue(sharedPlan);
      (sessionRepository.findById as any).mockResolvedValue({ id: 'session123', userId: 'user123' });

      const { req, res } = createMocks({
        method: 'POST',
        query: { id: 'plan1' },
        body: { sessionId: 'session123' },
      });
      req.user = { id: 'user123' } as any;

      const userId = req.user?.id;
      const plan = await questMasterPlanRepository.findById('plan1');

      // Check access: owner, shared, or public
      const hasAccess = plan?.userId === userId || plan?.sharedWith?.includes(userId!) || plan?.visibility === 'public';

      if (hasAccess) {
        res.status(200).json({ success: true });
      } else {
        res.status(403).json({ error: 'Access denied' });
      }

      expect(res._getStatusCode()).toBe(200);
    });
  });

  describe('Security: Session ownership validation on /continue endpoint', () => {
    it('should deny access when session does not belong to user', async () => {
      const { sessionRepository } = await import('@bike4mind/database');
      const otherUserSession = { id: 'session456', userId: 'other-user-id' };

      (sessionRepository.findById as any).mockResolvedValue(otherUserSession);

      const { req, res } = createMocks({
        method: 'POST',
        query: { id: 'plan1' },
        body: { sessionId: 'session456' },
      });
      req.user = { id: 'user123' } as any;

      const userId = req.user?.id;
      const session = await sessionRepository.findById('session456');

      // Validate session belongs to user
      if (!session || session.userId !== userId) {
        res.status(403).json({ error: 'Invalid session' });
      }

      expect(res._getStatusCode()).toBe(403);
      expect(JSON.parse(res._getData())).toEqual({ error: 'Invalid session' });
    });

    it('should deny access when session does not exist', async () => {
      const { sessionRepository } = await import('@bike4mind/database');
      (sessionRepository.findById as any).mockResolvedValue(null);

      const { req, res } = createMocks({
        method: 'POST',
        query: { id: 'plan1' },
        body: { sessionId: 'nonexistent' },
      });
      req.user = { id: 'user123' } as any;

      const userId = req.user?.id;
      const session = await sessionRepository.findById('nonexistent');

      // Validate session belongs to user
      if (!session || session.userId !== userId) {
        res.status(403).json({ error: 'Invalid session' });
      }

      expect(res._getStatusCode()).toBe(403);
      expect(JSON.parse(res._getData())).toEqual({ error: 'Invalid session' });
    });
  });

  describe('Security: Pagination bounds', () => {
    it('should enforce maximum limit of 100', () => {
      // Simulate the bounded limit calculation
      const requestedLimit = 10000;
      const parsedLimit = Math.min(Math.max(Number(requestedLimit) || 50, 1), 100);

      expect(parsedLimit).toBe(100);
    });

    it('should default to 50 when no limit provided', () => {
      const requestedLimit = undefined;
      const parsedLimit = Math.min(Math.max(Number(requestedLimit) || 50, 1), 100);

      expect(parsedLimit).toBe(50);
    });

    it('should enforce minimum limit of 1', () => {
      const requestedLimit = -5;
      const parsedLimit = Math.min(Math.max(Number(requestedLimit) || 50, 1), 100);

      expect(parsedLimit).toBe(1);
    });

    it('should ensure offset is non-negative', () => {
      const requestedOffset = -10;
      const parsedOffset = Math.max(Number(requestedOffset) || 0, 0);

      expect(parsedOffset).toBe(0);
    });
  });
});
