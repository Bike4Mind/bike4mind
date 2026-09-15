import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies BEFORE importing anything that uses them
vi.mock('../security/secretCache', () => ({
  secretCache: {
    getSecret: vi.fn(),
  },
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
}));

vi.mock('jsonwebtoken', () => ({
  default: {
    verify: vi.fn(),
    JsonWebTokenError: class JsonWebTokenError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'JsonWebTokenError';
      }
    },
  },
}));

vi.mock('./baseApi', () => ({
  baseApi: vi.fn(),
}));

import { secretCache } from '../security/secretCache';
import { connectDB } from '@bike4mind/database';
import jwt from 'jsonwebtoken';
import { UnauthorizedError } from '../utils/errors';

describe('Secret caching in API handlers', () => {
  const mockHandler = vi.fn();

  const mockReq: {
    headers: {
      authorization?: string;
    };
    user?: any;
  } = {
    headers: {},
  };
  const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };

  // Simulates baseApi.get() behavior
  const mockApiHandler = async (req: any, res: any) => {
    const mongodbUri = await secretCache.getSecret('MONGODB_URI');
    if (!mongodbUri) throw new Error('Missing MONGODB_URI');
    await connectDB(mongodbUri);

    const jwtSecret = await secretCache.getSecret('JWT_SECRET');
    if (!jwtSecret) throw new Error('Missing JWT_SECRET');

    if (req.headers.authorization) {
      const token = req.headers.authorization.split(' ')[1];
      try {
        const decoded = jwt.verify(token, jwtSecret);
        req.user = decoded;
      } catch (error) {
        if (error instanceof jwt.JsonWebTokenError) {
          throw new UnauthorizedError('Invalid token');
        }
        throw error;
      }
    }

    // Call the handler that would be passed to get()
    return mockHandler(req, res);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockReq.headers = {};
    mockReq.user = undefined;
    mockRes.status.mockClear();
    mockRes.json.mockClear();
    (secretCache.getSecret as any).mockReset();
  });

  it('should fetch secrets and connect to database', async () => {
    (secretCache.getSecret as any).mockResolvedValueOnce('mock-mongodb-uri').mockResolvedValueOnce('mock-jwt-secret');

    await mockApiHandler(mockReq, mockRes);

    expect(secretCache.getSecret).toHaveBeenCalledWith('MONGODB_URI');
    expect(secretCache.getSecret).toHaveBeenCalledWith('JWT_SECRET');
    expect(connectDB).toHaveBeenCalledWith('mock-mongodb-uri');
    expect(mockHandler).toHaveBeenCalledWith(mockReq, mockRes);
  });

  it('should handle JWT authentication', async () => {
    const mockToken = 'mock-token';
    const mockDecoded = { id: '123' };
    mockReq.headers.authorization = `Bearer ${mockToken}`;

    (secretCache.getSecret as any).mockResolvedValueOnce('mock-mongodb-uri').mockResolvedValueOnce('mock-jwt-secret');
    (jwt.verify as any).mockReturnValue(mockDecoded);

    await mockApiHandler(mockReq, mockRes);

    expect(jwt.verify).toHaveBeenCalledWith(mockToken, 'mock-jwt-secret');
    expect(mockReq.user).toEqual(mockDecoded);
    expect(mockHandler).toHaveBeenCalledWith(mockReq, mockRes);
  });

  it('should handle invalid JWT tokens', async () => {
    mockReq.headers.authorization = 'Bearer invalid-token';

    (secretCache.getSecret as any).mockResolvedValueOnce('mock-mongodb-uri').mockResolvedValueOnce('mock-jwt-secret');
    (jwt.verify as any).mockImplementation(() => {
      throw new jwt.JsonWebTokenError('Invalid token');
    });

    await expect(mockApiHandler(mockReq, mockRes)).rejects.toThrow(UnauthorizedError);
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('should not verify JWT without auth header', async () => {
    (secretCache.getSecret as any).mockResolvedValueOnce('mock-mongodb-uri').mockResolvedValueOnce('mock-jwt-secret');

    await mockApiHandler(mockReq, mockRes);

    expect(jwt.verify).not.toHaveBeenCalled();
    expect(mockHandler).toHaveBeenCalledWith(mockReq, mockRes);
  });
});
