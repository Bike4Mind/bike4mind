import { ServerStatusEnum } from '@bike4mind/common';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { adminSettingsRepository } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { Request, Response } from 'express';

const handler = baseApi({ auth: false }).get(
  asyncHandler(async (req: Request<{}, { serverStatus: ServerStatusEnum }>, res: Response) => {
    // Fetch the server status setting from the database
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    const serverStatus = getSettingsValue('serverStatus', settings);

    return res.json({ serverStatus });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
