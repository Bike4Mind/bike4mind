import { describe, it, expect, afterEach } from 'vitest';
import { resolveClientType } from './seed-oauth-client';

const priorClientType = process.env.CLIENT_TYPE;

afterEach(() => {
  if (priorClientType === undefined) delete process.env.CLIENT_TYPE;
  else process.env.CLIENT_TYPE = priorClientType;
});

describe('resolveClientType', () => {
  it('defaults an unclassified registration to the non-privileged relying-party class', () => {
    delete process.env.CLIENT_TYPE;
    expect(resolveClientType()).toBe('relying-party');
  });

  it('allows an explicit first-party opt-in', () => {
    process.env.CLIENT_TYPE = 'first-party';
    expect(resolveClientType()).toBe('first-party');
  });

  it('rejects an unknown value rather than silently trusting it', () => {
    process.env.CLIENT_TYPE = 'privileged';
    expect(() => resolveClientType()).toThrow(/CLIENT_TYPE/);
  });
});
