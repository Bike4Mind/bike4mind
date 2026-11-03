import type { Request, Response } from 'express';
import { adminApi } from '@server/middlewares/adminApi';
import { getIncidentSignals } from '@server/security/incidentSignals';
import { INCIDENT_RANGES, type IncidentRange } from '@client/app/components/admin/SecurityDashboard/incidentTypes';

const isIncidentRange = (value: unknown): value is IncidentRange => INCIDENT_RANGES.includes(value as IncidentRange);

const handler = adminApi<Request, Response>({
  auth: 'jwtOnly',
  adminPermissions: { GET: 'support:read' },
}).get(async (req: Request, res: Response) => {
  const rawRange = req.query.range;
  if (rawRange !== undefined && !isIncidentRange(rawRange)) {
    return res.status(400).json({ error: 'Invalid range. Must be one of: 1h, 24h, 7d.' });
  }
  const range: IncidentRange = isIncidentRange(rawRange) ? rawRange : '24h';
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json(await getIncidentSignals(range));
});

export const config = { api: { externalResolver: true } };

export default handler;
