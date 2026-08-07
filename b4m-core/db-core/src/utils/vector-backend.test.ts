import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getVectorBackend, supportsAtlasVectorSearch, VectorBackend } from './vector-backend';

describe('vector-backend', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.USE_DOCUMENTDB_COMPATIBILITY;
    delete process.env.B4M_SELF_HOST;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('defaults to atlas when neither flag is set', () => {
    expect(getVectorBackend()).toBe(VectorBackend.ATLAS);
    expect(supportsAtlasVectorSearch()).toBe(true);
  });

  it('resolves to documentdb when USE_DOCUMENTDB_COMPATIBILITY is true', () => {
    process.env.USE_DOCUMENTDB_COMPATIBILITY = 'true';
    expect(getVectorBackend()).toBe(VectorBackend.DOCUMENTDB);
    expect(supportsAtlasVectorSearch()).toBe(false);
  });

  it('resolves to community when B4M_SELF_HOST is true', () => {
    process.env.B4M_SELF_HOST = 'true';
    expect(getVectorBackend()).toBe(VectorBackend.COMMUNITY);
    expect(supportsAtlasVectorSearch()).toBe(false);
  });

  it('documentdb compat takes precedence over self-host', () => {
    process.env.USE_DOCUMENTDB_COMPATIBILITY = 'true';
    process.env.B4M_SELF_HOST = 'true';
    expect(getVectorBackend()).toBe(VectorBackend.DOCUMENTDB);
  });
});
