// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import { SCOPE_STAGING_ENV_VAR } from '@server/middlewares/apiKeyScopeGate';
import {
  AGENTS_READ_OR_WRITE_SCOPES,
  AGENTS_READ_SCOPES,
  AGENTS_WRITE_SCOPES,
  assertAgentsReadScope,
  assertAgentsWriteScope,
} from './agentScopes';

const key = (...scopes: ApiKeyScope[]) => ({ apiKeyInfo: { scopes } });

beforeEach(() => {
  delete process.env[SCOPE_STAGING_ENV_VAR];
});

afterEach(() => {
  delete process.env[SCOPE_STAGING_ENV_VAR];
});

describe('agents API-key scopes', () => {
  it('never lists admin:* in a gate', () => {
    // admin:* is unstageable, so one mention would leave the family with no grace period.
    expect([...AGENTS_READ_SCOPES, ...AGENTS_WRITE_SCOPES, ...AGENTS_READ_OR_WRITE_SCOPES]).not.toContain(
      ApiKeyScope.ADMIN
    );
  });

  it('does not let a write key read or a read key write', () => {
    expect(() => assertAgentsReadScope(key(ApiKeyScope.WRITE_AGENTS))).toThrow('agents:read is required');
    expect(() => assertAgentsWriteScope(key(ApiKeyScope.READ_AGENTS))).toThrow('agents:write is required');
    expect(() => assertAgentsReadScope(key(ApiKeyScope.READ_AGENTS))).not.toThrow();
    expect(() => assertAgentsWriteScope(key(ApiKeyScope.WRITE_AGENTS))).not.toThrow();
  });

  it('leaves JWT/browser callers alone', () => {
    expect(() => assertAgentsReadScope({})).not.toThrow();
    expect(() => assertAgentsWriteScope({})).not.toThrow();
  });

  it('denies a key caller whose scopes came back undefined, rather than failing open', () => {
    expect(() => assertAgentsWriteScope({ apiKeyInfo: {} })).toThrow();
  });

  it('honors staging, so the grace period covers the per-method asserts too', () => {
    process.env[SCOPE_STAGING_ENV_VAR] = 'agents:read,agents:write';
    expect(() => assertAgentsWriteScope(key(ApiKeyScope.READ_FILES))).not.toThrow();
    expect(() => assertAgentsReadScope(key())).not.toThrow();
  });
});
