import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@casl/mongoose', () => ({
  accessibleBy: vi.fn(() => ({
    ofType: vi.fn(() => ({})),
  })),
}));

vi.mock('@bike4mind/common', () => ({
  Permission: {
    delete: 'delete',
  },
  searchSchema: {
    parse: vi.fn(() => ({
      search: {},
      pagination: { page: 1, limit: 10 },
      orderBy: { field: 'createdAt', order: 'desc' },
    })),
  },
  SessionEvents: {
    DELETE_ALL_SESSIONS: 'DELETE_ALL_SESSIONS',
  },
}));

vi.mock('@bike4mind/services', () => ({
  sessionService: {
    searchOwnSessions: vi.fn(),
  },
}));

vi.mock('@bike4mind/database/auth', () => ({
  default: {
    deleteMany: vi.fn(),
  },
  sessionRepository: {},
}));

vi.mock('@server/utils/analyticsLog', () => ({
  logEvent: vi.fn(),
}));

const mockDelete = vi.fn(handlerFn => handlerFn);
const mockGet = vi.fn(handlerFn => ({ delete: mockDelete }));
const mockBaseApi = vi.fn(() => ({ get: mockGet }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: mockBaseApi,
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: vi.fn(fn => fn),
}));

// TODO: Fix test
describe.skip('/api/sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/sessions', () => {
    it('should return user sessions when authenticated', async () => {
      const { sessionService } = await import('@bike4mind/services');
      const handler = (await import('@pages/api/sessions/index')).default;

      const mockSessions = [
        { id: '1', title: 'Test Session 1' },
        { id: '2', title: 'Test Session 2' },
      ];

      (sessionService.searchOwnSessions as any).mockResolvedValue(mockSessions);

      const { req, res } = createMocks({
        method: 'GET',
        query: { page: '1', limit: '10' },
      });

      req.user = { id: 'user123' } as any;

      await handler(req, res);

      expect(sessionService.searchOwnSessions).toHaveBeenCalledWith(
        'user123',
        expect.objectContaining({
          search: {},
          pagination: { page: 1, limit: 10 },
          orderBy: { field: 'createdAt', order: 'desc' },
        }),
        expect.any(Object)
      );

      expect(res._getStatusCode()).toBe(200);
      expect(JSON.parse(res._getData())).toEqual(mockSessions);
    });

    it('should return empty array when not authenticated', async () => {
      const handler = (await import('@pages/api/sessions/index')).default;

      const { req, res } = createMocks({
        method: 'GET',
        query: {},
      });

      // No req.user set

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(JSON.parse(res._getData())).toEqual([]);
    });
  });

  describe('DELETE /api/sessions', () => {
    it('should delete all user sessions when authorized', async () => {
      const { logEvent } = await import('@server/utils/analyticsLog');
      const SessionModel = (await import('@bike4mind/database/auth')).default;
      const handler = (await import('@pages/api/sessions/index')).default;

      (SessionModel.deleteMany as any).mockResolvedValue({
        deletedCount: 5,
      });

      const { req, res } = createMocks({
        method: 'DELETE',
      });

      req.user = { id: 'user123' } as any;
      req.ability = {
        can: vi.fn(() => true),
      } as any;

      await handler(req, res);

      expect(SessionModel.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user123',
        })
      );

      expect(logEvent).toHaveBeenCalledWith({
        userId: 'user123',
        type: 'DELETE_ALL_SESSIONS',
        metadata: { sessionCount: 5 },
      });

      expect(res._getStatusCode()).toBe(204);
    });

    it('should return 403 when user lacks delete permission', async () => {
      const handler = (await import('@pages/api/sessions/index')).default;

      const { req, res } = createMocks({
        method: 'DELETE',
      });

      req.user = { id: 'user123' } as any;
      req.ability = {
        can: vi.fn(() => false),
      } as any;

      await handler(req, res);

      expect(res._getStatusCode()).toBe(403);
      const responseData = res._getData();
      expect(responseData).toMatch(/Forbidden/);
    });
  });
});
