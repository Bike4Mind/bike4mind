import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Mock dependencies
vi.mock('@bike4mind/database', () => ({
  User: {
    findById: vi.fn(),
    find: vi.fn(),
    create: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    findByIdAndDelete: vi.fn(),
  },
}));

const mockBaseApi = vi.fn(() => ({
  get: vi.fn(handlerFn => handlerFn),
  post: vi.fn(handlerFn => handlerFn),
  put: vi.fn(handlerFn => handlerFn),
  delete: vi.fn(handlerFn => handlerFn),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: mockBaseApi,
}));

// TODO: Fix test
describe.skip('/api/users', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/users/[id]', () => {
    it('should return user by id without password', async () => {
      const { User } = await import('@bike4mind/database');
      const handler = (await import('@pages/api/users/[id]/index')).default;

      const mockUser = {
        _id: '507f1f77bcf86cd799439011',
        username: 'testuser',
        name: 'Test User',
        email: 'test@example.com',
        level: 'Pro',
      };

      (User.findById as any).mockReturnValue({
        populate: vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue(mockUser),
        }),
      });

      const { req, res } = createMocks({
        method: 'GET',
        query: { id: '507f1f77bcf86cd799439011' },
      });

      await handler(req, res);

      expect(User.findById).toHaveBeenCalledWith('507f1f77bcf86cd799439011');
      expect(res._getStatusCode()).toBe(200);
      expect(JSON.parse(res._getData())).toEqual(mockUser);
    });

    it('should require authentication', () => {
      expect(mockBaseApi).toHaveBeenCalledWith();
    });
  });
});
