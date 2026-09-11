// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApiKeyScope, type IDataLakeDocument } from '@bike4mind/common';
import { SCOPE_STAGING_ENV_VAR } from '@server/middlewares/apiKeyScopeGate';
import {
  DATA_LAKE_READ_SCOPES,
  DATA_LAKE_READ_OR_SHARE_SCOPES,
  DATA_LAKE_SHARE_SCOPES,
  DATA_LAKE_WRITE_SCOPES,
  DATA_LAKE_QUERY_SCOPES,
  assertDataLakeShareScope,
  assertDataLakeWriteScope,
  assertDataLakeTagWriteScope,
} from './dataLakeScopes';

const key = (...scopes: ApiKeyScope[]) => ({ apiKeyInfo: { scopes } });

// Cleared both before and after: the ambient environment (e.g. a real deploy-shaped
// API_KEY_SCOPE_STAGING loaded via .env) must not leak into the first test either.
beforeEach(() => {
  delete process.env[SCOPE_STAGING_ENV_VAR];
});

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
      ...DATA_LAKE_QUERY_SCOPES,
    ];
    expect(all).not.toContain(ApiKeyScope.ADMIN);
  });

  it('lets a write key read, but does not let a read key write', () => {
    expect(DATA_LAKE_READ_SCOPES).toContain(ApiKeyScope.DATALAKE_WRITE);
    expect(() => assertDataLakeWriteScope(key(ApiKeyScope.DATALAKE_WRITE))).not.toThrow();
    expect(() => assertDataLakeWriteScope(key(ApiKeyScope.DATALAKE_READ))).toThrow(/datalake:write/);
  });

  it('lets a query key reach the read-gated routes it calls back into, but not the reverse', () => {
    expect(DATA_LAKE_READ_SCOPES).toContain(ApiKeyScope.DATALAKE_QUERY);
    expect(DATA_LAKE_QUERY_SCOPES).not.toContain(ApiKeyScope.DATALAKE_READ);
    expect(DATA_LAKE_QUERY_SCOPES).not.toContain(ApiKeyScope.DATALAKE_WRITE);
  });

  it('gates a lake-membership tag write only when the tag list actually reaches into a lake', async () => {
    await expect(assertDataLakeTagWriteScope(key(ApiKeyScope.DATALAKE_READ), ['datalake:some-lake'])).rejects.toThrow(
      /datalake:write/
    );
    await expect(
      assertDataLakeTagWriteScope(key(ApiKeyScope.DATALAKE_WRITE), ['datalake:some-lake'])
    ).resolves.not.toThrow();
    await expect(assertDataLakeTagWriteScope(key(ApiKeyScope.DATALAKE_READ), ['plain-tag'])).resolves.not.toThrow();
  });

  describe('the prefix-arm signal for a new file', () => {
    const lake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
      ({
        id: 'lake1',
        name: 'Lake',
        slug: 'lake',
        datalakeTag: 'datalake:lake',
        fileTagPrefix: 'proj:',
        createdByUserId: 'user1',
        status: 'active',
        ...overrides,
      }) as IDataLakeDocument;

    const dbWith = (lakes: IDataLakeDocument[]) => ({ dataLakes: { find: async () => lakes } });

    it("requires datalake:write when a plain tag matches the caller's own lake prefix", async () => {
      const newFile = { userId: 'user1', db: dbWith([lake()]) };
      await expect(
        assertDataLakeTagWriteScope(key(ApiKeyScope.DATALAKE_READ), ['proj:invoice'], newFile)
      ).rejects.toThrow(/datalake:write/);
      await expect(
        assertDataLakeTagWriteScope(key(ApiKeyScope.DATALAKE_WRITE), ['proj:invoice'], newFile)
      ).resolves.not.toThrow();
    });

    it('leaves a tag alone when it matches no lake the caller owns', async () => {
      const newFile = { userId: 'user1', db: dbWith([lake({ createdByUserId: 'someone-else' })]) };
      await expect(
        assertDataLakeTagWriteScope(key(ApiKeyScope.DATALAKE_READ), ['proj:invoice'], newFile)
      ).resolves.not.toThrow();
    });

    it('skips the candidate-lake query entirely when no tag could carry a prefix arm', async () => {
      const find = async () => {
        throw new Error('should not query candidate lakes for a colon-free tag set');
      };
      const newFile = { userId: 'user1', db: { dataLakes: { find } } };
      await expect(
        assertDataLakeTagWriteScope(key(ApiKeyScope.DATALAKE_READ), ['plain-tag'], newFile)
      ).resolves.not.toThrow();
    });
  });

  it('does not let a write key re-share a lake', () => {
    expect(() => assertDataLakeShareScope(key(ApiKeyScope.DATALAKE_SHARE))).not.toThrow();
    expect(() => assertDataLakeShareScope(key(ApiKeyScope.DATALAKE_WRITE))).toThrow(/datalake:share/);
  });

  it('leaves JWT/browser callers alone', () => {
    expect(() => assertDataLakeWriteScope({})).not.toThrow();
    expect(() => assertDataLakeShareScope({})).not.toThrow();
  });

  it('denies a key caller whose scopes came back undefined or empty, rather than failing open', () => {
    expect(() => assertDataLakeWriteScope({ apiKeyInfo: {} })).toThrow(/datalake:write/);
    expect(() => assertDataLakeWriteScope({ apiKeyInfo: { scopes: [] } })).toThrow(/datalake:write/);
  });

  it('honors staging, so the grace period covers the per-method asserts too', () => {
    process.env[SCOPE_STAGING_ENV_VAR] = ApiKeyScope.DATALAKE_WRITE;
    expect(() => assertDataLakeWriteScope(key(ApiKeyScope.AI_CHAT))).not.toThrow();
    expect(() => assertDataLakeShareScope(key(ApiKeyScope.AI_CHAT))).toThrow();
  });
});
