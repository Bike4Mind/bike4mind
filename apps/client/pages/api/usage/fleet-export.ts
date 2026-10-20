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

const AUDIT_COUNTER_NAME = 'Fleet Usage Export Access';
const AUDIT_PRINCIPAL = { userId: 'fleet-usage-export', userName: 'Fleet usage export', userLevel: 'service' };
const DENY_AUDIT_WINDOW_MS = 60 * 60 * 1000;

// Anyone can reach the deny path, so denials fold into one row per hour (counterValue is the
// attempt count) rather than one per request, keeping CounterLog growth independent of traffic.
// The row carries only the latest request id, so a caller's id remains traceable without unbounded growth.
async function auditDenial(requestId: string) {
  const windowStart = new Date(Math.floor(Date.now() / DENY_AUDIT_WINDOW_MS) * DENY_AUDIT_WINDOW_MS);
  await CounterLog.updateOne(
    { counterName: AUDIT_COUNTER_NAME, datetime: windowStart, 'metadata.outcome': 'deny' },
    { $inc: { counterValue: 1 }, $set: { 'metadata.lastRequestId': requestId }, $setOnInsert: AUDIT_PRINCIPAL },
    { upsert: true }
  );
}

// Once per cold start, so a provisioned-but-broken stage is visible without logging per request.
let warnedMisconfigured = false;

/** Test hook: the warning is per process, so a suite that asserts it needs a clean slate. */
export function __resetMisconfiguredWarning() {
  warnedMisconfigured = false;
}

// Dedicated machine auth only: sessions and general API keys cannot enter this route.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const requestId = randomUUID();
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('Cache-Control', 'no-store');
  const authorization = authorizeFleetUsageExport(req.headers.authorization, {
    FLEET_USAGE_EXPORT_TOKEN: process.env.FLEET_USAGE_EXPORT_TOKEN,
    FLEET_USAGE_EXPORT_SCOPE: process.env.FLEET_USAGE_EXPORT_SCOPE,
  });
  // An unprovisioned stage answers every method as if the route did not exist, without touching the DB.
  if (authorization.status === 'disabled') {
    if (authorization.misconfigured && !warnedMisconfigured) {
      warnedMisconfigured = true;
      console.error('Fleet usage export is disabled: token or scope configuration is invalid');
    }
    return res.status(404).json({ error: 'Not found', request_id: requestId });
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed', request_id: requestId });
  }
  try {
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE));
    const audit = async (outcome: string, range?: { from: string; to: string }) => {
      await CounterLog.create({
        ...AUDIT_PRINCIPAL,
        counterName: AUDIT_COUNTER_NAME,
        counterValue: 1,
        datetime: new Date(),
        metadata: { requestId, outcome, ...range },
      });
    };
    if (authorization.status === 'denied') {
      await auditDenial(requestId);
      return res.status(401).json({ error: 'Invalid export credential', request_id: requestId });
    }
    const { scope } = authorization;
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
