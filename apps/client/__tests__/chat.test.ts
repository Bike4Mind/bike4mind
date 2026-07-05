import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Mock dependencies
vi.mock('@bike4mind/services', () => ({
  ChatCompletionInvoke: vi.fn(),
  ChatCompletionProcess: vi.fn(),
  featureNames: {},
}));

vi.mock('@bike4mind/utils', () => ({
  NotFoundError: class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NotFoundError';
    }
  },
  getSettingsMap: vi.fn(),
  getSettingsValue: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  User: {
    findById: vi.fn(),
    findByIdAndUpdate: vi.fn(),
  },
  Session: {
    findOne: vi.fn(),
  },
}));

const mockPost = vi.fn(handlerFn => handlerFn);
const mockUse = vi.fn().mockReturnValue({ post: mockPost });
const mockBaseApi = vi.fn(() => ({ use: mockUse }));
const mockRateLimit = vi.fn(() => (req: any, res: any, next: any) => next());

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: mockBaseApi,
}));

vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: mockRateLimit,
}));

vi.mock('@server/queueHandlers/questStart', () => ({
  defaultChatCompletionOptions: {},
}));

// TODO: Fix test
describe.skip('/api/chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/chat', () => {
    it('should process chat request and return quest ID when wait=false', async () => {
      const { ChatCompletionInvoke } = await import('@bike4mind/services');
      const { User } = await import('@bike4mind/database');
      const handler = (await import('@pages/api/chat')).default;

      const mockQuest = {
        id: 'quest123',
        status: 'queued',
      };

      const mockInvokeService = {
        invoke: vi.fn().mockResolvedValue(mockQuest),
      };

      (ChatCompletionInvoke as any).mockImplementation(() => mockInvokeService);
      (User.findById as any).mockResolvedValue({
        lastNotebookId: 'session123',
      });

      const { req, res } = createMocks({
        method: 'POST',
        body: {
          message: 'Hello, how are you?',
          model: 'gpt-4o',
          wait: false,
        },
      });

      req.user = { id: 'user123' } as any;
      req.logger = { info: vi.fn() } as any;

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);

      const response = JSON.parse(res._getData());
      expect(response).toMatchObject({
        id: 'quest123',
        status: 'queued',
        message_received: true,
        model: 'gpt-4o',
        tracking_info: {
          quest_id: 'quest123',
          check_status_url: '/api/quests/quest123',
        },
      });
    });

    it('should process synchronously and return complete response when wait=true', async () => {
      const { ChatCompletionInvoke, ChatCompletionProcess } = await import('@bike4mind/services');
      const { getSettingsMap, getSettingsValue } = await import('@bike4mind/utils');
      const { User } = await import('@bike4mind/database');
      const handler = (await import('@pages/api/chat')).default;

      const mockQuest = {
        id: 'quest123',
        status: 'completed',
        reply: 'Hello! I am doing well, thank you.',
        replies: ['Hello! I am doing well, thank you.'],
        createdAt: new Date(),
      };

      const mockInvokeService = {
        invoke: vi.fn().mockResolvedValue({ id: 'quest123' }),
      };

      const mockProcessService = {
        process: vi.fn().mockResolvedValue(undefined),
        db: {
          quests: {
            findById: vi.fn().mockResolvedValue(mockQuest),
          },
        },
      };

      (ChatCompletionInvoke as any).mockImplementation(() => mockInvokeService);
      (ChatCompletionProcess as any).mockImplementation(() => mockProcessService);
      (User.findById as any).mockResolvedValue({
        lastNotebookId: 'session123',
      });
      (getSettingsMap as any).mockResolvedValue({});
      (getSettingsValue as any).mockReturnValue('text-embedding-3-small');

      const { req, res } = createMocks({
        method: 'POST',
        body: {
          message: 'Hello, how are you?',
          model: 'gpt-4o',
          wait: true,
        },
      });

      req.user = { id: 'user123' } as any;
      req.logger = { info: vi.fn() } as any;

      await handler(req, res);

      expect(mockProcessService.process).toHaveBeenCalled();
      expect(res._getStatusCode()).toBe(200);

      const response = JSON.parse(res._getData());
      expect(response).toMatchObject({
        id: 'quest123',
        status: 'completed',
        response: 'Hello! I am doing well, thank you.',
        responses: ['Hello! I am doing well, thank you.'],
      });
    });

    it('should validate required fields', async () => {
      const handler = (await import('@pages/api/chat')).default;

      const { req, res } = createMocks({
        method: 'POST',
        body: {
          // Missing required 'message' field
          model: 'gpt-4o',
        },
      });

      req.user = { id: 'user123' } as any;
      req.logger = { info: vi.fn() } as any;

      await expect(handler(req, res)).rejects.toThrow();
    });

    it('should find most recent session when sessionId not provided', async () => {
      const { User, Session } = await import('@bike4mind/database');
      const { ChatCompletionInvoke } = await import('@bike4mind/services');
      const handler = (await import('@pages/api/chat')).default;

      (User.findById as any).mockResolvedValue({ lastNotebookId: null });
      (Session.findOne as any).mockReturnValue({
        sort: vi.fn().mockResolvedValue({
          id: 'session456',
        }),
      });
      (User.findByIdAndUpdate as any).mockResolvedValue({});

      const mockInvokeService = {
        invoke: vi.fn().mockResolvedValue({ id: 'quest123' }),
      };
      (ChatCompletionInvoke as any).mockImplementation(() => mockInvokeService);

      const { req, res } = createMocks({
        method: 'POST',
        body: {
          message: 'Test message',
        },
      });

      req.user = { id: 'user123' } as any;
      req.logger = { info: vi.fn() } as any;

      await handler(req, res);

      expect(Session.findOne).toHaveBeenCalledWith({ userId: 'user123' });
      expect(User.findByIdAndUpdate).toHaveBeenCalledWith('user123', {
        lastNotebookId: 'session456',
      });
    });

    it('should apply rate limiting', () => {
      expect(mockRateLimit).toHaveBeenCalledWith({
        limit: expect.any(Number),
        windowMs: 60 * 1000,
      });
    });
  });
});
