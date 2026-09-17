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

import { Config, isDevelopment } from '@server/utils/config';
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
      (Config as any).STRIPE_WEBHOOK_SECRET = 'whsec_test123';
      (Config as any).STRIPE_PUBLISHABLE_KEY = 'pk_test_123';
      (Config as any).STRIPE_SECRET_KEY = 'sk_test_123';
    });

    it('should call next with no arguments when all Stripe config is present', async () => {
      const middleware = requireStripeWebhook();
      await middleware(mockReq as any, mockRes as any, mockNext);

      expect(mockNext).toHaveBeenCalledTimes(1);
      expect(mockNext).toHaveBeenCalledWith();
    });

    it('should call next exactly once with an error when the webhook secret is missing', async () => {
      (Config as any).STRIPE_WEBHOOK_SECRET = '';

      const middleware = requireStripeWebhook();
      await middleware(mockReq as any, mockRes as any, mockNext);

      // Regression guard: a bare next(err) with no return, followed by an unconditional
      // next(), used to call next twice here, racing the error handler.
      expect(mockNext).toHaveBeenCalledTimes(1);
      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Stripe webhook secret is not configured' })
      );
    });

    it('should call next exactly once with an error when the publishable or secret key is missing', async () => {
      (Config as any).STRIPE_PUBLISHABLE_KEY = '';

      const middleware = requireStripeWebhook();
      await middleware(mockReq as any, mockRes as any, mockNext);

      expect(mockNext).toHaveBeenCalledTimes(1);
      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Stripe publishable or secret key is not configured' })
      );
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
