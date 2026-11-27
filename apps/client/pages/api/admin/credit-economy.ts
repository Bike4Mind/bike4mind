import { CREDITS_PAGE_READ, BadRequestError } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { readEconomyPage, readEconomyReport } from '@server/admin/creditEconomy';
import { EconomyQuery, EconomyReport, EconomyPage } from '../../../shared/creditEconomy';
import { z } from 'zod';

const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: CREDITS_PAGE_READ } }).get(
  asyncHandler(async (req, res) => {
    const parsed = EconomyQuery.safeParse(req.query);
    const view = z.object({ view: z.enum(['summary', 'transactions']).default('summary') }).safeParse(req.query);
    if (!parsed.success || !view.success) {
      throw new BadRequestError('Choose a valid owner, flow, page and UTC date window (at most 366 days)');
    }
    if (Date.parse(parsed.data.to) > Date.now()) throw new BadRequestError('End must not be in the future');
    res.setHeader('Cache-Control', 'private, no-store');
    if (view.data.view === 'transactions') return res.json(EconomyPage.parse(await readEconomyPage(parsed.data)));
    return res.json(EconomyReport.parse(await readEconomyReport(parsed.data)));
  })
);

export const config = { api: { externalResolver: true } };
export default handler;
