// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import { SCOPE_STAGING_ENV_VAR } from '@server/middlewares/apiKeyScopeGate';
import {
  PROJECTS_READ_OR_WRITE_SCOPES,
  PROJECTS_READ_SCOPES,
  PROJECTS_WRITE_SCOPES,
  assertProjectsReadScope,
  assertProjectsWriteScope,
} from './projectScopes';

const key = (...scopes: ApiKeyScope[]) => ({ apiKeyInfo: { scopes } });

beforeEach(() => {
  delete process.env[SCOPE_STAGING_ENV_VAR];
});

afterEach(() => {
  delete process.env[SCOPE_STAGING_ENV_VAR];
});

describe('projects API-key scopes', () => {
  it('never lists admin:* in a gate', () => {
    // admin:* is unstageable, so one mention would leave the family with no grace period.
    expect([...PROJECTS_READ_SCOPES, ...PROJECTS_WRITE_SCOPES, ...PROJECTS_READ_OR_WRITE_SCOPES]).not.toContain(
      ApiKeyScope.ADMIN
    );
  });

  it('does not let a write key read or a read key write', () => {
    expect(() => assertProjectsReadScope(key(ApiKeyScope.WRITE_PROJECTS))).toThrow('projects:read is required');
    expect(() => assertProjectsWriteScope(key(ApiKeyScope.READ_PROJECTS))).toThrow('projects:write is required');
    expect(() => assertProjectsReadScope(key(ApiKeyScope.READ_PROJECTS))).not.toThrow();
    expect(() => assertProjectsWriteScope(key(ApiKeyScope.WRITE_PROJECTS))).not.toThrow();
  });

  it('leaves JWT/browser callers alone', () => {
    expect(() => assertProjectsReadScope({})).not.toThrow();
    expect(() => assertProjectsWriteScope({})).not.toThrow();
  });

  it('denies a key caller whose scopes came back undefined, rather than failing open', () => {
    expect(() => assertProjectsWriteScope({ apiKeyInfo: {} })).toThrow();
  });

  it('honors staging, so the grace period covers the per-method asserts too', () => {
    process.env[SCOPE_STAGING_ENV_VAR] = 'projects:read,projects:write';
    expect(() => assertProjectsWriteScope(key(ApiKeyScope.READ_FILES))).not.toThrow();
    expect(() => assertProjectsReadScope(key())).not.toThrow();
  });
});
