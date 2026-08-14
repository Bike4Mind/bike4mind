import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IGetUsersParams } from '@client/app/utils/userAPICalls';

const get = vi.hoisted(() => vi.fn());
const downloadData = vi.hoisted(() => vi.fn());

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get } }));
vi.mock('@client/app/utils/download', () => ({ downloadData }));

import { exportUsersCsv } from './exportUsersCsv';

const PARAMS: IGetUsersParams = { page: 1, limit: 10 };

const makeUser = (overrides: Record<string, unknown> = {}) => ({
  name: 'Ada',
  username: 'ada',
  email: 'ada@example.com',
  organizationId: { name: 'Acme' },
  loginRecords: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  isAdmin: false,
  isBanned: false,
  ...overrides,
});

const respondWith = (...users: Record<string, unknown>[]) =>
  get.mockResolvedValue({ data: { users, currentPage: 1, totalPages: 1, totalUsers: users.length } });

/** The CSV handed to the download helper, split into lines. */
const writtenLines = () => (downloadData.mock.calls[0][0] as string).split('\n');
const dataRow = () => writtenLines()[1];

beforeEach(() => {
  get.mockReset();
  downloadData.mockReset();
});

describe('exportUsersCsv', () => {
  it('asks for every user rather than the current page', async () => {
    respondWith(makeUser());

    await exportUsersCsv({ page: 3, limit: 10, search: 'ada' });

    expect(get.mock.calls[0][1].params).toMatchObject({ downloadAll: true, page: 1, search: 'ada' });
  });

  it('reads the organization from the populated organizationId ref', async () => {
    respondWith(makeUser({ organizationId: { name: 'Acme' } }));

    await exportUsersCsv(PARAMS);

    expect(dataRow()).toContain('"Acme"');
  });

  it('leaves the organization cell blank when the ref is not populated', async () => {
    respondWith(makeUser({ organizationId: undefined }));

    await exportUsersCsv(PARAMS);

    expect(dataRow()).toBe('"Ada","","ada","ada@example.com","0","N/A","2026-01-01T00:00:00.000Z","No","No"');
  });

  it('keeps a name containing a comma in a single field', async () => {
    respondWith(makeUser({ name: 'Lovelace, Ada' }));

    await exportUsersCsv(PARAMS);

    expect(dataRow()).toContain('"Lovelace, Ada"');
    expect(dataRow().split(',')).toHaveLength(10); // 9 fields, one split inside the quoted name
  });

  it('defuses a name that a spreadsheet would run as a formula', async () => {
    respondWith(makeUser({ name: '=HYPERLINK("http://evil/")' }));

    await exportUsersCsv(PARAMS);

    expect(dataRow().startsWith(`"'=HYPERLINK`)).toBe(true);
  });

  it('reports the newest login rather than the first array element', async () => {
    respondWith(
      makeUser({
        loginRecords: [
          { loginTime: '2026-02-01T00:00:00.000Z' },
          { loginTime: '2026-06-01T00:00:00.000Z' },
          { loginTime: '2026-03-01T00:00:00.000Z' },
        ],
      })
    );

    await exportUsersCsv(PARAMS);

    expect(dataRow()).toContain('"2026-06-01T00:00:00.000Z"');
    expect(dataRow()).toContain('"3"'); // login count
  });

  it('writes a header row', async () => {
    respondWith(makeUser());

    await exportUsersCsv(PARAMS);

    expect(writtenLines()[0]).toBe(
      '"Name","Organization","Username","Email","Logins","Last Login","Created At","Is Admin","Is Banned"'
    );
    expect(downloadData).toHaveBeenCalledWith(expect.any(String), 'users.csv', 'text/csv;charset=utf-8;');
  });

  it('propagates a failed request and writes no file', async () => {
    // fetchUsers would swallow this into an empty list, downloading a header-only CSV that reads
    // as a successful export of zero users.
    get.mockRejectedValue(new Error('Request failed with status code 403'));

    await expect(exportUsersCsv(PARAMS)).rejects.toThrow('403');
    expect(downloadData).not.toHaveBeenCalled();
  });
});
