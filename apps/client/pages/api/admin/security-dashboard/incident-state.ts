import type { Request, Response } from 'express';
import { adminApi } from '@server/middlewares/adminApi';
import { getIncidentState } from '@server/security/incidentState';

const handler = adminApi<Request, Response>({
  auth: 'jwtOnly',
  adminPermissions: { GET: 'support:read' },
}).get(async (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json(await getIncidentState());
});

export const config = { api: { externalResolver: true } };

export default handler;
