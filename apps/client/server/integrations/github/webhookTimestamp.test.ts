import { describe, it, expect } from 'vitest';
import { verifyGitHubPayloadTimestamp, GITHUB_REPLAY_TOLERANCE_SECS } from './webhookUtils';

describe('verifyGitHubPayloadTimestamp', () => {
  it('returns fresh:true when no timestamp field exists', () => {
    const result = verifyGitHubPayloadTimestamp({ action: 'ping' });
    expect(result).toEqual({ fresh: true });
  });

  it('detects fresh push event via head_commit.timestamp', () => {
    const result = verifyGitHubPayloadTimestamp({
      head_commit: { timestamp: new Date().toISOString() },
    });
    expect(result).toEqual({ fresh: true, timestampSource: 'head_commit.timestamp' });
  });

  it('detects stale push event via head_commit.timestamp', () => {
    const staleDate = new Date(Date.now() - (GITHUB_REPLAY_TOLERANCE_SECS + 60) * 1000);
    const result = verifyGitHubPayloadTimestamp({
      head_commit: { timestamp: staleDate.toISOString() },
    });
    expect(result.fresh).toBe(false);
    expect(result.timestampSource).toBe('head_commit.timestamp');
  });

  it('detects fresh pull_request via updated_at', () => {
    const result = verifyGitHubPayloadTimestamp({
      pull_request: { updated_at: new Date().toISOString() },
    });
    expect(result).toEqual({ fresh: true, timestampSource: 'pull_request.updated_at' });
  });

  it('detects stale issue via updated_at', () => {
    const staleDate = new Date(Date.now() - (GITHUB_REPLAY_TOLERANCE_SECS + 60) * 1000);
    const result = verifyGitHubPayloadTimestamp({
      issue: { updated_at: staleDate.toISOString() },
    });
    expect(result.fresh).toBe(false);
    expect(result.timestampSource).toBe('issue.updated_at');
  });

  it('prefers head_commit.timestamp over pull_request.updated_at', () => {
    const result = verifyGitHubPayloadTimestamp({
      head_commit: { timestamp: new Date().toISOString() },
      pull_request: { updated_at: new Date().toISOString() },
    });
    expect(result.timestampSource).toBe('head_commit.timestamp');
  });

  it('skips non-string timestamps gracefully', () => {
    const result = verifyGitHubPayloadTimestamp({
      head_commit: { timestamp: 12345 }, // number, not string
    });
    expect(result).toEqual({ fresh: true }); // no verifiable timestamp found
  });

  it('skips invalid date strings gracefully', () => {
    const result = verifyGitHubPayloadTimestamp({
      head_commit: { timestamp: 'not-a-date' },
    });
    expect(result).toEqual({ fresh: true }); // NaN parsed, skipped
  });

  it('detects fresh release via updated_at', () => {
    const result = verifyGitHubPayloadTimestamp({
      release: { updated_at: new Date().toISOString() },
    });
    expect(result).toEqual({ fresh: true, timestampSource: 'release.updated_at' });
  });

  it('detects fresh discussion via updated_at', () => {
    const result = verifyGitHubPayloadTimestamp({
      discussion: { updated_at: new Date().toISOString() },
    });
    expect(result).toEqual({ fresh: true, timestampSource: 'discussion.updated_at' });
  });

  it('respects custom tolerance parameter', () => {
    // 10 seconds ago
    const ts = new Date(Date.now() - 10_000).toISOString();
    // 5 second tolerance - should be stale
    expect(verifyGitHubPayloadTimestamp({ head_commit: { timestamp: ts } }, 5).fresh).toBe(false);
    // 30 second tolerance - should be fresh
    expect(verifyGitHubPayloadTimestamp({ head_commit: { timestamp: ts } }, 30).fresh).toBe(true);
  });
});
