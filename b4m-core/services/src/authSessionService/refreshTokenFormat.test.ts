import { describe, it, expect } from 'vitest';
import {
  buildRefreshToken,
  generateRefreshSecret,
  hashRefreshSecret,
  isOpaqueRefreshToken,
  parseRefreshToken,
} from './refreshTokenFormat';

describe('refreshTokenFormat', () => {
  it('generates distinct, URL-safe, dot-free secrets', () => {
    const a = generateRefreshSecret();
    const b = generateRefreshSecret();
    expect(a).not.toEqual(b);
    expect(a).not.toContain('.');
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashes deterministically and differs per secret', () => {
    const secret = generateRefreshSecret();
    expect(hashRefreshSecret(secret)).toEqual(hashRefreshSecret(secret));
    expect(hashRefreshSecret(secret)).not.toEqual(hashRefreshSecret(generateRefreshSecret()));
    // sha256 hex is 64 chars, and never the raw secret
    expect(hashRefreshSecret(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshSecret(secret)).not.toEqual(secret);
  });

  it('round-trips build -> parse', () => {
    const sid = 'a1b2c3';
    const secret = generateRefreshSecret();
    const token = buildRefreshToken(sid, secret);
    expect(token).toBe(`${sid}.${secret}`);
    expect(parseRefreshToken(token)).toEqual({ sid, secret });
  });

  it('distinguishes opaque (2 parts) from legacy JWT (3 parts)', () => {
    expect(isOpaqueRefreshToken('sid.secret')).toBe(true);
    expect(isOpaqueRefreshToken('header.payload.signature')).toBe(false); // legacy JWT
    expect(isOpaqueRefreshToken('nodot')).toBe(false);
    expect(isOpaqueRefreshToken('sid.')).toBe(false); // empty secret
    expect(isOpaqueRefreshToken('.secret')).toBe(false); // empty sid
    expect(parseRefreshToken('header.payload.signature')).toBeNull();
  });
});
