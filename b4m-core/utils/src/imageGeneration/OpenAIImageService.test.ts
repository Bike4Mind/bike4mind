import { describe, it, expect } from 'vitest';
import OpenAI from 'openai';
import { buildModerationBlockedError } from './OpenAIImageService';

// The helper only reads `code`, `status`, and `requestID` off the error, so a
// minimal object cast to the APIError instance type is sufficient and avoids
// fragile coupling to the SDK's constructor signature.
type APIErrorLike = InstanceType<typeof OpenAI.APIError>;
function makeApiError(props: Partial<{ status: number; code: string | null; requestID: string }>): APIErrorLike {
  return props as unknown as APIErrorLike;
}

describe('buildModerationBlockedError', () => {
  it('returns a friendly error for an explicit moderation_blocked code (#9251)', () => {
    const result = buildModerationBlockedError(makeApiError({ status: 400, code: 'moderation_blocked' }));

    expect(result).toBeInstanceOf(Error);
    expect(result?.message).toContain("blocked by OpenAI's content policy");
  });

  it("returns a friendly error for DALL-E 3's content_policy_violation code", () => {
    // DALL-E 3 (generation-only) rejects policy violations with a non-empty code
    // that is not `moderation_blocked` - it must still get the friendly message.
    const result = buildModerationBlockedError(makeApiError({ status: 400, code: 'content_policy_violation' }));

    expect(result).toBeInstanceOf(Error);
    expect(result?.message).toContain("blocked by OpenAI's content policy");
  });

  it('guides the user toward alternative models with different content policies', () => {
    const result = buildModerationBlockedError(makeApiError({ status: 400, code: 'moderation_blocked' }));

    expect(result?.message).toContain('Flux Pro');
    expect(result?.message).toMatch(/alternative model/i);
  });

  it('includes the OpenAI request ID when present so users can report false positives', () => {
    const result = buildModerationBlockedError(
      makeApiError({ status: 400, code: 'moderation_blocked', requestID: 'req_abc123' })
    );

    expect(result?.message).toContain('req_abc123');
  });

  it('falls back to "unknown" request ID when none is provided', () => {
    const result = buildModerationBlockedError(makeApiError({ status: 400, code: 'moderation_blocked' }));

    expect(result?.message).toContain('request ID: unknown');
  });

  it('treats a bare 400 with no code as a likely moderation block', () => {
    const result = buildModerationBlockedError(makeApiError({ status: 400 }));

    expect(result).toBeInstanceOf(Error);
    expect(result?.message).toContain("blocked by OpenAI's content policy");
  });

  it('does NOT mislabel a 400 carrying a specific parameter error code as moderation', () => {
    const result = buildModerationBlockedError(makeApiError({ status: 400, code: 'invalid_size' }));

    expect(result).toBeNull();
  });

  it('returns null for non-400 errors (e.g. rate limits, server errors)', () => {
    expect(buildModerationBlockedError(makeApiError({ status: 429, code: 'rate_limit_exceeded' }))).toBeNull();
    expect(buildModerationBlockedError(makeApiError({ status: 500 }))).toBeNull();
  });
});
