import type { INetworkMeta } from '@bike4mind/common';
import { authEventRepository, User } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { getClientIp, getClientNetwork, type ClientIpRequest } from '@bike4mind/server-utils/utils/ip';
import { DATACENTER_ASNS } from './datacenterAsns';

export type NetworkRequest = ClientIpRequest & {
  headers: Record<string, string | string[] | undefined>;
  logger?: Logger;
};

/**
 * The network a request came from. ASN and country come from CloudFront's viewer headers only;
 * when the distribution does not forward them every derived field is null, never a guess.
 */
export function readNetworkMeta(req: NetworkRequest): INetworkMeta {
  const ip = getClientIp(req);
  const userAgent = req.headers['user-agent'];
  const { asn, country } = getClientNetwork(req);
  return {
    ip: ip === 'unknown' ? null : ip,
    userAgent: (Array.isArray(userAgent) ? userAgent[0] : userAgent) || null,
    asn,
    asnOrg: asn === null ? null : (DATACENTER_ASNS.get(asn) ?? null),
    country,
    isDatacenter: asn === null ? null : DATACENTER_ASNS.has(asn),
  };
}

function warn(req: NetworkRequest, message: string, err: unknown): void {
  const error = err instanceof Error ? err.message : String(err);
  if (req.logger) req.logger.warn(message, { error });
  else console.warn(message, error);
}

/**
 * Stamp the signup's network on the new user (once: a retried handler keeps the first capture) and
 * log a signup AuthEvent. Never throws: losing this metadata must not fail an account creation.
 */
export async function recordSignupNetwork(opts: {
  req: NetworkRequest;
  userId: string;
  method: string;
}): Promise<void> {
  try {
    const meta = readNetworkMeta(opts.req);
    await User.updateOne(
      { _id: opts.userId, signupMeta: null },
      { $set: { signupMeta: { ...meta, capturedAt: new Date() } } }
    );
    await authEventRepository.record({ ...meta, userId: opts.userId, type: 'signup', method: opts.method });
  } catch (err) {
    warn(opts.req, '[auth] signup network metadata not recorded', err);
  }
}

/** Log a login AuthEvent. Never throws: a lost row must not fail the sign-in. */
export async function recordLoginEvent(opts: { req: NetworkRequest; userId: string; method: string }): Promise<void> {
  try {
    await authEventRepository.record({
      ...readNetworkMeta(opts.req),
      userId: opts.userId,
      type: 'login',
      method: opts.method,
    });
  } catch (err) {
    warn(opts.req, '[auth] login event not recorded', err);
  }
}
