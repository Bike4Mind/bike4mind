import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * fetchCounterLogs used to swallow every failure into `{ logs: [], reports: [] }`, so the
 * production 502 from an oversized response rendered as an empty "No data found" card with
 * no hint that the request had failed at all. Errors must reach react-query.
 */
const get = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get } }));

import { fetchCounterLogs } from './userAPICalls';

const DATES = { startDate: '2026-07-21', endDate: '2026-07-28' };
const params = () => get.mock.calls[0][1].params;

describe('fetchCounterLogs', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ data: { logs: [], total: 0 } });
  });

  it('propagates a request failure instead of reporting an empty result set', async () => {
    get.mockRejectedValue(new Error('Request failed with status code 502'));

    await expect(fetchCounterLogs(DATES)).rejects.toThrow('502');
  });

  it('returns the paging envelope from the server', async () => {
    get.mockResolvedValue({ data: { logs: [{ date: '2026-07-28' }], total: 4210, page: 2, limit: 25 } });

    await expect(fetchCounterLogs({ ...DATES, page: 2 })).resolves.toMatchObject({ total: 4210 });
  });

  it('asks for a single page so the response cannot exceed the Lambda cap', async () => {
    await fetchCounterLogs({ ...DATES, page: 3, limit: 50 });

    expect(params()).toMatchObject({ page: '3', limit: '50' });
  });

  it('sends the searches to the server, where the paging happens', async () => {
    await fetchCounterLogs({ ...DATES, counterName: 'Login', userEmail: 'poy@' });

    expect(params()).toMatchObject({ counterName: 'Login', userEmail: 'poy@' });
  });

  it('omits empty searches rather than filtering on an empty string', async () => {
    await fetchCounterLogs({ ...DATES, counterName: '', userEmail: '' });

    expect(params()).not.toHaveProperty('counterName');
    expect(params()).not.toHaveProperty('userEmail');
  });

  it('serialises metadata filters as JSON for the server-side matcher', async () => {
    await fetchCounterLogs({ ...DATES, metadataFilters: [{ field: 'source', operator: 'exists', value: '' }] });

    expect(JSON.parse(params().metadataFilters)).toEqual([{ field: 'source', operator: 'exists', value: '' }]);
  });
});
