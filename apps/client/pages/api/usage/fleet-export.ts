import { randomUUID } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { connectDB, CounterLog } from '@bike4mind/database';
import { FleetUsageExportQuerySchema, type FleetUsageExport } from '@bike4mind/common';
import { Config } from '@server/utils/config';
import {
  authorizeFleetUsageExport,
  FleetUsageExportTooLargeError,
  readFleetUsageExport,
} from '@server/usage/fleetUsageExport';

// Dedicated machine auth only: sessions and general API keys cannot enter this route.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const requestId = randomUUID();
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed', request_id: requestId });
  }
  try {
    const scope = authorizeFleetUsageExport(req.headers.authorization, {
      FLEET_USAGE_EXPORT_TOKEN: process.env.FLEET_USAGE_EXPORT_TOKEN,
      FLEET_USAGE_EXPORT_SCOPE: process.env.FLEET_USAGE_EXPORT_SCOPE,
    });
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE));
    const audit = async (outcome: string, range?: { from: string; to: string }) => {
      await CounterLog.create({
        userId: 'fleet-usage-export',
        userName: 'Fleet usage export',
        userLevel: 'service',
        counterName: 'Fleet Usage Export Access',
        counterValue: 1,
        datetime: new Date(),
        metadata: { requestId, outcome, ...range },
      });
    };
    if (!scope) {
      await audit('deny');
      return res.status(401).json({ error: 'Invalid export credential or scope configuration', request_id: requestId });
    }
    const parsed = FleetUsageExportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      await audit('invalid-query');
      return res
        .status(422)
        .json({ error: 'Expected from/to UTC dates spanning at most 31 days', request_id: requestId });
    }
    const tooLarge = async () => {
      await audit('too-large', parsed.data);
      return res.status(413).json({ error: 'Snapshot too large; request fewer days', request_id: requestId });
    };
    let snapshot: FleetUsageExport;
    try {
      snapshot = await readFleetUsageExport(scope, parsed.data);
    } catch (error) {
      if (error instanceof FleetUsageExportTooLargeError) return await tooLarge();
      throw error;
    }
    const body = JSON.stringify(snapshot);
    if (Buffer.byteLength(body, 'utf8') > 4_000_000) {
      return await tooLarge();
    }
    // An export is not released unless its access record has been persisted.
    await audit('allow', parsed.data);
    return res.status(200).json(snapshot);
  } catch {
    console.error('Fleet usage export failed', { requestId });
    return res.status(500).json({ error: 'Usage export unavailable', request_id: requestId });
  }
}
