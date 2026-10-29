import type { Request, Response, NextFunction } from 'express';
import { ForbiddenError } from '@bike4mind/common';
import { readAdminReturnCookie } from '@bike4mind/server-utils/auth/refreshCookie';

// Explicit reads, not HTTP-method inference: unreviewed routes fail closed in read-only mode.
const READS = [
  /^\/api\/(identify|serverConfig|server-config|config|branding-settings)$/,
  /^\/api\/(modals|organizations)$/,
  /^\/api\/(inbox|invites|projects)$/,
  /^\/api\/(models|entitlements|chat-completion-status)$/,
  /^\/api\/users\/[^/]+\/(userInvites|friend-requests|activities)$/,
  /^\/api\/(gears\/status|models\/stats|help\/recently-viewed)$/,
  /^\/api\/v1\/(video-models|music-models)$/,
  /^\/api\/security\/(user-summary|user-recent|support-access)$/,
  /^\/api\/auth\/impersonation$/,
  /^\/api\/users\/me\/(sessions|storage-breakdown)$/,
  /^\/api\/users\/[^/]+$/,
  /^\/api\/files$/,
  /^\/api\/files\/(search|byIds|[0-9a-f]{24})$/,
  /^\/api\/agents(?:\/[0-9a-f]{24})?$/,
  /^\/api\/sessions(?:\/[0-9a-f]{24})?$/,
  /^\/api\/users\/[^/]+\/organizations?$/,
  /^\/api\/settings\/serverConfig$/,
  /^\/api\/settings\/fetch$/,
  /^\/api\/sessions\/(shared|count|favorites|recent-proactive-messages)$/,
  /^\/api\/sessions\/[0-9a-f]{24}\/(chat(?:\/[0-9a-f]{24})?|agents|files|generated-media)$/,
  /^\/api\/quests\/[0-9a-f]{24}\/context$/,
];

const CONTENT_WRITES = [
  /^\/api\/(files|sessions)$/,
  /^\/api\/(files|sessions)\/[0-9a-f]{24}$/,
  /^\/api\/sessions\/create$/,
  /^\/api\/v1\/sessions(?:\/[0-9a-f]{24}\/clone)?$/,
  /^\/api\/sessions\/[0-9a-f]{24}\/(chat(?:\/[0-9a-f]{24})?|favorite|surface|agents|files)$/,
  /^\/api\/files\/tags\/toggle$/,
];

export function impersonationDecision(
  method: string,
  rawPath: string,
  writeEnabled: boolean
): 'allow' | 'sensitive' | 'readonly' {
  let path: string;
  try {
    path = decodeURIComponent(rawPath.split('?')[0]).replace(/\/+$/, '');
  } catch {
    return 'sensitive';
  }
  if (/^\/api\/auth\/impersonation$/.test(path)) return 'allow';
  if (
    /^\/api\/(auth|oauth|otc|admin|email|stripe|subscriptions|api-keys|user-api-keys|credits|websocket|google-drive|mcp|mcp-connections|mcp-servers|integrations|secret-rotations|cc-bridge|ai|chat|tools|agent-executions|deep-agent)(\/|$)/i.test(
      path
    ) ||
    /^\/api\/users\/[^/]+\/(update|delete|loginAs|revoke-sessions|email-settings)$/i.test(path) ||
    (/^\/api\/users\/me\/sessions(?:\/|$)/.test(path) && !['GET', 'HEAD'].includes(method))
  )
    return 'sensitive';
  if (/^\/api\/agents(?:\/|$)/.test(path) && !['GET', 'HEAD'].includes(method)) return 'sensitive';
  if (method === 'POST' && path === '/api/briefcase/catalog') return 'allow';
  if (writeEnabled && CONTENT_WRITES.some(pattern => pattern.test(path))) return 'allow';
  return ['GET', 'HEAD'].includes(method) && READS.some(pattern => pattern.test(path)) ? 'allow' : 'readonly';
}

export function impersonationGate(req: Request, _res: Response, next: NextFunction) {
  // Declared locally: the `impersonatedBy` augmentation lives in apps/client/global.d.ts, which a
  // program importing this file from outside apps/client does not load.
  const user = req.user as Request['user'] & { impersonatedBy?: string; impersonationWriteEnabled?: boolean };
  if (!user?.impersonatedBy) return next();
  const decision = impersonationDecision(req.method, req.url, !!user.impersonationWriteEnabled);
  if (decision !== 'allow')
    throw new ForbiddenError(
      decision === 'sensitive'
        ? 'This sensitive action is never allowed while viewing as a user. End the support session first.'
        : user.impersonationWriteEnabled
          ? 'This operation is not available during support access. End the support session first.'
          : 'This support session is read-only. Choose Allow changes and provide a reason to make changes.'
    );
  next();
}

export function impersonationAnonymousGate(req: Request, _res: Response, next: NextFunction) {
  if (!readAdminReturnCookie(req)) return next();
  const path = req.url.split('?')[0].replace(/\/+$/, '');
  if (req.method === 'POST' && ['/api/auth/refreshToken', '/api/auth/returnToAdmin'].includes(path)) return next();
  if (
    ['GET', 'HEAD'].includes(req.method) &&
    [
      '/api/settings/serverConfigPublic',
      '/api/settings/serverStatus',
      '/api/settings/logo',
      '/api/ping',
      '/api/health',
      '/api/v1/whats-new',
    ].includes(path)
  )
    return next();
  throw new ForbiddenError('End support access before using this unauthenticated action.');
}
