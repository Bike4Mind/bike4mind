import { beforeEach, expect, it } from 'vitest';
import { useCliStore } from '../store/index.js';
import { holdIdleSession } from './holdIdleSession.js';

beforeEach(() =>
  useCliStore.setState({ turnInFlight: false, peerTurnActive: false, isThinking: false, sessionHolds: 0 })
);

it('claims an idle session atomically and rejects an overlapping claim', () => {
  const release = holdIdleSession();
  expect(release?.assertHeld).toBeTypeOf('function');
  expect(useCliStore.getState().sessionHolds).toBe(1);
  expect(holdIdleSession()).toBeUndefined();
  release?.release();
  expect(useCliStore.getState().sessionHolds).toBe(0);
});

it.each([{ isThinking: true }, { sessionHolds: 1 }, { turnInFlight: true }])(
  'refuses an already busy session: %j',
  busy => {
    useCliStore.setState(busy);
    expect(holdIdleSession()).toBeUndefined();
  }
);

it('refuses a peer-owned turn without changing its origin or holds', () => {
  useCliStore.getState().setTurnInFlight(true);
  useCliStore.getState().setPeerTurnActive(true);
  expect(holdIdleSession()).toBeUndefined();
  expect(useCliStore.getState().peerTurnActive).toBe(true);
  expect(useCliStore.getState().sessionHolds).toBe(0);
});

it('passes one owned claim through nested work and rejects using it after release', async () => {
  const claim = holdIdleSession();
  if (!claim) throw new Error('Expected an idle claim');
  const nested = async () => {
    claim.assertHeld();
    await Promise.resolve();
    claim.assertHeld();
  };
  await nested();
  expect(useCliStore.getState().sessionHolds).toBe(1);
  claim.release();
  claim.release();
  expect(useCliStore.getState().sessionHolds).toBe(0);
  expect(() => claim.assertHeld()).toThrow('no longer owns');
});
