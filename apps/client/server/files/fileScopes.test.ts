// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import { SCOPE_STAGING_ENV_VAR } from '@server/middlewares/apiKeyScopeGate';
import {
  FILES_READ_OR_WRITE_SCOPES,
  FILES_READ_SCOPES,
  FILES_WRITE_SCOPES,
  assertFilesReadScope,
  assertFilesWriteScope,
} from './fileScopes';

const key = (...scopes: ApiKeyScope[]) => ({ apiKeyInfo: { scopes } });

beforeEach(() => {
  delete process.env[SCOPE_STAGING_ENV_VAR];
});

afterEach(() => {
  delete process.env[SCOPE_STAGING_ENV_VAR];
});

describe('files API-key scopes', () => {
  it('never lists admin:* in a gate', () => {
    // admin:* is unstageable, so one mention would leave the family with no grace period.
    expect([...FILES_READ_SCOPES, ...FILES_WRITE_SCOPES, ...FILES_READ_OR_WRITE_SCOPES]).not.toContain(
      ApiKeyScope.ADMIN
    );
  });

  it('does not let a write key read or a read key write, matching the public files contracts', () => {
    expect(() => assertFilesReadScope(key(ApiKeyScope.WRITE_FILES))).toThrow('files:read is required');
    expect(() => assertFilesWriteScope(key(ApiKeyScope.READ_FILES))).toThrow('files:write is required');
    expect(() => assertFilesReadScope(key(ApiKeyScope.READ_FILES))).not.toThrow();
    expect(() => assertFilesWriteScope(key(ApiKeyScope.WRITE_FILES))).not.toThrow();
  });

  it('leaves JWT/browser callers alone', () => {
    expect(() => assertFilesReadScope({})).not.toThrow();
    expect(() => assertFilesWriteScope({})).not.toThrow();
  });

  it('denies a key caller whose scopes came back undefined, rather than failing open', () => {
    expect(() => assertFilesWriteScope({ apiKeyInfo: {} })).toThrow();
  });

  it('honors staging, so the grace period covers the per-method asserts too', () => {
    process.env[SCOPE_STAGING_ENV_VAR] = 'files:read,files:write';
    expect(() => assertFilesWriteScope(key(ApiKeyScope.DATALAKE_READ))).not.toThrow();
    expect(() => assertFilesReadScope(key())).not.toThrow();
  });
});
