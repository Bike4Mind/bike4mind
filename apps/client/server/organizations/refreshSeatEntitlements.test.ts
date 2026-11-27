import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendToClient = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

import { refreshSeatEntitlements } from './refreshSeatEntitlements';

describe('refreshSeatEntitlements', () => {
  beforeEach(() => {
    sendToClient.mockReset();
    sendToClient.mockResolvedValue(undefined);
  });

  it('invalidates the entitlement and model catalog queries for the user only', async () => {
    await refreshSeatEntitlements('user-1');

    expect(sendToClient).toHaveBeenCalledTimes(2);
    expect(sendToClient).toHaveBeenCalledWith('user-1', 'ws-endpoint', {
      action: 'invalidate_query',
      queryKey: ['entitlements'],
    });
    expect(sendToClient).toHaveBeenCalledWith('user-1', 'ws-endpoint', {
      action: 'invalidate_query',
      queryKey: ['llm', 'models'],
    });
  });

  it('does not throw when a push fails, and still sends the other', async () => {
    sendToClient.mockRejectedValueOnce(new Error('socket gone'));

    await expect(refreshSeatEntitlements('user-1')).resolves.toBeUndefined();
    expect(sendToClient).toHaveBeenCalledTimes(2);
  });
});
