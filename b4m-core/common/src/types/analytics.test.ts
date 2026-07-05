import { describe, it, expect } from 'vitest';
import { resolveApiCompletionSource } from './analytics';

describe('resolveApiCompletionSource', () => {
  it('returns "cli" for the b4m-cli User-Agent', () => {
    expect(resolveApiCompletionSource({ 'user-agent': 'b4m-cli/0.9.3' })).toBe('cli');
  });

  it('matches the b4m-cli prefix case-insensitively', () => {
    expect(resolveApiCompletionSource({ 'user-agent': 'B4M-CLI/1.0.0' })).toBe('cli');
  });

  it('returns "api" for any non-CLI User-Agent', () => {
    expect(resolveApiCompletionSource({ 'user-agent': 'curl/8.4.0' })).toBe('api');
    expect(resolveApiCompletionSource({ 'user-agent': 'Mozilla/5.0' })).toBe('api');
  });

  it('returns "api" when User-Agent is missing or empty', () => {
    expect(resolveApiCompletionSource({})).toBe('api');
    expect(resolveApiCompletionSource({ 'user-agent': '' })).toBe('api');
    expect(resolveApiCompletionSource({ 'user-agent': undefined })).toBe('api');
  });

  it('falls back to x-b4m-client when User-Agent is absent', () => {
    expect(resolveApiCompletionSource({ 'x-b4m-client': 'b4m-cli/0.9.3' })).toBe('cli');
  });

  it('looks up headers case-insensitively (HTTP header names are case-insensitive)', () => {
    expect(resolveApiCompletionSource({ 'User-Agent': 'b4m-cli/0.9.3' })).toBe('cli');
    expect(resolveApiCompletionSource({ 'X-B4M-Client': 'b4m-cli/0.9.3' })).toBe('cli');
  });

  it('prefers User-Agent over x-b4m-client when both are present', () => {
    expect(resolveApiCompletionSource({ 'user-agent': 'curl/8.4.0', 'x-b4m-client': 'b4m-cli/0.9.3' })).toBe('api');
  });

  it('rejects substrings that contain but do not start with the CLI prefix', () => {
    expect(resolveApiCompletionSource({ 'user-agent': 'wrapper b4m-cli/0.9.3' })).toBe('api');
  });
});
