import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@bike4mind/database', () => ({
  organizationRepository: {
    create: vi.fn(),
  },
}));

vi.mock('@bike4mind/services', () => ({
  organizationService: {
    create: vi.fn(),
  },
}));

vi.mock('@server/utils/config', () => ({
  isDevelopment: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: vi.fn(() => ({
    post: vi.fn(handler => handler),
  })),
}));

import { organizationRepository } from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';
import { isDevelopment } from '@server/utils/config';

describe('POST /api/organizations/create-dev', () => {
  const mockReq = {
    body: {
      name: 'Test Team',
      seats: 4,
    },
    user: {
      id: 'user123',
      email: 'test@example.com',
    },
    logger: {
      info: vi.fn(),
    },
  };

  const mockRes = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset modules to ensure clean state between tests
    vi.resetModules();
  });

  it('should create organization in development mode', async () => {
    (isDevelopment as any).mockReturnValue(true);
    const mockOrganization = {
      id: 'org123',
      name: 'Test Team',
      seats: 4,
      personal: false,
    };
    (organizationService.create as any).mockResolvedValue(mockOrganization);

    const handler = (await import('../pages/api/organizations/create-dev')).default;
    await handler(mockReq as any, mockRes as any);

    expect(organizationService.create).toHaveBeenCalledWith(
      mockReq.user,
      {
        name: 'Test Team',
        seats: 4,
        personal: false,
        stripeCustomerId: null,
      },
      {
        db: {
          organizations: organizationRepository,
        },
      }
    );
    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.json).toHaveBeenCalledWith({
      organization: {
        id: 'org123',
        name: 'Test Team',
        seats: 4,
      },
    });
  });

  it('should reject request in production mode', async () => {
    (isDevelopment as any).mockReturnValue(false);

    const handler = (await import('../pages/api/organizations/create-dev')).default;

    await expect(handler(mockReq as any, mockRes as any)).rejects.toThrow(
      'This endpoint is only available in development mode'
    );
    expect(organizationService.create).not.toHaveBeenCalled();
  });

  it('should use default seats when not provided', async () => {
    (isDevelopment as any).mockReturnValue(true);
    const mockOrganization = {
      id: 'org123',
      name: 'Test Team',
      seats: 4, // ORGANIZATION_SUBSCRIPTION_MIN_SEATS
      personal: false,
    };
    (organizationService.create as any).mockResolvedValue(mockOrganization);

    const reqWithoutSeats = {
      ...mockReq,
      body: { name: 'Test Team' },
    };

    const handler = (await import('../pages/api/organizations/create-dev')).default;
    await handler(reqWithoutSeats as any, mockRes as any);

    expect(organizationService.create).toHaveBeenCalledWith(
      mockReq.user,
      expect.objectContaining({
        seats: 4, // Should default to ORGANIZATION_SUBSCRIPTION_MIN_SEATS
      }),
      expect.any(Object)
    );
  });

  it('should validate minimum seats requirement', async () => {
    (isDevelopment as any).mockReturnValue(true);

    const reqWithInvalidSeats = {
      ...mockReq,
      body: { name: 'Test Team', seats: 2 },
    };

    const handler = (await import('../pages/api/organizations/create-dev')).default;

    await expect(handler(reqWithInvalidSeats as any, mockRes as any)).rejects.toThrow();
  });
});
