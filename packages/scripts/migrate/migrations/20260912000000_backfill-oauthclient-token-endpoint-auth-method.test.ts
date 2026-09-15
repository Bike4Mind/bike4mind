import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Filter = Record<string, unknown>;

const mockUpdateMany = vi.fn<(filter: Filter, update: Filter) => Promise<{ modifiedCount: number }>>();
const mockCountDocuments = vi.fn<(filter: Filter) => Promise<number>>();

vi.mock('@bike4mind/database', () => ({
  OAuthClientModel: {
    updateMany: (filter: Filter, update: Filter) => mockUpdateMany(filter, update),
    countDocuments: (filter: Filter) => mockCountDocuments(filter),
  },
}));

import migration from './20260912000000_backfill-oauthclient-token-endpoint-auth-method';

const CONFIRM_ENV = 'OAUTH_BACKFILL_CONFIRMED';
let logged: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  mockCountDocuments.mockResolvedValue(3);
  mockUpdateMany.mockResolvedValue({ modifiedCount: 3 });
  delete process.env[CONFIRM_ENV];
});

afterEach(() => {
  delete process.env[CONFIRM_ENV];
});

const output = () => logged.join('\n');

describe('backfill-oauthclient-token-endpoint-auth-method', () => {
  it('without the opt-in gate, reports the count and refuses to write, leaving legacy rows untouched', async () => {
    await expect(migration.up()).rejects.toThrow(/refusing to run/);

    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(output()).toContain('3 un-classified legacy client(s) would be stamped');
  });

  it('with the gate set, classifies only clients that lack the field, setting client_secret_post', async () => {
    process.env[CONFIRM_ENV] = '1';
    mockUpdateMany.mockResolvedValue({ modifiedCount: 3 });

    await migration.up();

    expect(mockUpdateMany).toHaveBeenCalledWith(
      { tokenEndpointAuthMethod: { $exists: false } },
      { $set: { tokenEndpointAuthMethod: 'client_secret_post' } }
    );
    expect(output()).toContain('classified 3 legacy client(s) as client_secret_post');
  });

  it('with the gate set, leaves already-classified clients alone via the $exists guard (idempotent re-run)', async () => {
    // The guard IS the idempotency and the safety: `{ $exists: false }` is what keeps an explicitly
    // classified client (e.g. the preview `none` public client) out of the write set.
    process.env[CONFIRM_ENV] = '1';
    mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });

    await migration.up();

    const [filter] = mockUpdateMany.mock.calls[0];
    expect(filter.tokenEndpointAuthMethod).toEqual({ $exists: false });
    expect(output()).toContain('classified 0 legacy client(s)');
  });

  it('is a no-op with no un-classified rows, so a fresh install or CI never blocks on the gate', async () => {
    mockCountDocuments.mockResolvedValue(0);

    await migration.up();

    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(output()).toContain('nothing to backfill');
  });

  it('down is a no-op that writes nothing', async () => {
    await migration.down();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});
