import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyOrgEvent, setOrgEventObserver, type OrgEvent } from './orgEventObserver';

const event: OrgEvent = { type: 'seat_limit', organizationId: 'org-1', seats: 5 };

describe('orgEventObserver', () => {
  afterEach(() => setOrgEventObserver(null));

  it('is a no-op with no observer registered', async () => {
    await expect(notifyOrgEvent(event)).resolves.toBeUndefined();
  });

  it('awaits the registered observer with the event', async () => {
    const seen: OrgEvent[] = [];
    setOrgEventObserver(async e => {
      await Promise.resolve();
      seen.push(e);
    });

    await notifyOrgEvent(event);

    expect(seen).toEqual([event]);
  });

  it('swallows a rejecting or throwing observer', async () => {
    setOrgEventObserver(vi.fn().mockRejectedValue(new Error('boom')));
    await expect(notifyOrgEvent(event)).resolves.toBeUndefined();

    setOrgEventObserver(() => {
      throw new Error('sync boom');
    });
    await expect(notifyOrgEvent(event)).resolves.toBeUndefined();
  });
});
