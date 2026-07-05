import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { WhatsNewConfigService } from '@client/services/whatsNewConfigService';
import { ForbiddenError } from '@server/utils/errors';

// Rate limiting constants
const HISTORY_RATE_LIMIT = 30; // requests per minute
const ONE_MINUTE_MS = 60 * 1000;

const handler = baseApi()
  .use(rateLimit({ limit: HISTORY_RATE_LIMIT, windowMs: ONE_MINUTE_MS }))
  .get(async (req: Request, res: Response) => {
    // Check if user is admin
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    try {
      const history = await WhatsNewConfigService.getConfigHistory();

      return res.json({
        success: true,
        history,
      });
    } catch (error) {
      console.error("Error getting What's New config history:", error);
      return res.status(500).json({
        error: "Failed to get What's New configuration history",
      });
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
