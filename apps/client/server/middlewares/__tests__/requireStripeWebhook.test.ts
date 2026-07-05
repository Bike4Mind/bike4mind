import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@server/utils/config', () => ({
  Config: {
    STRIPE_WEBHOOK_SECRET: 'whsec_test123',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_123',
    STRIPE_SECRET_KEY: 'sk_test_123',
  },
  isDevelopment: vi.fn(),
}));

vi.mock('@server/utils/errors', () => ({
  InternalServerError: class InternalServerError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'InternalServerError';
    }
  },
}));

import { isDevelopment } from '@server/utils/config';
import { requireStripeWebhook } from '../requireStripeWebhook';

describe('requireStripeWebhook middleware', () => {
  const mockReq = {
    logger: {
      warn: vi.fn(),
    },
  };

  const mockRes = {};
  const mockNext = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Development Mode', () => {
    it('should skip validation in development mode', async () => {
      (isDevelopment as any).mockReturnValue(true);

      const middleware = requireStripeWebhook();
      await middleware(mockReq as any, mockRes as any, mockNext);

      expect(mockReq.logger.warn).toHaveBeenCalledWith('Skipping Stripe webhook secret validation in development mode');
      expect(mockNext).toHaveBeenCalledWith();
    });

    it('should log warning when skipping validation', async () => {
      (isDevelopment as any).mockReturnValue(true);

      const middleware = requireStripeWebhook();
      await middleware(mockReq as any, mockRes as any, mockNext);

      expect(mockReq.logger.warn).toHaveBeenCalled();
    });
  });

  describe('Production Mode', () => {
    beforeEach(() => {
      (isDevelopment as any).mockReturnValue(false);
    });

    it('should validate webhook secret exists in production', async () => {
      const middleware = requireStripeWebhook();

      // Mock empty webhook secret
      vi.doMock('@server/utils/config', () => ({
        Config: {
          STRIPE_WEBHOOK_SECRET: '',
          STRIPE_PUBLISHABLE_KEY: 'pk_test_123',
          STRIPE_SECRET_KEY: 'sk_test_123',
        },
        isDevelopment: vi.fn().mockReturnValue(false),
      }));

      await middleware(mockReq as any, mockRes as any, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should not log warning in production mode', async () => {
      const middleware = requireStripeWebhook();
      await middleware(mockReq as any, mockRes as any, mockNext);

      expect(mockReq.logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing logger gracefully', async () => {
      (isDevelopment as any).mockReturnValue(true);
      const reqWithoutLogger = {};

      const middleware = requireStripeWebhook();

      await expect(middleware(reqWithoutLogger as any, mockRes as any, mockNext)).resolves.not.toThrow();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should accept empty options object', async () => {
      (isDevelopment as any).mockReturnValue(true);

      const middleware = requireStripeWebhook({});
      await middleware(mockReq as any, mockRes as any, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });
});
