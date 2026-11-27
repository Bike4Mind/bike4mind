import { describe, expect, it } from 'vitest';
import { resolveRequestUsageSource } from './resolveRequestUsageSource';

describe('resolveRequestUsageSource', () => {
  it('classifies the b4m CLI as cli', () => {
    expect(resolveRequestUsageSource({ headers: { 'user-agent': 'b4m-cli/0.9.3' } })).toBe('cli');
  });

  it('classifies any other client as api', () => {
    expect(resolveRequestUsageSource({ headers: { 'user-agent': 'curl/8.4.0' } })).toBe('api');
    expect(resolveRequestUsageSource({ headers: {} })).toBe('api');
  });
});
