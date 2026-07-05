import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { AdminSettings } from '@bike4mind/database';
import { ForbiddenError } from '@server/utils/errors';

const SETTING_NAME = 'whatsNewGenerationStatus';
const RATE_LIMIT = 10;
const ONE_MINUTE_MS = 60 * 1000;

const handler = baseApi()
  .use(rateLimit({ limit: RATE_LIMIT, windowMs: ONE_MINUTE_MS }))
  .get(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const setting = await AdminSettings.findOne({ settingName: SETTING_NAME }).lean();

    if (!setting?.settingValue) {
      return res.json({
        lastStatus: null,
        lastCompletedAt: null,
        lastCorrelationId: null,
        lastModelUsed: null,
        lastGeneratedDate: null,
        lastError: null,
        lastRunAt: null,
      });
    }

    const value = setting.settingValue as unknown as Record<string, unknown>;
    return res.json({
      lastStatus: value.lastStatus || null,
      lastCompletedAt: value.lastCompletedAt || null,
      lastCorrelationId: value.lastCorrelationId || null,
      lastModelUsed: value.lastModelUsed || null,
      lastGeneratedDate: value.lastGeneratedDate || null,
      lastError: value.lastError || null,
      lastRunAt: value.lastRunAt || null,
    });
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
