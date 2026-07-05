import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import handler from '@pages/api/ping';

const mockGet = vi.fn<(handler: (req: any, res: any) => any) => any>(handlerFn => handlerFn);
const mockBaseApi = vi.fn(() => ({ get: mockGet }));

vi.doMock('@server/middlewares/baseApi', () => ({
  baseApi: mockBaseApi,
}));

// TODO: Fix test
describe.skip('/api/ping', () => {
  it('should return pong with 200 status', async () => {
    const { req, res } = createMocks({
      method: 'GET',
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getData())).toEqual({
      message: 'pong',
    });
  });

  it('should not require authentication', () => {
    expect(mockBaseApi).toHaveBeenCalledWith({ auth: false });
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});
