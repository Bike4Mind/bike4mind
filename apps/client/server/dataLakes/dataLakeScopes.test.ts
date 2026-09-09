// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import { SCOPE_STAGING_ENV_VAR } from '@server/middlewares/apiKeyScopeGate';
import {
  DATA_LAKE_READ_SCOPES,
  DATA_LAKE_READ_OR_SHARE_SCOPES,
  DATA_LAKE_SHARE_SCOPES,
  DATA_LAKE_WRITE_SCOPES,
  assertDataLakeShareScope,
  assertDataLakeWriteScope,
} from './dataLakeScopes';

const key = (...scopes: ApiKeyScope[]) => ({ apiKeyInfo: { scopes } });

afterEach(() => {
  delete process.env[SCOPE_STAGING_ENV_VAR];
});

describe('data-lake API-key scopes', () => {
  it('never lists admin:* in a gate', () => {
    // A route is in its staging grace period only while EVERY scope it accepts is
    // staged, and admin:* is unstageable - one mention here would leave this whole
    // family with no grace period and 403 every key in circulation on deploy.
    const all = [
      ...DATA_LAKE_READ_SCOPES,
      ...DATA_LAKE_WRITE_SCOPES,
      ...DATA_LAKE_SHARE_SCOPES,
      ...DATA_LAKE_READ_OR_SHARE_SCOPES,
    ];
    expect(all).not.toContain(ApiKeyScope.ADMIN);
  });

  it('lets a write key read, but does not let a read key write', () => {
    expect(DATA_LAKE_READ_SCOPES).toContain(ApiKeyScope.DATALAKE_WRITE);
    expect(() => assertDataLakeWriteScope(key(ApiKeyScope.DATALAKE_WRITE))).not.toThrow();
    expect(() => assertDataLakeWriteScope(key(ApiKeyScope.DATALAKE_READ))).toThrow(/datalake:write/);
  });

  it('does not let a write key re-share a lake', () => {
    expect(() => assertDataLakeShareScope(key(ApiKeyScope.DATALAKE_SHARE))).not.toThrow();
    expect(() => assertDataLakeShareScope(key(ApiKeyScope.DATALAKE_WRITE))).toThrow(/datalake:share/);
  });

  it('leaves JWT/browser callers alone', () => {
    expect(() => assertDataLakeWriteScope({})).not.toThrow();
    expect(() => assertDataLakeShareScope({})).not.toThrow();
  });

  it('honors staging, so the grace period covers the per-method asserts too', () => {
    process.env[SCOPE_STAGING_ENV_VAR] = ApiKeyScope.DATALAKE_WRITE;
    expect(() => assertDataLakeWriteScope(key(ApiKeyScope.AI_CHAT))).not.toThrow();
    expect(() => assertDataLakeShareScope(key(ApiKeyScope.AI_CHAT))).toThrow();
  });
});
