import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import nc from 'next-connect';
import { ApiErrorSchema } from '@bike4mind/common';

// auth.ts wires every strategy at import time; none of those collaborators are exercised here.
vi.mock('@bike4mind/database', () => ({
  User: { findOne: vi.fn(), updateOne: vi.fn(), create: vi.fn() },
  SamlRequestId: { findOne: vi.fn(), updateOne: vi.fn(), findOneAndDelete: vi.fn() },
  authSessionRepository: { revokeAllByUserId: vi.fn() },
}));
vi.mock('@bike4mind/database/infra', () => ({
  secretRotationRepository: { findBySecretName: vi.fn() },
}));
vi.mock('@server/auth/ability', () => ({ default: vi.fn() }));
vi.mock('@server/utils/config', () => ({
  Config: { GOOGLE_CLIENT_ID: '', GITHUB_CLIENT_ID: '', JWT_SECRET: 'test-secret' },
}));

import { auth } from './auth';

describe('auth middleware: missing credential', () => {
  it('401s with the shared error envelope', async () => {
    const { req, res } = createMocks({ method: 'GET', url: '/api/v1/me' }, { eventEmitter: EventEmitter });
    // any: node-mocks-http mocks aren't structurally the Express types the handler is typed against.
    (req as any).requestId = 'req-1';

    // Mounted under a router with a terminal handler, as baseApi does: next-connect never
    // runs a router on its own whose handlers are all `.use` middleware (it 404s instead).
    const handlerFn = vi.fn();
    const route = nc<any, any>().use(auth).get(handlerFn);

    await route(req as any, res as any);

    expect(handlerFn).not.toHaveBeenCalled();

    expect(res._getStatusCode()).toBe(401);
    const body = res._getJSONData();
    // strict(): an extra key (the old untyped `message`) is exactly the drift being fixed.
    expect(ApiErrorSchema.strict().safeParse(body).success).toBe(true);
    expect(body).toEqual({ error: 'Authentication required', request_id: 'req-1' });
  });
});
