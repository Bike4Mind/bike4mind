import { describe, it, expect } from 'vitest';
import { SEND_REQUEST_TIMEOUT_MS, WEBSOCKET_TICKET_TIMEOUT_MS } from './requestTimeouts';

describe('request timeouts', () => {
  // Kept in step with the 60s Lambda timeout (infra/web.ts) and CloudFront originReadTimeout
  // (infra/router.ts): a shorter client abort invites a duplicate billed quest on retry.
  it('never aborts a send before the server itself gives up', () => {
    expect(SEND_REQUEST_TIMEOUT_MS).toBe(60_000);
  });

  it('bounds the websocket ticket mint well below that', () => {
    expect(WEBSOCKET_TICKET_TIMEOUT_MS).toBe(10_000);
  });
});
