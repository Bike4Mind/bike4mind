import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
const downloadData = vi.hoisted(() => vi.fn());

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get } }));
vi.mock('@client/app/utils/download', () => ({ downloadData }));

import { exportUsersCsv } from './exportUsersCsv';

const makeUser = (overrides: Record<string, unknown> = {}) => ({
  name: 'Ada',
  username: 'ada',
  email: 'ada@example.com',
  organizationName: 'Acme',
  loginCount: 0,
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  isAdmin: false,
  isBanned: false,
  ...overrides,
});

const respondWith = (users: Record<string, unknown>[], truncated = false) =>
  get.mockResolvedValue({ data: { users, truncated } });

const writtenLines = () => (downloadData.mock.calls[0][0] as string).split('\n');
const dataRow = () => writtenLines()[1];

beforeEach(() => {
  get.mockReset();
  downloadData.mockReset();
});

describe('exportUsersCsv', () => {
  it('exports what the list filter matches, not the current page', async () => {
    respondWith([makeUser()]);
    await exportUsersCsv({ search: 'ada', status: 'suspended' });
    expect(get).toHaveBeenCalledWith('/api/admin/users/export', { params: { search: 'ada', status: 'suspended' } });
  });

  it('writes a header row and one row per user', async () => {
    respondWith([makeUser({ loginCount: 3, lastLoginAt: '2026-06-01T00:00:00.000Z' })]);
    await exportUsersCsv({});
    expect(writtenLines()[0]).toBe(
      '"Name","Organization","Username","Email","Logins","Last Login","Created At","Is Admin","Is Banned"'
    );
    expect(dataRow()).toBe(
      '"Ada","Acme","ada","ada@example.com","3","2026-06-01T00:00:00.000Z","2026-01-01T00:00:00.000Z","No","No"'
    );
    expect(downloadData).toHaveBeenCalledWith(expect.any(String), 'users.csv', 'text/csv;charset=utf-8;');
  });

  it('leaves the organization blank when there is none', async () => {
    respondWith([makeUser({ organizationName: null })]);
    await exportUsersCsv({});
    expect(dataRow()).toBe('"Ada","","ada","ada@example.com","0","N/A","2026-01-01T00:00:00.000Z","No","No"');
  });

  it('defuses a name that a spreadsheet would run as a formula', async () => {
    respondWith([makeUser({ name: '=HYPERLINK("http://evil/")' })]);
    await exportUsersCsv({});
    expect(dataRow().startsWith(`"'=HYPERLINK`)).toBe(true);
  });

  it('reports a file cut at the server ceiling', async () => {
    respondWith([makeUser()], true);
    await expect(exportUsersCsv({})).resolves.toEqual({ truncated: true });
  });

  it('propagates a failed request and writes no file', async () => {
    get.mockRejectedValue(new Error('Request failed with status code 403'));
    await expect(exportUsersCsv({})).rejects.toThrow('403');
    expect(downloadData).not.toHaveBeenCalled();
  });
});
