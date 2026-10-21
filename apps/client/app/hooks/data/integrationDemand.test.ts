import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError, type AxiosResponse } from 'axios';
import type { IntegrationRequester, IntegrationRequestersResponse } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import {
  REQUESTER_EMAILS_MAX_PAGES,
  REQUESTER_EMAILS_MAX_ROWS,
  fetchAllRequesterEmails,
  isRateLimited,
} from './integrationDemand';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));

const get = vi.mocked(api.get);

const requester = (email: string | null, deleted = false): IntegrationRequester => ({
  userId: `user-${email}`,
  deleted,
  name: null,
  email,
  organizationId: null,
  organizationName: null,
  requestedAt: '2026-03-01T00:00:00.000Z',
});

const page = (
  emails: Array<string | null>,
  next: string | null,
  deletedEmails: string[] = []
): { data: IntegrationRequestersResponse } => ({
  data: {
    data: [...emails.map(email => requester(email)), ...deletedEmails.map(email => requester(email, true))],
    next_cursor: next,
  },
});

const status = (code: number) =>
  new AxiosError('failed', 'ERR_BAD_REQUEST', undefined, undefined, { status: code } as AxiosResponse);

describe('fetchAllRequesterEmails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('walks every page at the route ceiling, passing each cursor on, and de-duplicates the emails', async () => {
    get
      .mockResolvedValueOnce(page(['a@x.test', null], 'c1'))
      .mockResolvedValueOnce(page(['b@x.test', 'a@x.test'], 'c2'))
      .mockResolvedValueOnce(page(['c@x.test'], null));

    expect(await fetchAllRequesterEmails('hubspot')).toEqual({
      emails: ['a@x.test', 'b@x.test', 'c@x.test'],
      truncated: false,
    });
    expect(get.mock.calls.map(([path, config]) => [path, config?.params])).toEqual([
      ['/api/admin/integrations/demand/hubspot/requesters', { limit: 100, cursor: undefined }],
      ['/api/admin/integrations/demand/hubspot/requesters', { limit: 100, cursor: 'c1' }],
      ['/api/admin/integrations/demand/hubspot/requesters', { limit: 100, cursor: 'c2' }],
    ]);
  });

  it('leaves out a deleted account even if its email somehow arrives', async () => {
    get.mockResolvedValueOnce(page(['a@x.test'], null, ['gone@x.test']));

    expect((await fetchAllRequesterEmails('hubspot')).emails).toEqual(['a@x.test']);
  });

  it('stops at the page cap and says the list is longer', async () => {
    let n = 0;
    get.mockImplementation(async () => page([`user${n}@x.test`], `cursor-${++n}`));

    const result = await fetchAllRequesterEmails('hubspot');

    expect(get).toHaveBeenCalledTimes(REQUESTER_EMAILS_MAX_PAGES);
    expect(result.truncated).toBe(true);
    expect(result.emails).toHaveLength(REQUESTER_EMAILS_MAX_PAGES);
    expect(REQUESTER_EMAILS_MAX_ROWS).toBe(5000);
  });

  it('is not truncated when the last page the cap allows is the last page there is', async () => {
    let n = 0;
    get.mockImplementation(async () => {
      n += 1;
      return page([`user${n}@x.test`], n === REQUESTER_EMAILS_MAX_PAGES ? null : `cursor-${n}`);
    });

    const result = await fetchAllRequesterEmails('hubspot');

    expect(get).toHaveBeenCalledTimes(REQUESTER_EMAILS_MAX_PAGES);
    expect(result.truncated).toBe(false);
  });

  it('lets a 429 through for the caller to word, and stops walking', async () => {
    get.mockResolvedValueOnce(page(['a@x.test'], 'c1')).mockRejectedValueOnce(status(429));

    const failure = await fetchAllRequesterEmails('hubspot').catch((error: unknown) => error);

    expect(isRateLimited(failure)).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('isRateLimited', () => {
  it('is true only for a 429 response', () => {
    expect(isRateLimited(status(429))).toBe(true);
    expect(isRateLimited(status(500))).toBe(false);
    expect(isRateLimited(new Error('429'))).toBe(false);
    expect(isRateLimited(undefined)).toBe(false);
  });
});
