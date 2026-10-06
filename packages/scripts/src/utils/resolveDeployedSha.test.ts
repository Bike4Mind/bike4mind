import { describe, it, expect } from 'vitest';
import { resolveDeployedSha } from './resolveDeployedSha';

const VALID_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9011121314';

describe('resolveDeployedSha', () => {
  it('accepts a valid lowercase 40-character SHA', () => {
    expect(resolveDeployedSha(VALID_SHA, { dryRun: false })).toBe(VALID_SHA);
  });

  it('normalizes an uppercase SHA to lowercase', () => {
    expect(resolveDeployedSha(VALID_SHA.toUpperCase(), { dryRun: false })).toBe(VALID_SHA);
  });

  it('allows HEAD during a dry run', () => {
    expect(resolveDeployedSha('HEAD', { dryRun: true })).toBe('HEAD');
  });

  it('allows an undefined input during a dry run', () => {
    expect(resolveDeployedSha(undefined, { dryRun: true })).toBe('HEAD');
  });

  it('rejects HEAD for a real run', () => {
    expect(() => resolveDeployedSha('HEAD', { dryRun: false })).toThrow(/required for a real run/);
  });

  it('rejects an empty input for a real run', () => {
    expect(() => resolveDeployedSha('', { dryRun: false })).toThrow(/required for a real run/);
  });

  it('rejects a garbage value', () => {
    expect(() => resolveDeployedSha('not-a-sha', { dryRun: false })).toThrow(/must be a 40-character commit SHA/);
  });

  it('rejects a garbage value even during a dry run', () => {
    expect(() => resolveDeployedSha('not-a-sha', { dryRun: true })).toThrow(/must be a 40-character commit SHA/);
  });
});
