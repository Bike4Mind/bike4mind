import { describe, it, expect, beforeEach } from 'vitest';
import { setupMongoTest } from '../../__test__/utils';
import { StripeDisputeModel, stripeDisputeRepository, type StripeDisputeFacts } from './StripeDisputeModel';

// Stripe fixture values only.
const facts = (overrides: Partial<StripeDisputeFacts> = {}): StripeDisputeFacts => ({
  stripeDisputeId: 'dp_test_1',
  chargeId: 'ch_test_1',
  paymentIntentId: 'pi_test_1',
  amount: 2000,
  currency: 'usd',
  reason: 'fraudulent',
  stripeStatus: 'needs_response',
  subject: 'organization',
  subjectId: 'org1',
  openedAt: new Date('2026-10-01T00:00:00Z'),
  ...overrides,
});

describe('StripeDisputeModel', () => {
  setupMongoTest();

  beforeEach(async () => {
    await StripeDisputeModel.createIndexes();
  });

  it('records a dispute once however often it is delivered', async () => {
    const first = await stripeDisputeRepository.recordOpened(facts());
    const again = await stripeDisputeRepository.recordOpened(facts({ stripeStatus: 'under_review', subjectId: 'x' }));

    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ stripeStatus: 'needs_response', subjectId: 'org1', state: 'open' });
    expect(await StripeDisputeModel.countDocuments()).toBe(1);
  });

  it('records a close for a dispute it never saw open, and updates one it did', async () => {
    const created = await stripeDisputeRepository.recordClosed(facts({ stripeStatus: 'lost' }), new Date());
    expect(created).toMatchObject({ stripeStatus: 'lost', state: 'open', subject: 'organization' });

    await stripeDisputeRepository.recordOpened(facts({ stripeDisputeId: 'dp_test_2' }));
    const closed = await stripeDisputeRepository.recordClosed(
      facts({ stripeDisputeId: 'dp_test_2', stripeStatus: 'won', subject: 'unmatched', subjectId: null }),
      new Date()
    );
    // The subject is set when the record is created and never rewritten.
    expect(closed).toMatchObject({ stripeStatus: 'won', subject: 'organization' });
    expect(closed.closedAt).toBeInstanceOf(Date);
  });

  it('flags a close it already holds as redelivered, but not a first close or a changed status', async () => {
    await stripeDisputeRepository.recordOpened(facts());
    const first = await stripeDisputeRepository.recordClosed(facts({ stripeStatus: 'lost' }), new Date());
    const again = await stripeDisputeRepository.recordClosed(facts({ stripeStatus: 'lost' }), new Date());
    const changed = await stripeDisputeRepository.recordClosed(facts({ stripeStatus: 'won' }), new Date());

    expect(first.redelivered).toBe(false);
    expect(again.redelivered).toBe(true);
    expect(changed.redelivered).toBe(false);
  });

  it('re-files an open user dispute as unmatched, and leaves other records alone', async () => {
    await stripeDisputeRepository.recordOpened(facts({ subject: 'user', subjectId: 'u1' }));
    const refiled = await stripeDisputeRepository.markUserGone('dp_test_1');
    const again = await stripeDisputeRepository.markUserGone('dp_test_1');

    expect(refiled).toMatchObject({ subject: 'unmatched', subjectId: null, state: 'open' });
    expect(again).toBeNull();
  });

  it('resolves by the system once, attaching the Contain', async () => {
    await stripeDisputeRepository.recordOpened(facts({ subject: 'user', subjectId: 'u1' }));
    const contain = {
      batchId: 'stripe-dispute:dp_test_1',
      containedAt: new Date(),
      suspended: true,
      creditDelta: -500,
      apiKeysRevoked: 1,
      snapshot: { userId: 'u1', banned: true },
    };

    const resolved = await stripeDisputeRepository.resolveBySystem('dp_test_1', 'lost', contain);
    const again = await stripeDisputeRepository.resolveBySystem('dp_test_1', 'lost', contain);

    expect(resolved).toMatchObject({
      state: 'resolved',
      resolution: { outcome: 'lost', resolvedBy: null },
      contain: { batchId: 'stripe-dispute:dp_test_1', undoneAt: null },
    });
    expect(again).toBeNull();
    const stored = await stripeDisputeRepository.findById(resolved!.id);
    expect(stored?.containSnapshot).toEqual({ userId: 'u1', banned: true });
  });

  it('lets an admin resolve an organization dispute but not a user dispute', async () => {
    const org = await stripeDisputeRepository.recordOpened(facts());
    const user = await stripeDisputeRepository.recordOpened(
      facts({ stripeDisputeId: 'dp_test_2', subject: 'user', subjectId: 'u1' })
    );

    const resolved = await stripeDisputeRepository.resolveByAdmin({ id: org.id, adminId: 'admin1', note: 'Handled' });
    const refused = await stripeDisputeRepository.resolveByAdmin({ id: user.id, adminId: 'admin1', note: 'Handled' });
    const twice = await stripeDisputeRepository.resolveByAdmin({ id: org.id, adminId: 'admin1', note: 'Handled' });

    expect(resolved).toMatchObject({
      status: 'updated',
      item: { state: 'resolved', resolution: { outcome: 'admin', resolvedBy: 'admin1', note: 'Handled' } },
    });
    expect(refused).toMatchObject({ status: 'conflict', item: { state: 'open' } });
    expect(twice.status).toBe('conflict');
    expect(
      await stripeDisputeRepository.resolveByAdmin({ id: 'f'.repeat(24), adminId: 'admin1', note: 'Handled' })
    ).toEqual({ status: 'not_found' });
  });

  it('lets an admin resolve an open unmatched dispute that Stripe never closed', async () => {
    const unmatched = await stripeDisputeRepository.recordOpened(facts({ subject: 'unmatched', subjectId: null }));

    const resolved = await stripeDisputeRepository.resolveByAdmin({
      id: unmatched.id,
      adminId: 'admin1',
      note: 'Handled',
    });

    expect(resolved).toMatchObject({
      status: 'updated',
      item: { state: 'resolved', resolution: { outcome: 'admin', resolvedBy: 'admin1', note: 'Handled' } },
    });
  });

  it('lets an admin resolve a user dispute only once Stripe has closed it', async () => {
    const user = await stripeDisputeRepository.recordOpened(facts({ subject: 'user', subjectId: 'u1' }));
    expect((await stripeDisputeRepository.resolveByAdmin({ id: user.id, adminId: 'admin1', note: 'x' })).status).toBe(
      'conflict'
    );

    await stripeDisputeRepository.recordClosed(
      facts({ subject: 'user', subjectId: 'u1', stripeStatus: 'warning_closed' }),
      new Date()
    );
    const resolved = await stripeDisputeRepository.resolveByAdmin({ id: user.id, adminId: 'admin1', note: 'x' });

    expect(resolved).toMatchObject({ status: 'updated', item: { state: 'resolved', stripeStatus: 'warning_closed' } });
  });

  it('refuses an admin resolve of a user dispute Stripe closed as won or lost until the system resolves it', async () => {
    const user = await stripeDisputeRepository.recordOpened(facts({ subject: 'user', subjectId: 'u1' }));
    await stripeDisputeRepository.recordClosed(
      facts({ subject: 'user', subjectId: 'u1', stripeStatus: 'lost' }),
      new Date()
    );

    const refused = await stripeDisputeRepository.resolveByAdmin({ id: user.id, adminId: 'admin1', note: 'x' });

    expect(refused).toMatchObject({ status: 'conflict', item: { state: 'open', stripeStatus: 'lost' } });
  });

  it('marks a Contain undone once', async () => {
    const opened = await stripeDisputeRepository.recordOpened(facts({ subject: 'user', subjectId: 'u1' }));
    expect((await stripeDisputeRepository.markContainUndone({ id: opened.id, adminId: 'admin1' })).status).toBe(
      'conflict'
    );
    await stripeDisputeRepository.resolveBySystem('dp_test_1', 'lost', {
      batchId: 'b',
      containedAt: new Date(),
      suspended: true,
      creditDelta: 0,
      apiKeysRevoked: 0,
      snapshot: { userId: 'u1', banned: true },
    });

    const undone = await stripeDisputeRepository.markContainUndone({ id: opened.id, adminId: 'admin1' });
    const twice = await stripeDisputeRepository.markContainUndone({ id: opened.id, adminId: 'admin1' });

    expect(undone).toMatchObject({ status: 'updated', item: { contain: { undoneBy: 'admin1' } } });
    expect(twice.status).toBe('conflict');
  });

  it('lists newest first with filters and truncation', async () => {
    await stripeDisputeRepository.recordOpened(facts({ stripeDisputeId: 'dp_a', openedAt: new Date('2026-10-01') }));
    await stripeDisputeRepository.recordOpened(
      facts({ stripeDisputeId: 'dp_b', subject: 'unmatched', subjectId: null, openedAt: new Date('2026-10-02') })
    );
    await stripeDisputeRepository.recordOpened(facts({ stripeDisputeId: 'dp_c', openedAt: new Date('2026-10-03') }));

    const page = await stripeDisputeRepository.list({ limit: 2 });
    expect(page.data.map(item => item.stripeDisputeId)).toEqual(['dp_c', 'dp_b']);
    expect(page.truncated).toBe(true);

    const unmatched = await stripeDisputeRepository.list({ subject: 'unmatched', state: 'open', limit: 10 });
    expect(unmatched.data.map(item => item.stripeDisputeId)).toEqual(['dp_b']);
  });
});
