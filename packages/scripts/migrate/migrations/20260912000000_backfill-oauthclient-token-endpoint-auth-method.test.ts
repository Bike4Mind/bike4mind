import { describe, it, expect, vi, beforeEach } from 'vitest';

type Filter = Record<string, unknown>;

const mockUpdateMany = vi.fn<(filter: Filter, update: Filter) => Promise<{ modifiedCount: number }>>();

vi.mock('@bike4mind/database', () => ({
  OAuthClientModel: { updateMany: (filter: Filter, update: Filter) => mockUpdateMany(filter, update) },
}));

import migration from './20260912000000_backfill-oauthclient-token-endpoint-auth-method';

let logged: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });
});

const output = () => logged.join('\n');

describe('backfill-oauthclient-token-endpoint-auth-method', () => {
  it('classifies only clients that lack the field, setting client_secret_post', async () => {
    mockUpdateMany.mockResolvedValue({ modifiedCount: 3 });

    await migration.up();

    expect(mockUpdateMany).toHaveBeenCalledWith(
      { tokenEndpointAuthMethod: { $exists: false } },
      { $set: { tokenEndpointAuthMethod: 'client_secret_post' } }
    );
    expect(output()).toContain('classified 3 legacy client(s) as client_secret_post');
  });

  it('leaves already-classified clients alone via the $exists guard, so a re-run is a no-op', async () => {
    // The guard IS the idempotency and the safety: `{ $exists: false }` is what keeps an explicitly
    // classified client (e.g. the preview `none` public client) out of the write set.
    mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });

    await migration.up();

    const [filter] = mockUpdateMany.mock.calls[0];
    expect(filter.tokenEndpointAuthMethod).toEqual({ $exists: false });
    expect(output()).toContain('classified 0 legacy client(s)');
  });

  it('down is a no-op that writes nothing', async () => {
    await migration.down();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});
