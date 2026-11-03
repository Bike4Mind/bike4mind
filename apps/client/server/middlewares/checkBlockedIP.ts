import { blockedIPRepository, type IBlockedIPDocument } from '@bike4mind/database';
import { escapeSlackText, ipBlockContains, type IpBlockSurface } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { RequestHandler } from 'express';
import { getClientIp, type ClientIpRequest } from '@bike4mind/server-utils/utils/ip';
import { emitMetric } from '@bike4mind/server-utils/utils/cloudwatch';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { alertFraudBlock } from '@server/billing/fraudBlockAlert';

/** Shown for a failed-login lockout (scope `login`). */
export const LOGIN_LOCKOUT_MESSAGE =
  'Your IP address has been temporarily blocked due to repeated failed login attempts. Please try again after the block expires or contact support if you believe this is an error.';

/** Shown for an admin's `all` block. Neutral on purpose: it must not tell a fraudster what tripped it. */
export const NETWORK_BLOCKED_MESSAGE =
  "We can't complete this request from your network. Please contact support if you believe this is an error.";

const ACTIVE_ALL_BLOCKS_TTL_MS = 30_000;

let activeAllBlocks: { loadedAt: number; blocks: IBlockedIPDocument[] } | null = null;

/** Test seam: forget the cached `all` blocks so the next lookup reads the database. */
export function resetIpBlockCache(): void {
  activeAllBlocks = null;
}

/**
 * `app` surfaces sit on hot paths (every authenticated write, every completion), so they match
 * against the active `all` blocks cached per container for 30s instead of querying per request.
 * A new block or an unblock therefore takes up to 30s to reach every container.
 */
async function cachedAllBlocks(): Promise<IBlockedIPDocument[]> {
  const now = Date.now();
  if (!activeAllBlocks || now - activeAllBlocks.loadedAt > ACTIVE_ALL_BLOCKS_TTL_MS) {
    activeAllBlocks = { loadedAt: now, blocks: await blockedIPRepository.listActiveAllScope() };
  }
  return activeAllBlocks.blocks;
}

/**
 * The block refusing this address on this surface, or null. A `login` surface reads the database
 * directly (low volume, and an automatic lockout must apply at once); see IpBlockSurface.
 */
export async function findIpBlock(ip: string, surface: IpBlockSurface): Promise<IBlockedIPDocument | null> {
  if (surface === 'login') return blockedIPRepository.isBlocked(ip, 'login');
  const now = new Date();
  const blocks = await cachedAllBlocks();
  return blocks.find(block => block.expiresAt > now && ipBlockContains(block, ip)) ?? null;
}

export type IpBlockRefusal = { message: string; scope: 'login' | 'all'; expiresAt: Date };

/**
 * Whether a request from this address must be refused on this surface. Fails open: a broken check
 * must not take sign-in or checkout down, so the failure is logged at error level and counted
 * (Lumina5/Security IpBlockCheckFailed) for an alarm to catch instead.
 */
export async function ipBlockRefusal(
  request: ClientIpRequest & { user?: { id: string } | null },
  surface: IpBlockSurface,
  logger?: Logger
): Promise<IpBlockRefusal | null> {
  const ip = getClientIp(request);
  let block: IBlockedIPDocument | null;
  try {
    block = await findIpBlock(ip, surface);
  } catch (error) {
    logger?.error('[IpBlock] blocked-IP check failed; allowing the request', {
      surface,
      error: error instanceof Error ? error.message : String(error),
    });
    await emitMetric('Lumina5/Security', 'IpBlockCheckFailed', 1, { Surface: surface }, StandardUnit.Count);
    return null;
  }
  if (!block) return null;
  const scope = block.scope ?? 'login';
  // A failed-login lockout is routine; only an admin's network block is a fraud block worth a post.
  if (scope === 'all') {
    await alertFraudBlock({
      kind: 'ipBlocked',
      userId: request.user?.id ?? null,
      ip,
      details: [`*IP:* \`${escapeSlackText(ip)}\` (${surface} surface)`],
    });
  }
  return {
    message: scope === 'all' ? NETWORK_BLOCKED_MESSAGE : LOGIN_LOCKOUT_MESSAGE,
    scope,
    expiresAt: block.expiresAt,
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type CheckBlockedIPOptions = {
  surface?: IpBlockSurface;
  /** Let reads through, so a caller caught by a block still loads the app and sees the refusal on a write. */
  writesOnly?: boolean;
  /** Let admins through, so a range that happens to cover an admin's network cannot lock the admin console. */
  exemptAdmins?: boolean;
};

/**
 * Refuses a request from a blocked IP: a browser navigation is redirected to the login page with an
 * error code, an API call gets a 403 JSON. A login lockout keeps its reason and expiry in the body;
 * an `all` block says nothing beyond the neutral message.
 */
export const checkBlockedIP = ({
  surface = 'login',
  writesOnly = false,
  exemptAdmins = false,
}: CheckBlockedIPOptions = {}): RequestHandler => {
  return async (req, res, next) => {
    if (writesOnly && SAFE_METHODS.has(req.method?.toUpperCase() ?? 'GET')) return next();
    if (exemptAdmins && req.user?.isAdmin) return next();
    const refusal = await ipBlockRefusal(req, surface, req.logger);
    if (!refusal) return next();

    req.logger?.warn('[IpBlock] request refused', { surface, scope: refusal.scope });
    // Use req.path if available, otherwise parse from req.url
    const path = req.path || (req.url ? req.url.split('?')[0] : '');
    const isApiRequest = path.startsWith('/api/') && req.headers.accept?.includes('application/json');

    if (surface === 'login' && !isApiRequest) {
      return res.redirect(`/login?error=${refusal.scope === 'all' ? 'network_blocked' : 'ip_blocked'}`);
    }
    return res.status(403).json({
      error: refusal.message,
      blocked: true,
      ...(refusal.scope === 'login' ? { expiresAt: refusal.expiresAt } : {}),
      request_id: req.requestId,
    });
  };
};
