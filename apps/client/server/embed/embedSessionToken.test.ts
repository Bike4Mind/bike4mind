import { describe, it, expect, vi } from 'vitest';

vi.mock('@server/utils/config', () => ({
  Config: { JWT_SECRET: 'test-secret' },
}));

import jwt from 'jsonwebtoken';
import {
  signEmbedSessionToken,
  verifyEmbedSessionToken,
  EmbedSessionContext,
  EMBED_SESSION_TTL_SECONDS,
} from './embedSessionToken';

const ctx: EmbedSessionContext = {
  keyId: 'key-1',
  agentId: 'agent-1',
  organizationId: 'org-1',
  sessionId: 'sess-1',
};

describe('embedSessionToken', () => {
  it('round-trips the claims through sign then verify', () => {
    const token = signEmbedSessionToken(ctx, EMBED_SESSION_TTL_SECONDS);
    const decoded = verifyEmbedSessionToken(token);
    expect(decoded).toMatchObject(ctx);
  });

  it('rejects a token signed for a different audience (no cross-endpoint replay)', () => {
    const token = jwt.sign(ctx, 'test-secret', { audience: 'voice-v2-llm-proxy', expiresIn: 300 });
    expect(() => verifyEmbedSessionToken(token)).toThrow();
  });

  it('rejects an expired token', () => {
    const token = signEmbedSessionToken(ctx, -1);
    expect(() => verifyEmbedSessionToken(token)).toThrow(jwt.TokenExpiredError);
  });

  it('rejects a token signed with the wrong secret', () => {
    const token = jwt.sign(ctx, 'wrong-secret', { audience: 'embed-chat', expiresIn: 300 });
    expect(() => verifyEmbedSessionToken(token)).toThrow(jwt.JsonWebTokenError);
  });

  it('rejects a well-signed token whose claim shape is invalid', () => {
    const token = jwt.sign({ keyId: 'key-1' }, 'test-secret', { audience: 'embed-chat', expiresIn: 300 });
    expect(() => verifyEmbedSessionToken(token)).toThrow();
  });
});
