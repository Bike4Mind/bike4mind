import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Request, Response } from 'express';

const calls = vi.hoisted(() => ({ session: vi.fn(), legacy: vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options?: { auth?: string }) => {
    const execute = (req: unknown, res: unknown) =>
      (options?.auth === 'jwtOnly' ? calls.session : calls.legacy)(req, res);
    const chain = Object.assign(execute, { post: () => chain, get: () => chain });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: <T>(handler: T) => handler }));
vi.mock('@bike4mind/database', () => ({ withTransaction: vi.fn() }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: {} }));
vi.mock('@bike4mind/database/social', () => ({ groupRepository: {} }));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: {} }));
vi.mock('@bike4mind/services', () => ({
  organizationService: { createStandardGroup: vi.fn(), listOrganizationGroups: vi.fn() },
}));
vi.mock('@bike4mind/server-utils/utils/organizationAudit', () => ({ recordOrganizationAuditEvent: vi.fn() }));
import handler from '../index';

beforeEach(() => {
  vi.clearAllMocks();
});
describe('group creation authentication dispatch', () => {
  it.each(['POST', 'post'])('chooses the session-only chain for %s before any API-key chain', method => {
    const { req, res } = createMocks<Request, Response>({
      method,
      headers: { authorization: 'Bearer b4m_live_fixture' },
    });
    handler(req, res);
    expect(calls.session).toHaveBeenCalledExactlyOnceWith(req, res);
    expect(calls.legacy).not.toHaveBeenCalled();
  });
  it.each(['GET', 'HEAD'])('keeps legacy read authentication for %s', method => {
    const { req, res } = createMocks<Request, Response>({ method });
    handler(req, res);
    expect(calls.legacy).toHaveBeenCalledExactlyOnceWith(req, res);
    expect(calls.session).not.toHaveBeenCalled();
  });
});
