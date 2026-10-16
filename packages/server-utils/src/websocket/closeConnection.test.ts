import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  GoneException: class GoneException extends Error {},
  DeleteConnectionCommand: class DeleteConnectionCommand {
    constructor(public input: unknown) {}
  },
  ApiGatewayManagementApiClient: class ApiGatewayManagementApiClient {
    send = mockSend;
  },
}));

import { GoneException } from '@aws-sdk/client-apigatewaymanagementapi';
import { closeConnection } from './closeConnection';

describe('closeConnection', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('deletes the connection through the management API', async () => {
    mockSend.mockResolvedValue({});

    await expect(closeConnection('conn-1', 'https://ws.example.test')).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ input: { ConnectionId: 'conn-1' } }));
  });

  it('treats an already-gone connection as closed', async () => {
    mockSend.mockRejectedValue(new GoneException({ message: 'gone', $metadata: {} }));

    await expect(closeConnection('conn-1', 'https://ws.example.test')).resolves.toBeUndefined();
  });

  it('reports any other failure so the caller can retry', async () => {
    mockSend.mockRejectedValue(new Error('throttled'));

    await expect(closeConnection('conn-1', 'https://ws.example.test')).rejects.toThrow('throttled');
  });
});
