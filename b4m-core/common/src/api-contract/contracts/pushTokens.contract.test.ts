import { describe, expect, it } from 'vitest';
import { registerPushTokenContract, unregisterPushTokenContract } from './pushTokens.contract';
import { PushTokenRegisterRequestSchema } from '../../schemas/pushToken';

describe('push token contracts', () => {
  it('pins operation ids, paths and verbs', () => {
    expect(
      [registerPushTokenContract, unregisterPushTokenContract].map(c => [c.operationId, c.method, c.path, c.auth])
    ).toEqual([
      ['registerPushToken', 'post', '/api/v1/push-tokens', 'jwtOnly'],
      ['unregisterPushToken', 'delete', '/api/v1/push-tokens', 'jwtOnly'],
    ]);
  });

  it('takes no sid in the request: the session comes from the authenticated caller', () => {
    expect('sid' in PushTokenRegisterRequestSchema.shape).toBe(false);
  });

  it('rejects an unknown kind, platform or environment', () => {
    const ok = { token: 't', kind: 'device', platform: 'ios', environment: 'sandbox' };
    expect(PushTokenRegisterRequestSchema.safeParse(ok).success).toBe(true);
    for (const bad of [{ kind: 'x' }, { platform: 'android' }, { environment: 'staging' }]) {
      expect(PushTokenRegisterRequestSchema.safeParse({ ...ok, ...bad }).success).toBe(false);
    }
  });
});
