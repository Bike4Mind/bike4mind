import { describe, expect, it } from 'vitest';
import { CLIENT_CONFIG_SERVER_STATUSES } from './clientConfig';
import { ServerStatusEnum } from './settings';

describe('ClientConfigServerSchema', () => {
  it('publishes exactly the ServerStatusEnum values', () => {
    expect([...CLIENT_CONFIG_SERVER_STATUSES].sort()).toEqual(Object.values(ServerStatusEnum).sort());
  });
});
