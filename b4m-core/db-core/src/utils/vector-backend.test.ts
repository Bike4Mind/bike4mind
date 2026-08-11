import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getVectorBackend,
  supportsAtlasVectorSearch,
  selfHostOpenSearchEnabled,
  VectorBackend,
} from './vector-backend';

describe('vector-backend', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.USE_DOCUMENTDB_COMPATIBILITY;
    delete process.env.B4M_SELF_HOST;
    delete process.env.B4M_SELF_HOST_OPENSEARCH;
    delete process.env.OPENSEARCH_ENDPOINT;
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

describe('selfHostOpenSearchEnabled', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.USE_DOCUMENTDB_COMPATIBILITY;
    delete process.env.B4M_SELF_HOST;
    delete process.env.B4M_SELF_HOST_OPENSEARCH;
    delete process.env.OPENSEARCH_ENDPOINT;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('is false on Atlas even if the flag and endpoint are set', () => {
    process.env.B4M_SELF_HOST_OPENSEARCH = 'true';
    process.env.OPENSEARCH_ENDPOINT = 'localhost:9200';
    expect(selfHostOpenSearchEnabled()).toBe(false);
  });

  it('is false on community backend with no flag', () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.OPENSEARCH_ENDPOINT = 'localhost:9200';
    expect(selfHostOpenSearchEnabled()).toBe(false);
  });

  it('is false on community backend with the flag but no endpoint', () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.B4M_SELF_HOST_OPENSEARCH = 'true';
    expect(selfHostOpenSearchEnabled()).toBe(false);
  });

  it('is true only when community backend, the flag, and the endpoint are all set', () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.B4M_SELF_HOST_OPENSEARCH = 'true';
    process.env.OPENSEARCH_ENDPOINT = 'localhost:9200';
    expect(selfHostOpenSearchEnabled()).toBe(true);
  });
});
