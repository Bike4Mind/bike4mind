import { recordSideAppRefusal } from '@bike4mind/server-utils/auth/sideAppRefusal';
import { resolveRouteTemplate } from '@bike4mind/server-utils/utils/resolveRouteTemplate';
import type { Request, Response } from 'express';

/**
 * Refuses a connected-app (OAuth exchange) key on a route outside its pinned inventory.
 * Returns true when it refused, so the handler must stop; records the refusal like the door does.
 */
export function refuseExchangeKey(
  req: Pick<Request, 'originalUrl' | 'url' | 'query'> & {
    apiKeyInfo?: { keyId?: string; oauthExchangeClientId?: string };
    user?: { id?: unknown };
  },
  res: Response
): boolean {
  const info = req.apiKeyInfo;
  if (!info?.oauthExchangeClientId) return false;
  recordSideAppRefusal({
    verified: true,
    clientId: info.oauthExchangeClientId,
    stage: 'use',
    reason: 'route_not_allowed',
    status: 403,
    userId: req.user?.id ? String(req.user.id) : undefined,
    keyId: info.keyId,
    endpoint: resolveRouteTemplate(req),
  });
  res.status(403).json({ error: 'Keys minted for a connected app cannot call this route' });
  return true;
}
